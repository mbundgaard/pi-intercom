# PiIntercom V1 Specification

This is the consolidated **target design**, authoritative over conflicting wording in the original proposal and historical discussion notes. It is not a claim that every capability is currently supported. See [README](../README.md) for current behavior, release evidence and validation limits.

**Current capability exception:** `intercom_stop_worker` and `intercom_close_worker` are registered but disabled on every host, before cancellation/shutdown or outgoing control. Their intended guarantees below remain unchanged; see the [cancellation blocker](implementation-blocker.md). Manual-compaction delivery also has a known acceptance gap: HTTP receipt does not guarantee Pi accepted the input. Unresolved contract questions are not silently approved decisions.

## 1. Scope and principles

- One Pi extension codebase runs in coordinator and worker sessions.
- Pi session ID is the underlying identity; do not introduce instance IDs.
- Names provide human-friendly addressing. Lookup and uniqueness are case-insensitive; preserve capitalization for display.
- Intercom is a communication extension, not an orchestration engine. The coordinator Pi agent decides assignments, sequencing, and recovery. The extension provides communication and explicit tool operations; it does not choose the workflow.
- Coordinator manages configuration and delegates work. Workers may communicate directly with peers.
- Tools perform explicit documented operations. Failure reports do not trigger hidden recovery, replacement, removal, or launcher fallback.
- Windows only for V1. Launchers: Herdr (default) and `none` (separate visible terminals).
- No bulk tools in V1. Use existing tools for individual workers.

## 2. Shared configuration

Location: `<coordinator-root>/.pi-intercom/config.json`.

- Root-isolation revision (0.8.0): select only the config in the session working directory. Never search ancestors or infer a Git/home root. `--intercom-root` is a same-directory assertion: its canonical path must equal cwd before its config is read. It cannot authorize reading a parent config.
- Without an explicit workspace root, when the exact local config is genuinely absent, become coordinator and create it under the current working directory. Explicit workspace mode requires an existing valid config and never creates a replacement coordinator. Do not infer a Git or solution root.
- Initial creation is atomic: only one session targeting the same path becomes coordinator. Other contenders wait for usable config and register as workers.
- Invalid or unreadable config is an error, not absence. Leave it untouched.
- The configuration is checked into source control. It includes session IDs and ports; do not split these into a separate runtime configuration.
- Only coordinator extension code may write it. Workers read only. No attempt to restrict ordinary Pi shell/file tools.
- Saved worker directories remain root-relative. Shared-roster worker create/resume requires the coordinator root itself; descendant launches are rejected before side effects. Old descendant entries/history are retained, not silently relocated.
- Entries survive process closure. Saved Pi session paths are not stored; resume uses session ID and project directory.

Required configuration information:

| Scope | Fields |
|---|---|
| Solution | Multiplexer (`herdr` or `none`) |
| Agent | Pi session ID, name, coordinator flag, responsibility description, port |
| Worker | Project directory relative to coordinator root |

