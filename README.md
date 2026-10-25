# Pi Intercom

**A coordinator-led workspace for Pi.**

Delegate into separate worker contexts, evaluate their reports, and keep the main conversation focused—with the team visible alongside it.

Pi Intercom lets your main Pi session orchestrate work across a team of worker sessions. You describe the goal; the coordinator breaks it into focused assignments and delegates them to workers, each with its own conversation and model context. Workers report back, and the coordinator evaluates their results, decides what to do next, and brings the outcome back to you.

A core objective is to **keep the coordinator's context clean and concise, and the main conversation responsive**. Delegate implementation details, lengthy investigations, and tool-heavy work to worker contexts; bring back focused findings for the coordinator to evaluate. That helps the main session stay available for your questions and decisions instead of getting bogged down in implementation. It is a workflow goal, not a guarantee of latency or context size—the quality of delegation and reports still matters.

The value is the loop: **delegate → report back → evaluate → decide the next step**. The coordinator can ask for clarification, request a review, assign follow-up work, or summarize the result—within the scope of your request. You stay in one conversation while the detailed work happens in separate worker contexts.

## At a glance

- **Keep the main conversation focused.** Workers handle implementation detail in their own contexts and return concise reports, helping the coordinator stay responsive and focused on decisions.
- **Your main session leads.** The coordinator keeps track of your request, delegates focused work, and evaluates what comes back before deciding the next step.
- **Each worker has its own context.** Implementation, investigation, and review can happen in separate Pi conversations. The coordinator supplies the brief; workers return findings rather than automatically merging their full conversation histories.
- **Delegation is a conversation.** Ask for progress, clarify a finding, or send a follow-up assignment. Configured workers can also communicate directly when useful.
- **Visible terminals.** With [Herdr](https://herdr.dev), workers open in their own tabs without taking your focus. Windows also supports separate terminal windows.
- **A status pane above your conversation.** A lightweight terminal monitor shows each worker's last-observed status and activity. It is a display process, not another agent or model call.
- **Explicit control.** Intercom supplies the communication tools; Pi decides how to use them in response to your instructions. Creating a worker does not silently assign it work.

**Intercom communicates; Pi orchestrates.** It is a local coordination layer, not an autonomous scheduler or a task-completion guarantee.

> **0.4.1:** The terminal monitor replaces the browser dashboard. Public worker reports and the read-only JSON worker-status tool keep coordinator decisions separate from observed activity.
>
> **0.5.1:** manually closed workers remain registered and sort last as disconnected in the monitor. Optional JSON health checks and guarded resume preserve the distinction between connectivity and saved session identity.
>
> **0.8.0:** Config is restricted to the session working directory. No parent search or explicit-parent override; shared-config subfolder launches are refused.

> **0.7.0:** Coordinator-local reminders follow worker calls, at a five-minute default that [you can configure](#reminder-interval). Use `intercom_stop_reminders` when nothing needs follow-up. Busy periods are skipped; shutdown/reload clears the timer.

> **0.6.1:** Linux Herdr background save-handoff-and-close workflow, with saved public summaries in config and monitor/JSON details. Empty rosters no longer open a monitor; coordinator session/tab names are preserved.

For potential next steps, see [Improvement topics](references/roadmap.md). These are proposals for discussion, not implemented features or release commitments.

## What a session can look like

Ask your coordinator:

> Review the launcher and its tests for reliability issues. Delegate focused reviews to workers, evaluate their findings, and bring me a proposed fix plan before changing code.

The coordinator can give one worker the launcher review and another the test review. Each investigates in its own context and reports back. The coordinator then checks the findings, resolves overlaps or disagreements, and decides whether to ask for more evidence or present the plan to you. Because you asked for a plan first, it stops before making changes.

You direct the goal and boundaries—not every message between workers. Separate worker terminals remain available whenever you want to inspect their conversations.

The monitor provides a compact view alongside that workflow. Example observations:

```text
Worker       Seen           Status       Last activity
Reviewer     3s ago         working      Reading files
Tester       12s ago        idle         Running command
```

Status is **last reported**, not proof of a live connection. An idle worker's last activity can remain visible after it finishes a turn; neither idle nor a delivered message proves an assignment is complete. Old observations are marked explicitly.

## Quick start

**Requirements:** Windows or Linux, Node 22.19+, interactive [Pi](https://github.com/earendil-works/pi), and project trust. Use Herdr for worker tabs on either platform; Linux worker launching requires it. Pi supplies the extension's host peers (`@earendil-works/pi-coding-agent`, `typebox`). The separate Node monitor uses its own pinned runtime dependency, `pi-intercom-tui` (an npm alias of `@earendil-works/pi-tui`), installed even when Pi disables peer installation. It does not depend on Pi's extension loader or a machine-specific host installation path.

### Install the published extension

```sh
pi install npm:@comput/pi-intercom
```

Open Pi inside a Herdr workspace at the project root you want to coordinate, or run `/reload` in an existing session there. Then ask it to create workers and give them a bounded task.

`pi install` uses your personal settings by default; add `-l` for project settings. Load only one copy: do not enable the npm package alongside a source checkout, or both source and built output. Use `pi list` to check your configured packages.

### Know the boundaries

- **Graceful stop remains disabled.** Pi 0.84.4's cancellation behavior leaves retry continuations alive; newer versions are not assumed safe without verification. The Linux Herdr `close_worker` in 0.6.1 has a different contract: request/save a handoff, await final settlement, then attempt an identity-checked external pane close. It does not use Pi abort/shutdown or promise all descendants terminate. Manual closure remains available. See the [cancellation blocker](references/implementation-blocker.md).
- **No silent recovery.** Intercom does not automatically retry messages, replace workers, switch launchers, commit changes, or roll them back.
- **Local, not remote.** Messaging binds to loopback. Local processes are trusted; this is not an authenticated service for untrusted clients.

For the exact steps and tool contracts, see [Explicit workflow](#explicit-workflow), [Tools and permissions](#tools-and-permissions), and [Config and wire contracts](#config-and-wire-contracts).

### Updating the loaded copy

- **npm installation:** update the installed package, not this checkout: `pi update npm:@comput/pi-intercom`. A pinned version must be explicitly changed (for example, `pi install npm:@comput/pi-intercom@0.1.2`, using the same settings scope as the original installation). `pi list` shows configured package sources; inspect that installation's `package.json` to confirm its version.
- **Source loading:** update that checkout and run `npm ci && npm run build` to rebuild the standalone monitor. This does not update a separate npm installation.
- After obtaining the intended code, start a new session or use Pi `/reload` in each affected running host. **`intercom_reload_worker` only reads shared configuration; it cannot load extension-code fixes.** Workers launched by a coordinator receive the coordinator extension's actual file path. Updating a different copy does not change that path, and existing workers do not automatically reload.

The 0.1.2 update/reload and subsequent worker creation were observed live; comprehensive reload/session-replacement lifecycle coverage remains pending.

### Install from source

To develop or run a source checkout, build and register it:

```sh
git clone https://github.com/comput-sh/pi-intercom.git
cd pi-intercom
npm ci
npm run build
pi install /absolute/path/to/pi-intercom
```

Replace the final path with your checkout's absolute path (use a Windows path on Windows). Remove or disable a separately installed npm copy before loading source. Then open Pi in the project you want to coordinate—not necessarily the extension's checkout.

Run Pi `/reload` (or start a new interactive session) after installing or changing source; reload workers too when changing their extension code. A standalone monitor already running in its pane needs an explicit restart to load rebuilt display code. Linux supports messaging, configuration, the terminal monitor, and Herdr worker launch/resume. Launch the coordinator inside a Herdr workspace; `herdr`, `sh`, and `pi` must be on PATH in worker panes. Workers run a quoted POSIX shell command in the returned pane, with the coordinator's actual extension path. Project trust remains required.

Linux `multiplexer: none` is explicitly unsupported: no terminal guessing, headless fallback, or automatic cleanup. Graceful stop remains disabled on both platforms; external pane closure is Linux Herdr only. Automated Linux tests cover shell argument preservation and adapter/HTTP behavior. A live source-loaded Linux Herdr smoke test launched two workers: both registered, loaded their configured names/responsibilities, and acknowledged coordinator messages through Intercom. This verifies launch and round-trip messaging, not resume or cancellation.

### Startup and launchers

**Strict root isolation (0.8.0):** The session's starting working directory is its config root. An explicit flag cannot widen this boundary. Only `<root>/.pi-intercom/config.json` is considered: there is no upward search, Git-root inference, or home-directory fallback. If that exact config is absent, startup creates a local coordinator config, opens a loopback listener, preserves the session/tab name, and waits for user input (no model turn). Invalid/unreadable local config is an error and is not overwritten. A session ID absent from an existing selected config, including a fork, is a worker, never a replacement coordinator.

Created/resumed workers receive `--intercom-root /absolute/session/root` explicitly as a same-directory assertion, **not permission to read a parent config**. The supplied root must canonically equal the session working directory, and its exact config must already exist. A mismatched root is rejected before reading its config or creating startup resources. No environment variable selects a parent root. Shared-roster workers must start in the coordinator's root; create/resume requests for subfolders are rejected before launch instead of silently changing the working directory. Linked metadata/config paths that escape the root and stable redirects of an already validated root are rejected. Monitor/logging readers retain stricter rules and may reject even internal links. These guards cover config access and temporary-config cleanup. They do not sandbox all filesystem I/O, pin an already-running telemetry writer after filesystem changes, or provide an atomic defense against concurrent filesystem replacement.

**Upgrade note:** Existing subfolder workers cannot rejoin a parent roster by supplying a flag. Their saved history/config entries are retained, but launching them in a subfolder with the parent's config is refused. Use workers whose configured directory is the coordinator root, and explicitly describe any subfolder work in their assignment. Independent sessions started in subfolders use only their own local config; ancestor files are left untouched.

Default launcher `herdr` requires the coordinator to be inside Herdr (`HERDR_ENV=1` and workspace context), with `herdr` on PATH. Windows needs `powershell.exe` plus `pi.ps1` in the worker pane; Linux needs `sh` plus `pi`. Each worker gets **one tab, one pane, no split, no focus change**. The Windows-only `none` launcher requires `pi.cmd` and Windows PowerShell on PATH and opens a separate visible PowerShell terminal. Missing launcher is an error, not fallback. Launch acknowledgment means command submission/terminal creation, not Pi readiness. A failed launch can leave a tab or process behind; no automatic cleanup occurs. See the scoped live evidence below.

## Explicit workflow

1. Coordinator calls `intercom_create_worker({projectDirectory:"."})`. The launcher passes the same-directory root assertion; no worker identity, responsibility or callback address is passed.
2. Anonymous worker opens its own endpoint and sends its session ID, actual port and root-relative project directory to coordinator Pi. Registration starts a normal coordinator turn when idle or queues steering when busy. It creates **no config entry or hidden pending-registration map**.
3. Coordinator decides and calls `intercom_configure_worker` with **all five explicit fields**: `sessionId`, `port`, `projectDirectory`, `name`, `description`. This only writes config.
4. Coordinator separately calls `intercom_reload_worker({to:"Builder"})`. Worker rereads responsibility and synchronizes Pi/Herdr tab names. **This is not Pi `/reload`, a restart, cancellation, or work assignment.** No model turn starts.
5. Coordinator sends explicit work using `intercom_send({to:"Builder",message:"..."})`. Workers can communicate directly with configured peers. Findings do not authorize unrelated implementation. Progress questions ask for reporting and continuation, not cancellation.
6. Workers report as instructed and wait, without autonomous exit. Coordinator unavailability does not close the worker or cancel its assignment.

Existing workers restore responsibility by session ID, bind their saved port or, if it is already in use, an OS-selected fallback, and report their actual port. Coordinator updates existing ports as bookkeeping. Status from removed/unknown sessions notifies Pi but creates no entry. Resume uses the configured project directory and full session ID, with a saved-session lookup first; a never-used Pi session might not yet exist on disk. Failure leaves config unchanged, without fabricated history or forced model turns.

## Tools and permissions

Every tool rereads current config and checks the live Pi session ID. Names are case-insensitive for lookup/uniqueness; display capitalization is preserved. `Coordinator` is reserved for internal configuration/routing. The coordinator's existing Pi session name and Herdr tab title are preserved; only worker sessions are synchronized to their configured names.

| Tool | Arguments | Permission / effect |
|---|---|---|
| `intercom_create_worker` | `projectDirectory?` (default `.`) | Coordinator; launch anonymous worker at the same root only |
| `intercom_configure_worker` | `sessionId`, `port`, `projectDirectory`, `name`, `description` | Coordinator; all five explicit fields, writes only |
| `intercom_reload_worker` | `to` (worker name) | Coordinator; passive config/name reload |
| `intercom_send` | `to` (name), `message` | Configured, responsibility-loaded sessions; asynchronous message |
| `intercom_list` | None | Configured coordinator/workers; saved roster, never live health |
| `intercom_worker_status` | `name?`, `offset?`, `limit?`, `probe?` | Configured sessions; local JSON by default, optional bounded endpoint checks for returned page |
| `intercom_request_status` | `to` (worker name) | Coordinator; independent extension report |
| `intercom_stop_reminders` | None | Coordinator; disable reminder timer until another qualifying worker call, without cancelling work |
| `intercom_report_status` | None | Workers including anonymous; shared report function, never registration |
| `intercom_report_work` | `status`, `summary?` | Configured, responsibility-loaded workers; save a public report and notify coordinator, never approve/complete work |
| `intercom_stop_worker` | `to` | Unsupported graceful cancellation; no side effects |
| `intercom_close_worker` | `to` | Linux Herdr coordinator; request background handoff/save/settle/pane-close job, retain registration |
| `intercom_report_handoff` | `jobId`, `summary` | Requested worker only; save concise public handoff, then finish the turn and wait |
| `intercom_resume_worker` | `to`, `confirmClosed` | Coordinator; user-confirmed old-session closure, saved session/launcher/directory, guarded launch |
| `intercom_remove_worker` | `to` (worker name) | Coordinator; config entry only, no shutdown/session deletion |
| `intercom_set_multiplexer` | `multiplexer`: `herdr` or `none` | Coordinator; future launches only |

**Removal precondition:** close a running worker before removing its entry. Removal forgets the registration; it is not how to park a worker for later resume. Active/uncertain close jobs fence removal and other lifecycle/work operations. Saved IDs/ports alone do not prove closure; no force-kill fallback occurs.

Anonymous `send`/`list` and all coordinator operations fail explicitly. Anonymous registration and status remain available. A dedicated repeat-registration operation and broader anonymous permissions remain **unresolved contract TODOs**, not silently added tools. If initial registration fails, the worker remains reachable and reports the error locally. Explicit user Pi `/reload` restarts this extension and repeats startup registration; status is not a substitute and there is no automatic retry.

### Coordinator reminders (0.7.0)

A coordinator-local timer wakes an idle agent to review delegated work. It is **not** an endpoint health ping, task assignment, worker retry, or crashed-process watchdog. It starts disarmed and does not change shared config or the wire protocol.

- Valid coordinator calls to create, configure, resume, reload, request status from, message, or close a worker start/reset the timer **before the attempted operation**. A subsequent operation failure can still need follow-up, so it does not automatically cancel the timer.
- At the configured interval (five minutes unless [`PI_INTERCOM_REMINDER_MINUTES`](#reminder-interval) says otherwise), recheck coordinator identity and whether Pi is idle. Busy ticks are skipped, not queued. Worker replies, incoming reports, list/JSON status reads (including probes), and worker-to-worker/coordinator messages do not reset it.
- `intercom_stop_reminders({})` disables reminders until the next qualifying call. It does not cancel workers, close jobs or model work. There is no automatic reminder-count cutoff.
- Timers are in memory only. Shutdown, Pi `/reload`, or session replacement disposes them; startup does not restore or replay them. Reset/stop invalidates stale callbacks and older in-flight calls cannot re-arm after a later stop.
- Aborting the owning tool's Pi run also disarms its reminder generation when that AbortSignal is available. This is **not universal Escape/Stop detection**: the host may later be in a separate retry/compaction run whose abort does not reach the original signal. Use the explicit stop tool to disable reminders reliably.
- Reminder delivery uses Pi's existing user-message path. Host input rejection remains possible (including the documented compaction gap); reminders are not immediately retried. The next normal tick is a new periodic check, not proof of prior delivery.

The reminder contains only this fixed public text, never task payloads or private reasoning:

> Intercom reminder: Review outstanding delegated work and worker reports. If follow-up is needed, take the next appropriate action. Do not assume workers have finished or stopped.
>
> If there is genuinely nothing to follow up on, call `intercom_stop_reminders`. Otherwise, reminders continue at the configured interval; a new worker call resets the timer.
>
> This reminder does not authorize new work, retries, worker closure, or publication.

The text is fixed and interval-neutral: it never contains the configured value, task payloads, or worker data.

Reload the coordinator's extension to register the new tool and timer logic. No existing live session is armed merely by installing the change.

#### Reminder interval

`PI_INTERCOM_REMINDER_MINUTES` sets the coordinator reminder interval in **whole minutes**. It is read once per coordinator runtime start from that Pi process environment; the chosen interval then stays stable for that runtime, including every reset and rearm. Nothing is written to disk and the wire protocol is unchanged.

```sh
PI_INTERCOM_REMINDER_MINUTES=2 pi
```

```powershell
$env:PI_INTERCOM_REMINDER_MINUTES = "2"; pi
```

- Accepted value: ASCII decimal digits only, surrounding whitespace ignored, leading zeros allowed, numeric value `1` to `35791` inclusive. `35791` is `floor(2147483647 / 60000)`, the largest whole-minute delay inside Node's signed 32-bit timeout maximum, so a long interval fires at the requested time instead of overflowing to a near-immediate tick.
- Anything else — `0`, `-5`, `+2`, `2.5`, `2e3`, `0x10`, `2min`, a non-ASCII digit, or a value beyond a safe integer or above `35791` — falls back to the **5 minute** default. There is no throw, clamp, or disable, and an unusable value cannot block extension startup, worker operations, or scheduling. The raw value is never echoed into a reminder, notification, or log.
- Unset, absent or blank/whitespace-only input stays quiet. Explicit nonblank unusable input attempts **one** coordinator startup notification with the fixed text `PI_INTERCOM_REMINDER_MINUTES is invalid; using the 5-minute default`. It contains no supplied value, arms no timer, and is not repeated on resets, rearms or configuration reloads. Workers (including anonymous) never emit it. If the notification itself fails, it is not retried and startup and worker operations still proceed normally.
- `0` is **not** a disable switch. `intercom_stop_reminders({})` remains the way to disable reminders until the next qualifying worker call.
- Scope is the coordinator Pi process environment only. This option has **no `settings.json` support and no project/global precedence**. Worker processes and shared workspace configuration are unaffected, and nothing watches or rereads the value while a runtime runs.
- Startup, Pi `/reload`, and session replacement each read it again for the new runtime, which still starts disarmed. Pi `/reload` re-reads only the environment that process already has, and a child-shell `export` cannot change the already-running coordinator, so restart Pi with the new inherited environment to change an operator-provided interval. `intercom_reload_worker` is configuration reload only and never rereads the interval.

## Config and wire contracts

Shared, source-controlled file: `<root>/.pi-intercom/config.json`. Do not ignore it or split IDs/ports into runtime config. Example **schema only** (not automatically installed placeholder data):

```json
{
  "version": 1,
  "multiplexer": "herdr",
  "agents": [{
    "sessionId": "actual-pi-session-id",
    "name": "Coordinator",
    "coordinator": true,
    "description": "Coordinate workers, delegate work, and manage shared configuration.",
    "port": 49152,
    "projectDirectory": "."
  }]
}
```

Legacy coordinator-only `dashboardPort` values are accepted for migration, but the browser dashboard has been retired in 0.4.1. Coordinator startup removes this field through the guarded config-write path. `intercom_list` returns the saved roster without `dashboardPort` or `dashboardUrl`; it does not probe live availability. The agent messaging `port` is unchanged.

Workers have `coordinator:false` and an existing project directory equal to root or below it. Writes canonicalize directories and check real paths (including symlink escapes). Only coordinator extension operations write config; ordinary Pi file/shell tools are not restricted.

Initial creation writes/fsyncs a complete temporary file then atomically publishes via a no-replace hard link. Contenders see only complete config; exactly one wins. Unsupported hard-link filesystems fail explicitly, without unsafe fallback. Interrupted staging files can remain as ignored `.tmp` files but are never mistaken for config. Updates are serialized, join Pi's file-mutation queue, validate, fsync a temporary file and atomically rename. Duplicate activation of the same coordinator session in multiple processes and external editors racing writes remain outside V1's guarantees (session locks deferred).

HTTP binds **127.0.0.1 only**. `POST /intercom` accepts UTF-8 JSON, at most 64 KiB. Version 0.5.1 also exposes side-effect-free `GET /intercom/health`, returning only protocol version and current session ID; it does not submit messages/model turns or write config. Envelope:

```json
{"version":1,"kind":"message","from":"sender-session-id","to":"expected-recipient-session-id","payload":{"message":"explicit message"}}
```

Handoff wire kinds (0.6.1): `close_prepare`, `close_identity`, `close_request`, `handoff_report`, `close_ready`, `close_commit`. These require configured roles, matching job/runtime identity and bounded validated payloads. Pane/process identity is ephemeral protocol data, never stored in public config or summaries.

Other kinds: `message`, `report` (`status`, `summary`; configured worker → coordinator only), `registration` (`port`, `projectDirectory`), `status` (`port`, `busy`), `request_status`, `reload`, `stop`, `close` (empty control payload). Sender session identity is the envelope `from`; registration/status agent notifications include an explicit `sessionId` field. Agent messages require configured sender and recipient; controls require the current coordinator's sender ID and a worker recipient. Registration/unknown status are intentional exceptions to configured-sender checks, accepted only by coordinator. All receivers verify expected recipient ID, protecting against stale ports reaching another session. Local processes are trusted: this is role validation, **not authentication**. No remote networking/proxies/redirects or credentials.

`202 {"accepted":true}` means Intercom extension receipt/dispatch, **not guaranteed Pi input acceptance, queueing, or model completion**. In Pi 0.84.4, `sendUserMessage` can reject during manual compaction after Intercom has acknowledged receipt: its void extension API reports the asynchronous rejection only as a local host error. Intercom has no delivery queue or retry to repair this gap; inspect the recipient's local error and arrange an explicit resend after compaction if needed. Replacing it with `sendMessage` is not a safe workaround because that path can start a concurrent run. Invalid/unsupported requests return an error; excessive bodies return 413. Request-status sends its report separately after accepting control. Starting in 0.2.1, Intercom always supplies `deliverAs: 'steer'`: Pi starts normally when idle and steers when busy. This avoids the idle-snapshot-to-busy race that caused “Agent is already processing” errors; it does not fix manual-compaction rejection. It does not hard-interrupt an executing tool. Each send resolves the recipient again from config; 5-second receipt deadline, **no retries**. Timeout means unknown outcome, not proof of nondelivery. No durable inbox, deduplication or replay log in V1.

Version 0.2.0 telemetry adds an optional envelope `correlationId` for one transport attempt; legacy envelopes without it remain accepted. It is not agent identity, deduplication, a task ID, or a reply/completion guarantee.

Tool text output is bounded to 50 KiB/2000 lines. The full saved roster remains in the shared config file. Name sync errors are surfaced; startup retains the useful endpoint, and explicit reload reports failure (Pi name/responsibility may already have changed before a Herdr tab rename fails).

## Standalone terminal status monitor

When at least one worker is registered, the coordinator automatically checks for its monitor pane on startup inside Herdr. If missing, it creates a small pane **above the coordinator**, preserving coordinator focus. With no workers, it does not create/check the monitor. Configuring the first worker triggers the check; disconnected saved workers still count. This does not automatically close an already-existing monitor when the final worker is removed. This is a standalone Node/pi-tui program, **not another Pi instance**. The old inline widget implementation has been removed. Source installations must run `npm run build` before reloading Pi; published packages include the compiled `dist/monitor.js` entry.

The table uses aligned **Worker | Connection | Report | Activity | Seen | Last activity** columns (activity age/detail give way first on narrow panes). Report is explicitly worker-authored and separate from host activity. Activity is the last reported `working`, `thinking`, `idle`, `closed`, or `unknown` state. Seen marks evidence older than 60 seconds with `(old)`; this is not a live connection indicator. Last activity uses fixed public labels such as Reading files, Running command or Writing response and can persist after the worker settles. Recent working/thinking/idle observations use restrained colors; old evidence remains neutral and explicitly marked. `NO_COLOR` disables styling. Version 0.5.2 adds a small footer label for the Intercom package version loaded by the monitor at startup; restart the monitor after updating to load the new version. Narrow panes use a compact version label and preserve the quit hint. No read-only banner or busy/idle count summary is shown. It reads the bounded config/log snapshot and performs read-only loopback health checks, then refreshes roughly three seconds after completion, without worker prompts or model calls. Checks are bounded by 750 ms per endpoint, a four-second batch budget, 16 concurrent requests and 256 workers; no overlapping batches or retries. Closing the monitor aborts checks. Only observed activity is shown, not inferred assignments/completion. Evidence over 60 seconds old is stale; missing evidence is unknown. The number of worker rows adapts to the pane height, with an omitted count when needed. The display is clipped to pane dimensions. In the monitor pane, use **↑/↓** to select a worker and **Enter** to toggle its details (configured responsibility and observed status). Selection follows the worker across roster reorder and scrolls the visible window. **Escape** closes details first, then quits; **q** or **Ctrl+C** always quits only the display process, never agents or their panes.

Detailed phase reports require reloading participating Pi sessions. `thinking` is emitted only when the provider supplies thinking events; missing thinking events do not imply that no reasoning occurred. Streaming content, reasoning text, command arguments and tool outputs are never read or logged for status. Repeated streaming events are deduplicated; concurrent tools are tracked without recording their arguments. Legacy busy observations display as working without invented detail. No task completion is inferred from settlement.

The pane's display name is simply `Intercom monitor`. Ownership uses saved pane/workspace/coordinator identities in machine-local `.pi-intercom/monitor-*.json` records; the generic display name alone is never proof of ownership. Older session-bearing labels are migrated when their pane is identified. Reload reuses an existing pane without injecting commands into it; pane existence is not proof the monitor is running. If the owner closes the pane, a subsequent coordinator startup can create its replacement. If the monitor program exits but its pane remains, restart it explicitly in that shell: `node /absolute/package/path/dist/monitor.js --root /absolute/project/path`. Moved/ambiguous panes and partial launches require inspection, not blind duplicate creation. A crash can leave a launch lock/pending record: inspect Herdr's panes and these records before manually recovering them. No automatic pane cleanup, focus stealing, or retry is performed.

Outside Herdr, messaging continues without a status pane. The browser dashboard is retired; no dashboard listener or browser assets are started/shipped in 0.4.1. A monitor or legacy-metadata cleanup failure does not disable messaging. Reload an older running coordinator to close its former dashboard listener. These features replace the browser dashboard from 0.3.0.

### Keeping a worker for later

Close the worker's Pi session manually **without removing its registration**. Its name, responsibility, session ID, directory and last saved endpoint remain in config; its Pi session history remains in Pi storage. The monitor keeps its row visible and sorts disconnected workers last, preserving saved order within each group and selection by session ID. This is a derived connection state, not a config deletion or a hidden row.

Connection is separate from historical activity and public reports. A recent matching health response means connected. Refused connections, timeouts or a mismatched session ID mean the saved worker endpoint is unreachable/unmatched—not proof the process is stopped. Old versions without health support, malformed responses, unsupported protocols and skipped checks remain unknown. Checks older than 30 seconds expire to unknown. Details show check time/reason; cached checks are discarded when a saved port changes or a worker is removed.

After the user confirms the previous session is closed, call `intercom_resume_worker({ to: "Builder", confirmClosed: true })`. It launches the **same saved Pi session**, restores configured identity/responsibility, and does not automatically start an old assignment. A matching connected endpoint blocks resume. Concurrent/submitted/uncertain attempts are fenced locally until a subsequent configured worker status arrives. On uncertain launch with no status, inspect the actual worker process; only after verifying closure should you reload the coordinator and consider an explicit retry. The fence is not persistent or a cross-process uniqueness guarantee. Resume failures do not remove/replace saved identity.

`intercom_remove_worker` is only for forgetting the saved registration, not parking a worker. Graceful stop remains disabled; see the background close workflow below. Reload coordinator/workers and restart the standalone monitor to use the new health protocol/UI; these additions require 0.5.1.

### Background save-and-close (0.6.1)

On supported **Linux + Herdr**, `intercom_close_worker({to:"Builder"})` returns a persisted job ID/state promptly. It does not hold the coordinator model turn open waiting for the worker. The extension performs these steps in the background:

1. Obtain and independently verify the worker's current pane, session header, terminal identity and Linux PID/start identity. Never infer ownership from a title/name alone.
2. Ask that worker to call `intercom_report_handoff({jobId,summary})` with a concise public summary (up to 4000 characters): completed work, unfinished items, blockers, validation and relevant project files. No credentials, private reasoning, raw tool output or private session paths.
3. Save `Agent.handoff` and `Agent.closeJob` atomically in config; only then acknowledge the worker's report tool. No pane closes at this step.
4. Wait for a successful matching tool result in the current branch and the worker's final `agent_settled` notification. New input/activity invalidates readiness.
5. Persist closing intent, recheck pane identity, and make a final nonce-bound worker settlement challenge immediately before issuing one exact `herdr pane close` command.
6. Observe pane absence and the original worker process's exit. Record `closed` only when both are verified; otherwise retain an explicit failure/uncertainty state. Name, responsibility, session ID and saved handoff remain registered.

The latest handoff/job are visible in `intercom_list`, bounded `intercom_worker_status` JSON and monitor details—even while the worker is disconnected. A handoff is worker-authored context, not acceptance of its findings. Config may be source-controlled: keep these summaries non-secret.

Jobs have a 120-second deadline and at most 16 simultaneous coordinator jobs. Unsupported hosts, missing identity, missing summary, save failure or absent final settlement never authorize a pane close. Old workers must reload the updated extension first. Active/uncertain jobs fence new Intercom work and conflicting lifecycle/config changes. On coordinator reload, pending jobs become interrupted and closing intent becomes uncertain; no job is automatically replayed. An uncertain persisted job requires explicit operator inspection/recovery of config before a new close/resume/removal—do not erase its fence or retry blindly.

**Scope of guarantees:** this is external pane closure, not graceful Pi cancellation. Herdr's pane-ID-only API has no atomic compare-and-close operation; independent local/Telegram input or pane replacement can still race the final check. No guarantee covers escaped child processes or transcript fsync/power-loss durability. Windows/non-Herdr close is unsupported. A disposable ordinary Node process was verified to exit on pane closure in local Linux Herdr 0.9.1; that is not a full live Pi handoff/history test. No existing project worker was closed during validation.

### JSON worker status for agents and chat integrations

`intercom_worker_status({})` returns a bounded JSON page of configured workers, or use `{ name: "Builder" }` for one worker. Each entry includes `observedStatus`, `lastActivity`, `observedAt`, `observationAgeSeconds`, `stale`, `evidence`, and an optional public `report` with its independent timestamp/age. Unknown ages/staleness are `null`; conflicting/future observations remain unknown, not healthy. A null report means no readable active report, not proof there are no blockers.

The tool uses the **same observation interpretation as the terminal monitor** and reads local files only by default. Set `probe: true` to check the selected page's saved worker endpoints through the read-only health endpoint. No model turn or worker message is submitted. Results contain a separate `connection` object (`state`, `reason`, `checkedAt`); without probes it is unknown/not_checked. Disconnected entries sort last within each returned page; page boundaries stay in saved roster order, not a globally connectivity-sorted roster. It has no Telegram dependency: an agent can read the JSON and use its existing chat tools to present a summary. `intercom_list` remains saved configuration; `intercom_request_status` remains an explicit asynchronous live status request.

Results include `errors`, `truncated`, `totalInSnapshot`, and `nextOffset`. Use `{ offset: nextOffset }` until it is null. Default page size is 10; `limit` accepts 1–20, with an additional byte budget to keep JSON complete. The snapshot retains at most 256 configured agents; truncation and unavailable observations are explicit. No result is proof of current liveness, coordinator approval, or task completion.

### Worker reports and decisions

A configured worker that has loaded its responsibility can call `intercom_report_work`:

```typescript
intercom_report_work({ status: "blocked", summary: "The test database is unavailable; please provide a test environment or approve using a fixture." })
intercom_report_work({ status: "needs_decision", summary: "Should the endpoint keep backward compatibility or adopt the new response format?" })
intercom_report_work({ status: "ready_for_review", summary: "Updated the parser and added three edge-case tests; all pass. Please review before accepting the change." })
intercom_report_work({ status: "clear" })
```

There is one latest report per worker. A new report replaces it; clear saves an empty tombstone and removes the report indicator. Summaries are explicitly public, non-secret text (up to 2000 characters). They are sent to the coordinator, may enter its conversation history, and are saved in machine-local `.pi-intercom/reports/`—not in the metadata logs. Do not include private reasoning, credentials or raw tool payloads.

The coordinator validates the configured worker identity, saves the report, then submits a notification through the normal message path. Receipt does not prove the coordinator evaluated it. Reports do not automatically approve changes, assign follow-up work, resume a worker, or declare a task complete. Ready for review means **the worker is asking for review**, not that validation has been independently accepted.

The monitor shows Report alongside observed Status. Enter opens the worker's current report, age and summary. Reports persist until replaced/cleared and may outlive a process restart; their timestamps are separate from activity age. Missing/unreadable reports show no report indicator, not proof there are no blockers. Removed workers' report files are not shown or automatically deleted. No automatic resend or recovery is added; if saving succeeds but notification fails, inspect the saved report before deciding whether to resend.

Reload the coordinator and participating worker Pi sessions to register the tool and new wire handler. Older versions reject the new report kind rather than silently treating it as an ordinary message.

## Local observation data

The terminal monitor reads bounded metadata logs from `.pi-intercom/logs/` and names/responsibilities from shared configuration. It does not expose a web server. Logs exclude message bodies, reasoning text, tool payloads and raw errors. Keep sensitive information out of responsibility text.

Observations remain best effort: an old record is not a current heartbeat, a quiet log is not task completion, and transport receipt is not proof that Pi accepted or acted on a message. See the [observability reference](references/observability.md) for privacy, retention, snapshot bounds and legacy-dashboard migration.

The browser dashboard was part of published 0.2.x/0.3.0. Historical validation notes below refer to those releases, not the current terminal-only monitor.

## Development and validation

Run these commands from a source checkout; tests and workflows are not shipped in the npm package. The [original implementation validation snapshot](https://github.com/comput-sh/pi-intercom/blob/main/references/implementation-progress.md) is historical, not the current live-test inventory.

```sh
npm ci
npm run typecheck
npm test
npm run check:package
# Optional installed-host compatibility probe (confirms the known defect):
PI_INTERCOM_PI_ROOT='C:/path/to/pi-coding-agent' npm run test:host
```

The extension source runs through Pi's TypeScript loader; `npm run build` generates `dist` for tests and the standalone terminal monitor. Build output is included in releases; the publish job builds it explicitly before publishing with scripts disabled. `npm run check:package` also installs the tarball in an isolated directory with peer installation disabled (matching Pi's managed npm installs), verifies the standalone monitor imports without host packages, and checks its non-TTY error path. This network-dependent regression runs on both CI platforms; it does not claim a live terminal/Herdr smoke test. Pi core/typebox are peer dependencies, not bundled; pinned development copies are included in the lockfile for reproducible CI without local junctions.

## Publishing

[`.github/workflows/publish.yml`](https://github.com/comput-sh/pi-intercom/blob/main/.github/workflows/publish.yml) publishes through npm Trusted Publishing (GitHub OIDC), without an npm token secret. Configure the npm trusted publisher as owner `comput-sh`, repository `pi-intercom`, workflow `publish.yml`, with no environment.

The workflow validates on Windows and Linux, then publishes with provenance from a GitHub-hosted Ubuntu runner. It runs when a GitHub release is published or when manually dispatched. Release tags must be `v<package.json version>`.

Published versions are immutable. For a new release, bump package and lockfile versions, commit/push, then publish a matching GitHub release. Manual dispatch publishes the selected ref and is **not a dry run**; the release-tag check only applies when a release tag is present. Do not dispatch publishing for an already published version. CI validates pushes to `main` and pull requests separately without publishing.

### 0.8.0 Strict session-root isolation

- Never search parent folders for config, even when a local config is missing or malformed. An explicit root must canonically equal the session working directory; it cannot permit a parent config.
- Validate before startup resources, reject escaping/dangling config links and stable root redirects, and guard temporary-config cleanup. These are config protections, not a filesystem sandbox or atomic TOCTOU guarantee.
- Created/resumed workers receive an explicit same-directory root assertion. Shared-config subfolder launches are now rejected, not silently relocated. Existing registrations/history remain intact.
- Includes the coordinator reminders from the preserved 0.7.0 GitHub release, whose npm publication was blocked by authorization after the repository transfer.
- Local validation: 205 tests, typecheck and isolated package-install checks passed. Native Windows/Linux CI gates publication.

### 0.7.0 Coordinator reminders

- Valid coordinator worker calls arm/reset a five-minute reminder using fixed public text. Failed attempted operations can still need follow-up; incoming reports and read-only status queries do not reset the timer.
- New coordinator-only `intercom_stop_reminders` disables reminders until the next qualifying worker call. No automatic reminder-count cutoff, worker retry, closure or publication is authorized.
- Busy ticks are skipped without a backlog; stale callbacks and older in-flight calls are fenced. Shutdown/reload/session replacement clears ephemeral timer state.
- Owning-run AbortSignal cancellation is supported where available, but is not universal detection of later Escape/Stop during separate retry/compaction runs.
- Local validation: 183 tests, typecheck and isolated package-install checks. Update and reload the coordinator to activate the new tool; startup itself does not arm reminders.

### 0.6.1 Background handoff-and-close and quiet startup

- First npm release of these features: the preserved 0.6.0 GitHub tag failed Windows validation and was not published to npm.
- Windows config publication handles transient `EPERM` replacement failures with bounded filesystem-only attempts and lifecycle/deadline checks before each attempt. Worker close commands, messages and jobs are never retried by this safeguard. Persistent contention can still prevent publication; an unpersisted terminal close outcome retains the existing intent/fence for operator inspection and reload recovery.

- Explicit Linux Herdr close jobs request and save a public worker handoff, await final settlement, then attempt one identity-checked pane close in the background. Worker registration, responsibility and session ID remain saved.
- Persist latest handoff and close-job status in config; show them in monitor details and JSON worker status. Correlation, deadlines, lifecycle guards and uncertainty fences prevent automatic replay.
- Empty rosters do not open/check the monitor; configuring the first worker triggers setup. Disconnected saved workers still count.
- Preserve the coordinator's existing Pi session name and Herdr tab title; worker naming remains synchronized.
- Validation includes typecheck, workflow/platform regression tests and isolated package installation. An isolated ordinary-process pane-close check passed on Linux Herdr 0.9.1; full live Pi handoff/history and Windows pane termination are not claimed.
- Upgrade coordinator/workers and restart the monitor. Close is Linux Herdr only, not graceful Pi abort or an all-descendants termination guarantee. Config-root discovery and connectivity polling architecture are unchanged.

### 0.5.2 Monitor version footer

- Display the monitor's loaded Intercom package version at the bottom-right, with a compact label on narrow panes and preserved quit hints.
- Read validated version metadata from the monitor's own package once at startup, not from the working directory. Restart the monitor after updating to load the new version.
- Add footer geometry, metadata validation and installed-package version checks. Local typecheck, 135 tests and isolated package-install validation passed.

### 0.5.1 Retained disconnected workers

The 0.5.0 release did not publish to npm because an occupied-port fallback exposed duplicate listener counting in test instrumentation. 0.5.1 fixes the test hook and forces that fallback deterministically, without changing production listener behavior. The 0.5.0 tag is unchanged.

- Manually closed workers remain in config and the monitor, preserving name, responsibility, session ID and directory. Disconnected rows sort last; selection follows identity.
- Read-only, bounded loopback identity checks distinguish connection state from observed activity and public reports. Old/unsupported endpoints remain unknown; endpoint failure is not proof of process termination.
- `intercom_worker_status` remains local-only by default; `probe:true` adds connection checks for the selected page.
- **Resume API change:** `intercom_resume_worker` requires `confirmClosed:true` after explicit user confirmation that the previous session was closed. Matching connected endpoints block resume; concurrent/uncertain attempts are fenced locally. No automatic shutdown, removal, restart or assignment.
- Reload coordinator/workers and restart the monitor after upgrading. Config-root discovery is unchanged.
- Local validation: typecheck, 132 tests and isolated package-install check passed; independent source review found no remaining critical blocker in reviewed paths. Native Windows/Linux CI gates publication.

### 0.4.2 Standalone monitor dependency fix

- Install a pinned TUI runtime dependency for the standalone monitor, independent of Pi's host-provided extension peers. Fixes `ERR_MODULE_NOT_FOUND` after managed Pi installs that disable peer installation.
- Add isolated tarball-install validation with peers disabled, module-import checks and the non-TTY CLI check to Windows/Linux package CI.
- Require Node 22.19+ to match the monitor dependency. Config-root discovery is unchanged by this patch.
- Upgrade the npm package, reload Pi sessions, and restart an existing monitor process to load the fix.

### 0.4.1 Coordinator workspace

The 0.4.0 GitHub release did not reach npm because a Windows-specific test expectation failed. 0.4.1 corrects that assertion without changing parser behavior; the 0.4.0 tag remains unchanged.

- Standalone Herdr terminal monitor replaces the browser dashboard; automatic pane ownership/reuse, keyboard selection and worker details.
- Explicit public worker reports: blocked, needs decision, ready for review and clear; no automatic approvals or assignments.
- Read-only, paginated `intercom_worker_status` JSON shares observation interpretation with the monitor. No chat integration dependency.
- Detailed public activity phases, bounded local snapshots and report storage, packaged monitor build output.
- Typecheck and 112 tests passed locally. Stop/close remain disabled; no new cancellation guarantee.
- Upgrade: update the package and reload coordinator/workers. Restart an existing standalone monitor to load new display code. Legacy dashboard metadata is migrated on coordinator startup.

### 0.3.0 Linux support

- Interactive startup, messaging and dashboard support on Linux.
- Herdr worker launch/resume command generation uses quoted POSIX shell arguments; Windows behavior is retained. Linux `none` fails explicitly without fallback.
- Linux validation: typecheck and 67/67 tests passed, with no skips. Live source-loaded Herdr launch, registration, configure/reload and round-trip messaging passed with two workers.
- CI and release validation now run on Windows and Linux. Stop/close remain disabled; live Linux resume is not yet verified.

### Release evidence

- [v0.1.1](https://github.com/comput-sh/pi-intercom/releases/tag/v0.1.1): successful npm OIDC [run 35466923379](https://github.com/comput-sh/pi-intercom/actions/runs/35466923379).
- [v0.1.2](https://github.com/comput-sh/pi-intercom/releases/tag/v0.1.2): successful npm OIDC [run 35467586052](https://github.com/comput-sh/pi-intercom/actions/runs/35467586052). Fixes Windows Herdr launching by using `herdr pane run` on the returned pane ID with encoded PowerShell invoking `pi.ps1`, instead of the failing `Start-Process pi` wrapper. No Herdr agent alias is needed.

- [v0.1.3](https://github.com/comput-sh/pi-intercom/releases/tag/v0.1.3): successful npm OIDC [run 35474304380](https://github.com/comput-sh/pi-intercom/actions/runs/35474304380). Contains the fixes below, not the observability feature added in 0.2.0.

### 0.1.3 changes and verification

Version 0.1.3 includes these fixes (not present in 0.1.2):

- Lifecycle generation/session checks reject stale queued or in-flight operations before submitting new launches, sends, deliveries or config publication. This includes delayed listener startup, anonymous registration and deferred status reporting. An OS link/rename or external action already submitted before invalidation is **not cancelled or rolled back**; there is no guarantee that in-flight external actions are drained.
- Failed temporary-file write, sync or close attempts best-effort close/unlink cleanup while preserving the primary error. Filesystem cleanup failures can still leave temporary files.
- Resume preflight now follows the child session-storage context: `PI_CODING_AGENT_SESSION_DIR`, then target-project/global `sessionDir` settings, then Pi's default. Relative storage paths resolve against the target working directory. Launchers do not propagate the coordinator's CLI `--session-dir`; no machine-specific session path is stored in shared config. A static persisted-session fixture and mocked launcher validate lookup, not live resumed-worker startup.

Pre-observability fix milestone: coordinator validation recorded `npm run typecheck` PASS; `npm test` **36/36**, no failures; `npm run check:package` PASS; `git diff --check` PASS (line-ending warnings only). Quality independently confirmed typecheck and all 36 tests, with no remaining actionable regression identified in those fixes. This count predates the logging/dashboard changes; it is not their aggregate validation. Tests include actual extension-adapter event handling against a mocked Pi API/context and runtime-to-runtime loopback HTTP; they do not establish real Pi queue or compaction behavior.

### 0.2.1 delivery regression validation

Always specifying steering fixes the missing-streaming-mode race without adding retries or an Intercom queue. Coordinator and Quality independently passed typecheck and all **64 tests**, including a source-backed Pi 0.84.4 regression. Test fixtures now isolate discovery from real ancestor configurations; production discovery boundaries are unchanged and remain a separate design issue.

### 0.2.0 observability validation

Coordinator and Quality independently ran `npm run typecheck && npm test`: **63/63 tests passed, zero skips**. Coordinator also confirmed the 15-file package dry-run (dashboard assets and observability reference included; runtime logs excluded) and a clean `git diff --check`.

Coverage includes bounded metadata logging, transport/runtime instrumentation, read-only dashboard HTTP/security, actual UI code against hostile-text DOM fixtures, actual bound-port persistence before readiness, passive saved-URL discovery, bind/persistence failures and shutdown races. These use mocked Pi hosts and test-only loopback services; no live Pi dashboard startup or URL-liveness guarantee is claimed.

A separate synthetic-browser smoke check verified desktop rendering, literal hostile labels, unknown/stale evidence, error filtering and expandable metadata. Browser native-click automation timed out; programmatic DOM clicks verified the interactions instead, so this is not a full keyboard/mouse accessibility or live Pi end-to-end test.

Tests use temporary directories, local test-only HTTP servers, static session fixtures and mocked Pi hosts/launch executors. They never start agents, tabs, terminals, contact models, services or bridges, or access credentials.

### Observed live behavior

The release/session evidence reported during the 0.1.2 validation establishes these specific observations, not blanket lifecycle compliance:

- Encoded PowerShell invoking `pi.ps1` recovered an existing failed Herdr tab; Pi started and the worker registered.
- After package update and Pi reload, coordinator `intercom_create_worker` launched three workers; each registered, then was explicitly configured and separately reloaded. Integration's configured name was applied through configure/reload.
- An asynchronous Core → Coordinator message was relayed with `telegram_send` and receipt was confirmed by the owner. Telegram is a separate integration, not an Intercom transport or automatic forwarding feature.

### Remaining limitations / not comprehensively live-tested

- Idle/steering queue edge cases, busy snapshots, session-name persistence across restarts, trust UI and session replacement/reload lifecycle. The specific manual-compaction rejection gap described above remains unresolved; successful ordinary messaging does not verify that case.
- The observations above do not establish all Herdr failure paths, tab-association edge cases or readiness guarantees.
- Windows visible terminal/Pi process startup. Success only proves terminal creation, **not Pi readiness**; startup failures remain visible in that terminal. No live readiness handshake was added.
- Actual persisted-session lookup and resumed worker startup; never-used session failure.
- Cross-process/network-drive atomicity and Windows ACL/sharing failures (same-process temp-filesystem races are tested).
- Graceful stop remains disabled until a verified cancellation API covers retries, compaction continuations and queues. The Linux Herdr pane-close workflow is a separately authorized best-effort contract, not a claim that graceful cancellation was fixed.
- Explicit repeat-registration tool and broad anonymous permissions require a contract decision. Duplicate-session locks, takeover, durable logging, non-Herdr Linux launchers and macOS support are deferred.
