# Herdr core/app compatibility and validation

## Target topology and tested contracts

- Core: current `hc` / `herdr-core`, running on Linux or Windows. Product release numbers are not pinned or range-gated. The baseline schema examined was 0.1.18; compatibility is checked through protocol negotiation, required methods and actual response shapes.
- UI: Windows `herdr-app`, local or connected to a remote core.
- Examined app source: public tag **v0.1.13**, commit `93b097f6e29fcb2d90a30dea2f03ce4e5dee7981`.
- `HC_TERMINAL_ID` identifies a core terminal, not an app pane or tab. `herdr.space` and `herdr.tab` labels are placement IDs, not names.

## Shared document adapter

The app's `src/mirror_sync.rs` reads/writes its machine-owned `herdr-app` document through core `doc.get`/`doc.set`, using an expected version. `src/mirror.rs` separates shared spaces/tabs/layout from screen-private focus. `src/window.rs` applies document updates and qualifies remote IDs.

Intercom uses this route to change the **actual tab name**, not merely a session title or label. Naming changes only the uniquely mapped worker tab. Launch preflight, terminal creation and dedicated-tab attachment share one bounded verified connection. Conflicts, disconnects and uncertain mutations are not replayed. The coordinator's tab name is preserved.

This is a **source-backed private-format adapter**, not an upstream promise of a stable versioned UI API. Core documents are opaque JSON; core's version does not establish the connected app's version. Intercom accepts compatible later product releases and prerelease labels without a release allowlist. Protocol generation/framing, permanent identity and supported document operations are still validated because they determine whether an operation can be performed correctly. Rows/columns and terminal/mod blocks are supported; the naming helper also accepts mod-only floats. Monitor layout intentionally requires a narrower float-free subset. Stacks, terminal floats, dynamic content and ambiguous identities fail closed.

Unix uses an explicit `HC_SOCKET`, or the documented default endpoint only if no core config file could override it. This connects without spawning a core. An existing config requires explicit `HC_SOCKET`; its contents are not scraped for credentials. Windows can use an explicit endpoint, otherwise existing-core status is checked before `hc connect`; that preflight is not atomic protection against the core disappearing before connect.

## Monitor and worker closure

Monitor ownership is persisted separately from project configuration, with core/session/caller identities, a token, original argv and terminal creation timestamp. Open supports a top-quarter panel or separate tab without changing private focus state. Old legacy records cannot grant new-core ownership. Completed records matching the session are archived under the existing lock after new-core preflight succeeds, rather than blocking every startup. No old terminal is stopped or adopted. Submitted core records are similarly retired only after a successful complete inventory proves the terminal missing or finished and its layout reference is gone. Failed queries and uncertain launch/close intents never count as absence evidence.

Monitor close:
1. Validate the owned terminal, pane, caller and complete descendant inventory.
2. Refuse any observed live descendant, including one behind a finished intermediate parent.
3. Persist `close_pending`, then recheck identity/layout and inventory.
4. Submit one terminal stop and verify finished state.
5. CAS-remove only the owned pane, preserving siblings and the coordinator layout.
6. Verify absence and persist `closed`. Only confirmed closure permits a new open.

This is best-effort, not an atomic compare-and-stop primitive. Core completion may terminate `die_with_parent` children; clients must not concurrently register children against an owned monitor/closing worker. No all-descendants or atomic quiescence guarantee is made. Any uncertainty retains the fence; no automatic retry, cleanup or replacement is permitted.

Linux worker closure additionally checks canonical session headers and process start ticks, and retains the existing successful handoff-result persistence, final settlement and same-epoch commit protocol. Windows worker closure remains disabled because equivalent process-identity proof is not implemented. No graceful cancellation support was enabled.

## Validation boundaries

Local validation covers transport framing/errors, core identity/version checks, CAS conflicts, no-replay behavior, missing/ambiguous layout refusal, quoting/root isolation, ownership, descendant refusal, handoff commit ordering, process-exit observation, monitor close/reopen and sibling preservation. Tests use mocked API connections and disposable files; no real workers are needed.

Adapter fixtures strip inherited `HC_*` and `HERDR_*` variables. A prior development test inherited the coordinator terminal and changed its tab to a fixture name; this was an isolation bug. The owner restored the title to **Main**. The test isolation fix prevents those mocked sessions from accessing the live connection again.

A read-only check verified that the real core's document maps this coordinator to its actual Windows-app tab. That does not establish complete native Windows execution or rendered UI behavior. End-to-end worker startup/reload and Windows rendering still require an authorized live acceptance test. No workers are to be created merely to satisfy this checklist without owner authorization.

No package release, installation or session reload is implied by a successful build.