The implemented schema is version 1; its fields and validation are documented in [README: Config and wire contracts](../README.md#config-and-wire-contracts). Do not treat a saved endpoint or session ID as proof that its process exists.

## 3. Startup and registration

### Coordinator

1. Resolve current session ID and configuration.
2. With no config, atomically initialize coordinator configuration.
3. Use name `Coordinator` and default responsibility: `Coordinate workers, delegate work, and manage shared configuration.`
4. Bind configured port; if unavailable or absent, bind port 0 and use the OS-selected port.
5. Record its actual port directly in config.
6. Fix Pi session name and, when hosted in Herdr, tab name to `Coordinator`.
7. Publish readiness without triggering an agent turn. Wait for user input.

A known session restores its configured role. Any unknown session ID with existing configuration follows worker registration, including forks. No implicit coordinator takeover.

### Anonymous worker

1. Coordinator launches a new Pi session in its project directory with this extension loaded.
2. Worker verifies its explicit root equals its working directory, validates only that directory's config, then starts a localhost endpoint using an OS-selected port.
3. Worker reports session ID, port, and project directory to the configured coordinator.
4. Coordinator extension notifies its agent using normal prompt delivery if idle, steering if busy.
5. Worker remains anonymous and waits. Registration does not create a placeholder config entry or authorize work.
6. Coordinator agent calls `intercom_configure_worker` to create a named entry with responsibility and reported connection details.
7. Coordinator agent separately calls `intercom_reload_worker`.
8. Worker reads its responsibility, synchronizes Pi session and Herdr tab names, and waits for a work prompt.

No worker-specific config path, callback address, instance ID, or preassigned responsibility is passed at launch. No sequential-launch restriction is required for normal creation.

### Existing worker startup/resume

- Read its entry by Pi session ID and restore responsibility.
- Try configured port; use OS allocation if unavailable.
- Report actual endpoint to coordinator. Existing-entry port updates are automatic bookkeeping.
- Fix Pi session and applicable Herdr tab names to configured name.
- Wait for new instructions, even if previous work was unfinished.
- Coordinator connection failure is reported but does not prevent the worker's own endpoint from opening.

## 4. Responsibilities and work

- Responsibility describes an agent's remit, not its current task.
- Loading or reloading responsibility does not start a turn or authorize implementation.
- Work is assigned by explicit agent messages.
- Findings may be used within an existing assignment, but do not independently authorize unrelated implementation.
- After work, report as instructed and wait.
- Workers continue assigned work and peer communication while coordinator is unreachable.
- Workers do not autonomously exit upon completion or coordinator shutdown.

## 5. Transport and delivery

- Localhost HTTP, one receiving message endpoint per extension.
- Bind loopback only. No authentication in V1; local processes are trusted.
- All application-level messages are asynchronous and one-way. A message may lead to zero, one, or many later messages.
- HTTP acknowledgment confirms receipt/acceptance or reports transport/validation failure, not agent completion.
- Reports/results travel as independent messages, never as synchronous agent replies in HTTP responses.
- Every send rereads config to resolve the current destination endpoint.
- Agent-facing recipient arguments use names. Transport includes the expected destination session ID, verified by the receiver.
- Include sender identity and label agent messages with sender and purpose.
- Incoming coordinator-only controls check sender session ID against current config. This is role validation, not authentication.
- Receipt timeout is 5 seconds. No automatic retries. A failure or timeout is reported; the agent decides recovery.
- Dedicated durable message logging is deferred. A subsequently approved, separate scope adds best-effort metadata telemetry and a coordinator-only read-only dashboard; see [observability](observability.md). This is not a durable inbox, task journal, replay mechanism, completion guarantee or orchestration layer.

### Agent delivery

- Idle recipient: start normal agent turn.
- Busy recipient: use Pi steering at supported boundaries, not a hard interrupt of executing tools.
- Determine delivery behavior at arrival; busy is only a snapshot.
- Progress questions do not cancel existing assignments. Report and continue unless explicitly redirected.
- Findings use the same delivery path, not a separate context-only inbox.

### Control delivery

- Registration, status reporting, config reload, stop, and close run extension code.
- Worker's status report contains session ID, bound port, and busy flag; generation needs no worker model turn.
- One shared worker reporting function is invoked by either its report tool or a coordinator request. Reject use on a coordinator host.
- Coordinator receiving status updates an existing entry's changed port, then notifies its agent (normal/steering).
- Unknown/removed session status notifies but does not create config entries. Registration is separate.
- Routine monitoring should use extension status. Detailed progress uses an agent prompt; checking status first is optional.

## 6. Tools

Every invocation reads the current Pi session ID and shared config, determines role, and checks permission. Unknown sessions never receive coordinator-only privileges.

| Tool | Role | Inputs | Operation |
|---|---|---|---|
| `intercom_create_worker` | Coordinator | `projectDirectory?` (default `.`) | Launch new anonymous worker with extension loaded; report launch success/failure without awaiting registration |
| `intercom_configure_worker` | Coordinator | `sessionId`, `port`, `projectDirectory`, `name`, `description` | Write the explicitly supplied worker configuration; no notification |
| `intercom_reload_worker` | Coordinator | `to` (name) | Send config-read control only |
| `intercom_send` | Configured, responsibility-loaded sessions | `to` (name), `message` | Deliver agent prompt/steering; return send result, not agent reply |
| `intercom_list` | Configured sessions | None | Reread config; list names, responsibilities, IDs, roles, ports, without live probing |
| `intercom_request_status` | Coordinator | `to` (name) | Ask worker extension to send independent runtime status report |
| `intercom_report_status` | Worker, including anonymous | None | Invoke shared reporting function; reject on coordinator |
| `intercom_stop_worker` | Coordinator | `to` (name) | Target: cancel current work; leave Pi and extension running. Currently disabled; unsupported-host error |
| `intercom_close_worker` | Coordinator | `to` (name) | Target: cancel work, gracefully exit Pi, preserve session/config. Currently disabled; unsupported-host error |
| `intercom_resume_worker` | Coordinator | `to` (name) | Launch saved session using configured directory and launcher; failures leave config unchanged |
| `intercom_remove_worker` | Coordinator | `to` (name) | Remove config entry only; no process stop or session-file deletion |
| `intercom_set_multiplexer` | Coordinator | `multiplexer` | Set `herdr` or `none` for future launches, including resume |

### Tool details

- Configure rejects duplicate names, including `Coordinator`, case-insensitively. Keeping a session's own name is allowed.
- Configure and reload are deliberately separate. Reload is not Pi's extension-code reload, a process restart, cancellation, or a work assignment. Explain this in tool and user documentation.
- Reload synchronizes Pi session and applicable Herdr tab names to config.
- Target contract: stop/close use Pi cancellation and graceful shutdown; no force-kill, automatic commit, or rollback. Close does not require a separate stop call. **Currently both fail closed; no stop or shutdown is performed.**
- Close success at transport level is not proof that process exit has completed.
- Remove a running worker only after explicitly closing it; removal itself never closes it.
- Resume failure must be surfaced; no implicit removal, replacement, or reassignment.
- Pi may not persist a never-used session until its first assistant response. This is an implementation caveat covered by the existing resume-failure rule, not a change to registration or a separate design decision. Do not force a model turn or fabricate history to persist it.
- Existing workers are not moved or restarted when launcher configuration changes.

## 7. Launchers

- Default Herdr: one new tab per worker, no splits.
- `none`: separate visible terminal per worker, not background-only execution.
- Missing configured multiplexer means a clear launch failure, not fallback.
- Keep communication independent of launcher choice.
- Keep launcher interface extensible for future multiplexers/platforms.
- Session names and tabs track configured agent names; coordinator uses `Coordinator`.

## 8. Explicitly deferred

- Other operating systems and multiplexers.
- Durable message/task journals and replay remain deferred. The newly approved [metadata-only observation feature](observability.md) has bounded best-effort storage/retention, not durable-delivery guarantees.
- Duplicate Pi-session activation detection or session-ID locks.
- Automatic retry queues and recovery orchestration are not V1 behavior.
- Bulk tools: use individual operations instead.

## 9. Remaining implementation gaps — not new approved behavior

Original design-gap inventory with current implementation annotations. Avoid reopening settled user flows. Implemented mechanisms are not proof of comprehensive live-host validation.

1. **Registration handoff — resolved:** deliver reported session ID, port, and project directory into the coordinator Pi context. The coordinator agent decides what to do and supplies all values explicitly to configure_worker. No hidden pending-registration map, placeholder entry, or automatic configuration/reload workflow.
2. **Retrying anonymous registration:** status reports do not create registrations. Define an explicit way to repeat a failed initial registration without conflating it with known-worker status.
3. **Wire/config schemas — implemented:** schema version 1, documented fields/control kinds, validation, 64 KiB body bound and extension-receipt acknowledgment are described in README. No message IDs, deduplication or synchronous agent replies. Receipt is not proof of Pi input acceptance or model completion.
4. **Pi lifecycle APIs:** verify extension loading, session-ID resume lookup, cancellation, queued-message treatment on stop/close, busy detection, and session-switch cleanup. Stop must not unexpectedly restart queued work; exact API feasibility needs checking.
5. **Launch integration:** verify installed Herdr operations and a Windows visible-terminal implementation, including readiness/launch-failure observability and tab association. A successful process launch is not worker registration success.
6. **Configuration writes — implemented, validation limits remain:** serialized atomic updates and complete-file no-replace initial publication; invalid config is not overwritten. See README for filesystem assumptions and unverified cross-process/network-drive cases.
7. **Missing coordinator session:** workers report connection failure and remain reachable. Explicit coordinator takeover is not specified or approved; do not invent it.
8. **Unconfigured worker permissions:** explicitly define allowed worker-side tools before its entry exists, while retaining registration/reporting ability and forbidding coordinator operations.
9. **Protocol control checks:** distinguish initial registration from configured-sender validation. Reload must reach the anonymous worker after the coordinator has created its entry.

## 10. Implementation documentation and verification

- Read installed Pi documentation and relevant Herdr skills before implementation.
- Document tool permissions, startup/registration flow, passive responsibility loading, separate configure/reload calls, and failure semantics.
- Test role gates, port fallback, recipient mismatch, duplicate names, config errors, explicit recovery, and asynchronous steering/status paths.
- The original design discussion produced no implementation code. A supported-core implementation and releases now exist; current evidence and limitations are maintained in README.
