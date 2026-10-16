# PiIntercom V1 — Design Decisions and Open Questions

Status: historical design decisions and discussion notes. The agreed design is now consolidated in `v1-specification.md`, which is authoritative if historical wording here conflicts. Remaining target-design gaps are grouped in that specification; [README](../README.md) describes current supported capabilities. Stop/close remain disabled. Historical contracts below must not be used as a current tool reference.

The original proposal remains in `multi-agent-development-architecture.md`. Where this document differs, the confirmed decisions here supersede the proposal. Suggestions in the open questions are not decisions.

## 1. Confirmed decisions

### Naming

- Solution/project: **PiIntercom**.
- Historical package name: `pi-intercom`; published package: `@comput/pi-intercom`.
- Configuration: `.pi-intercom/config.json`.
- Agent-facing tools use the `intercom_` prefix.

### Explicit operations, not implicit recovery

- Tools perform their documented operation and report success/failure. The coordinator agent decides recovery.
- Do not hide worker removal, replacement, role reassignment, or launcher fallback inside another operation.
- Automatic replacement on resume failure is withdrawn. Review other proposed tool side effects against this principle; do not silently change previously agreed mechanics.

### One extension, two roles

- Exactly one extension codebase runs in both coordinator and worker Pi sessions.
- Coordinator and worker are runtime roles, not different extensions.
- Agents typically work on different projects within the same solution.
- Pi session IDs are the identities. Do not introduce separate instance IDs.
- Read the current session ID from Pi's extension context.
- Every agent has a human-readable name. The coordinator is responsible for name uniqueness.
- Name lookup and uniqueness checks are case-insensitive. Preserve configured capitalization for display.

### Shared configuration

- Use a single shared configuration file at `<coordinator-root>/.pi-intercom/config.json`.
- The coordinator always writes to this fixed location anchored to its project root.
- Root-isolation revision (0.8.0): all sessions read config only in their starting working directory. An explicit `--intercom-root` must canonically equal that directory; even explicit parent roots are forbidden before config access.
- The file must be suitable for checking into source control; session IDs and ports remain in this shared file, rather than being moved into a separate runtime configuration.
- Workers only read the configuration. The coordinator reads and writes it.
- Worker registration and port changes are reported to the coordinator, which performs the writes.
- These restrictions are enforced by extension code, not merely instructions to the model. V1 enforcement covers operations within the extension only: workers cannot write config through any extension path. Do not intercept ordinary Pi file or shell tools.
- Entries remain when worker processes close, allowing the coordinator to resume their existing Pi sessions.
- The coordinator can explicitly stop a worker and its running Pi session through a call to the worker extension. The saved session remains available for resume.
- Workers must not autonomously stop themselves. Finishing work means reporting and waiting, not exiting. Coordinator shutdown does not implicitly authorize worker self-termination.
- Configuration records session ID, name, coordinator flag, port, and a brief responsibility description.
- The configured multiplexer is also stored in this file.
- Each worker entry stores its project directory relative to the coordinator root. Creation and resume use this directory as the worker's working directory.
- Shared-roster worker create/resume requires the coordinator root itself. Descendant directory registrations/history are retained, but launching them against a parent config is rejected without silently changing cwd. The explicit root flag is a same-directory assertion, validated before startup resources.
- Invalid or unreadable configuration produces a clear error and is left untouched. Do not treat it as absent or overwrite it with new coordinator configuration. Only a genuinely absent config triggers initial coordinator creation.
- Exact JSON schema and additional fields remain open.

Illustrative entry, not a finalized schema:

```json
{
  "sessionId": "<pi-session-id>",
  "name": "Backend API",
  "port": 43101,
  "coordinator": false,
  "description": "Responsible for maintaining and extending the backend API."
}
```

### Initial coordinator startup

- Without an explicit workspace root, if the exact local config is absent, the extension becomes coordinator and creates it at the current project root. Explicit workspace mode requires an existing config and never falls back to creating a replacement coordinator.
- The initial coordinator root is Pi's current working directory. Do not attempt repository or solution root detection.
- Use default coordinator metadata:
  - Name: `Coordinator`
  - Responsibility: `Coordinate workers, delegate work, and manage shared configuration.`
- Notify the Pi agent when configuration and endpoint initialization have completed and the coordinator is ready. This does not trigger an agent turn or automatically continue setup; remain ready for user input.
- On extension startup, if the current session is the coordinator, check that the Pi session name and, when hosted in Herdr, its tab name are both `Coordinator`. Automatically rename either one if it differs.
- After readiness, the agent can invoke the worker-creation tool `intercom_create_worker`.
- Initial config creation must be atomic: when multiple sessions target the same config path, only one can claim creation and become coordinator. Others must not overwrite it; they wait for the configuration to be ready, read it, and register as workers. Exact mechanism and incomplete-initialization recovery remain implementation details.

### New worker registration

1. Coordinator launches a new Pi session with the same extension loaded.
2. Worker verifies the explicitly supplied root equals its cwd and reads only that directory's configuration. Its session ID has no entry yet, but a coordinator is configured.
3. Worker starts its local endpoint and reports its own Pi session ID, bound port, and project directory to the coordinator. The coordinator stores the project directory relative to its root; no launch-to-registration matching is required.
4. Worker waits anonymously; registration is not permission to start work. Do not create an unnamed placeholder config entry. Reported connection details are available to the coordinator for configuration.
5. Coordinator agent explicitly calls `intercom_configure_worker` to create the worker entry with name and responsibility, using the reported session ID, port, and project directory.
6. Coordinator agent separately calls `intercom_reload_worker` to tell the worker's endpoint to reread configuration.
7. Worker loads its configuration and becomes ready, without beginning a task.

- When shared configuration exists, any session ID absent from it follows the normal new-worker flow: register and wait for configuration and assignment. This applies to forks as well; do not inherit authority or responsibility from the source session.
- No separate instance ID is passed to workers.
- No worker-specific config file path or coordinator callback address is passed. The launcher supplies an explicit root equal to child cwd; the local config contains the coordinator endpoint. This never grants access to a parent config.
- Workers start unassigned: no name or responsibility. After registration, the coordinator assigns these by session ID in the config and tells the worker to reread it. Do not require sequential launches merely to match preassigned roles to registrations.
- When a worker reads its configuration, synchronize its Pi session name and, when hosted in Herdr, its tab name with its configured worker name. Automatically fix either mismatch.
- The means of loading the extension in a launched process must be deterministic; Pi's explicit extension loading is a candidate, not an instruction for the worker model to improvise setup.

### Responsibility is not a task

- Description defines the agent's responsibility, not its current assignment.
- Examples: managing and extending a backend API; researching a particular topic.
- Loading responsibility is background-context configuration, not a prompt or authorization to implement anything.
- Rereading configuration is handled by extension code and does not trigger an agent turn.
- Actual work begins through a separate explicit prompt, such as a coordinator message asking for research, implementation, or a report.
- Incoming information must not implicitly authorize unrelated implementation.
- Findings and other agent messages use normal Pi prompt delivery: start a turn if idle, steer if busy. Label messages with their sender and purpose.
- Workers may use findings within an existing assignment or acknowledge them and wait. Findings alone do not authorize new implementation work.
- Control messages execute extension code only; agent messages use normal prompt delivery. No separate context-only findings delivery is required in V1.

### Asynchronous messaging

- V1 transport is localhost HTTP. Each extension accepts messages through a single endpoint; no persistent connections are required.
- HTTP responses acknowledge receipt or report transport/validation errors only. Any later status, findings, or agent response is a separate asynchronous message, not the HTTP response.

- All application-level communication is asynchronous, one-way messaging, not request/reply RPC.
- Sending a message may result in zero, one, or multiple later messages.
- Sender does not wait for an agent reply as part of sending.
- A transport acknowledgment, if used, is distinct from an agent response.
- Coordinator can send work prompts and ask for status.
- On receiving a worker status report, the coordinator extension updates the worker's configured port if needed, then delivers a clearly labeled status notification to its agent: normal turn if idle, steering if busy.
- Automatic port updates on status receipt are explicitly approved endpoint bookkeeping, not implicit recovery; no separate coordinator-agent tool call is required.
- Status reports update existing entries only. A report from an unknown/removed session ID produces a notification without changing configuration. It must not recreate the entry; new-worker registration is a separate operation.
- New-worker registration likewise notifies the coordinator agent through normal/steering delivery so it can assign name and responsibility. Include the reported session ID, port, and project directory.
- Generating the worker's report requires no worker model turn; consuming it can trigger a coordinator turn. This differs from the coordinator's own passive startup-ready notification.
- Workers continue their assigned work and peer communication while the coordinator is unreachable. Coordinator unavailability does not suspend ongoing assignments.
- Workers can independently send status, progress, questions, findings, and results.
- Workers may communicate directly with other workers through the same protocol.
- Example: coordinator asks a research worker to investigate a topic and submit findings to the worker named `Backend API`.
- The send tool accepts the recipient's name only. It rereads configuration and resolves that name to the current port and expected Pi session ID. The transport message includes that destination session ID for receiver verification; Pi session ID remains the underlying identity.
- Every message includes its intended recipient's Pi session ID. The receiving extension verifies it against its current session ID and rejects mismatches, protecting against stale ports or port reuse.
- Peer introduction and coordinator forwarding are not required.
- No mandatory one-to-one reply or mandatory coordinator copy is implied; reporting expectations can be part of an assignment.
- Incoming prompts follow normal Pi interaction: if an operation is in progress, inject the prompt as steering; if idle, start a normal agent turn. Do not default to queuing until all current work finishes.
- Two distinct status paths exist: request an extension-generated status report (including busy flag, no model turn), or send a prompt asking the agent what it is doing (steering if busy).
- Typical coordinator flow is to request runtime status, receive an independent asynchronous report, then optionally send a detailed progress question. This is not a synchronous request/reply chain enforced by the protocol.
- Busy is a runtime snapshot, not a guarantee: choose steering versus a normal turn based on the worker's state when the prompt arrives.
- Steering is not a hard interrupt and does not necessarily stop an executing tool; use Pi's supported delivery boundaries.
- Progress questions do not cancel the existing assignment: report progress and continue unless explicitly redirected.
- Prefer extension-only status for routine monitoring to avoid unnecessary model interruptions.
- Checking runtime status before sending a prompt is optional, not a protocol prerequisite.
- In V1, report send failures immediately (once the connection attempt fails or times out), with no automatic retries. The calling agent decides whether to retry or take recovery action.
- HTTP sends have a 5-second timeout for receipt acknowledgment, not for agent work completion.
- Defer durable message logging until the basic system is working. Do not include a dedicated message journal in the initial implementation; send failures still need to be surfaced.
- Final message vocabulary remains open.

### Ports and configuration freshness

- V1 endpoints listen only on localhost (loopback), never external network interfaces.
- No authentication in V1. Local processes are trusted; destination session-ID verification prevents misdelivery but is not authentication.

- On startup, an extension with a configured port attempts to bind it.
- If the configured port is unavailable, bind port 0 so the operating system selects a free port. Use the same OS allocation when there is no configured port; no fixed fallback range.
- Worker reports the actual bound port to the coordinator, which updates configuration.
- A new worker without an entry binds an available port and reports it during registration.
- Coordinator updates its own configuration entry if its port changes.
- Every send-tool invocation rereads the configuration before resolving the recipient endpoint. Do not use a stale cached recipient port.
- Fresh config means the latest recorded endpoint, not guaranteed reachability. Send failures are reported with a 5-second timeout and no automatic retries.
- If the configured coordinator cannot be reached, the extension attempts the connection and reports failure, but still opens its own listening endpoint using the configured-port/fallback rules. Coordinator unavailability does not prevent local endpoint startup.
- Implement one shared worker status-reporting function that sends its current Pi session ID and bound port to the coordinator.
- The status report includes a busy flag alongside the session ID and bound port, determined by extension runtime state without a model turn.
- This function has two entry points: a tool invoked by the worker's own agent, and an incoming control message from the coordinator requesting a report.
- Both entry points use the same function and role gate. If the local host is coordinator, return an error: reporting itself as a worker makes no sense.
- The outgoing report is an independent asynchronous message, not an application-level reply returned by the incoming call. Exact tool/control-message names remain open.

### Agent-facing tools and permissions

- All Pi-agent interaction with Intercom is through tools, not agent-authored HTTP requests or direct config edits.
- Extension code controls reading/writing configuration, caching, transport, and permissions.
- For every tool invocation:
  1. Read the current Pi session ID from context.
  2. Reread the configuration.
  3. Determine the session's role.
  4. Check that role's permission for that specific tool before acting.
- Worker creation and multiplexer configuration are coordinator-only.
- Unknown/unregistered sessions must not be granted coordinator-only tool permissions.
- Receiving extensions reread configuration and validate sender roles for incoming control messages. Only the configured coordinator session ID may request worker stop, close, config reload, or status reporting. Peer agent messages remain allowed.
- Sender session-ID role validation is not authentication; V1 still trusts local processes.
- Automatic startup, registration, incoming transport, and config-reload control handling remain extension lifecycle behavior; they do not require model tool calls to execute.
- Full tool inventory and permission matrix remain open.

### Launch environment and multiplexer

- Default multiplexer is Herdr, persisted in configuration.
- Use one new tab per worker, not split panes.
- Support changing the configured multiplexer through the coordinator-only tool `intercom_set_multiplexer`.
- The design must allow another supported multiplexer or no multiplexer (`none`).
- If the configured multiplexer is unavailable, worker creation fails with a clear error. Never silently fall back.
- Launching is separate from the communication protocol; Herdr is the default launcher integration, not the messaging layer.
- In `none` mode, each worker launches in a separate visible terminal, not as a background process.
- V1 ships only Herdr and `none` launchers. Keep the launcher interface extensible for additional multiplexers later.
- V1 targets Windows. Keep the launcher interface extensible for other operating systems later.
- No additional bulk tools in V1; the coordinator uses existing operations for each worker. Consolidate settled behavior into a clean specification and flag remaining implementation gaps together.

### Resume intent

- Coordinator can restart closed workers by resuming their existing Pi sessions.
- A resumed extension reads its Pi session ID and finds the corresponding config entry, restoring its role and responsibility.
- Do not use a new instance identity for resume.
- Restoring responsibility is not a fresh assignment and must not itself start implementation.
- Locate saved sessions for resume using only the Pi session ID and project directory. Do not store machine-specific session-file paths in the checked-in config.
- Resumed workers wait for a new instruction, even if previous work was unfinished; they do not automatically continue it.
- When assigned work, workers perform it, report as instructed, and then wait for further instructions.
- Resume failure is reported to the coordinator agent with its reason. Leave the config entry unchanged: the extension must not automatically remove or replace the worker. The coordinator agent explicitly decides recovery through tools. This supersedes the earlier automatic-replacement decision.
- Exact Pi lookup implementation remains open. Distinguish an unavailable saved session from unrelated launcher failures; configured-multiplexer unavailability must still fail without fallback.

### Agreed tool: `intercom_create_worker`

- Coordinator-only.
- Only V1 input: optional `projectDirectory`, relative to the coordinator root, default `"."`.
- Validate that the directory is the coordinator root or a descendant.
- Launch a new Pi session in that directory using the configured launcher, with the same PiIntercom extension loaded.
- Return launch success or failure; do not wait for a worker reply or registration to complete the tool call.
- The worker independently registers its session ID and port, then waits. Name and responsibility are assigned afterward through a separate coordinator config tool.

### Agreed tool: `intercom_configure_worker`

> Superseded argument list below: the final contract requires **all five** fields `sessionId`, `port`, `projectDirectory`, `name`, `description`. Registration creates no saved entry or hidden pending map. Configure writes the supplied values; reload is always separate.

- Coordinator-only.
- Inputs: `sessionId`, `name`, and `description` (responsibility).
- Handles both initial configuration of a registered worker and later name/responsibility changes.
- Reject a name already used by another configured agent, including `Coordinator`. Keeping the same name for the same session is allowed.
- Writes the worker's name and responsibility into configuration, preserving its port and project directory.
- Only writes configuration. Does not send a reload notification or trigger worker activity.
- The coordinator agent separately calls `intercom_reload_worker` when it wants the worker to apply the saved configuration. This supersedes the earlier automatic-reload behavior.
- Registration includes the worker's project directory, which the coordinator stores relative to its root. Configuration does not require matching registrations to launches.

### Agreed tool: `intercom_send`

- Inputs: `to` (recipient name only) and `message`.
- Available to coordinator and workers.
- Reread config on every call and resolve recipient name to its current port and expected Pi session ID.
- Include sender identity and intended recipient session ID in the transport message. The receiving extension rejects destination session-ID mismatches.
- Deliver as a normal prompt if idle or steering if busy.
- Return transport success/failure; never wait for an agent reply.

### Agreed tool: `intercom_list`

- Available to coordinator and workers; no inputs required.
- Rereads shared configuration and lists configured agents' names, responsibilities, session IDs, roles, and ports.
- Does not probe endpoints or claim that configured agents are currently running.

### Agreed tool: `intercom_request_status`

- Coordinator-only.
- Input: `to` (worker name).
- Rereads configuration and resolves the worker's port and expected session ID.
- Sends a control message requesting the shared worker status-reporting function.
- Worker independently sends session ID, bound port, and busy flag to the coordinator; no worker model turn is triggered.
- Returns send success/failure, not the requested status. The status arrives asynchronously.

### Agreed tool: `intercom_report_status`

- Worker-only; no inputs.
- Rereads configuration to locate the coordinator and sends its own session ID, bound port, and busy flag.
- Uses the same shared reporting function as an incoming coordinator status request.
- Returns send success/failure without waiting for an agent reply.
- Reject execution on a coordinator host with an error.

### Agreed tools: `intercom_stop_worker` and `intercom_close_worker`

- Both coordinator-only, taking `to` (worker name). Reread config and include the expected recipient session ID in the control message.
- `intercom_stop_worker`: cancel current work while leaving Pi and its extension running, ready for further instructions.
- `intercom_close_worker`: cancel current work, then shut down the Pi process gracefully. No separate stop call is needed. Reconfirmed during explicit-operation review: cancellation is part of documented shutdown, not implicit recovery.
- Preserve the saved session and config entry for later resume.
- Use normal cancellation/shutdown mechanisms, not forced process kills. Neither operation automatically commits or rolls back file changes.
- Return control-message send success/failure, not an application-level reply or proof shutdown has completed.
- Confirmed lifecycle tool names: `intercom_create_worker`, `intercom_stop_worker`, `intercom_close_worker`, and `intercom_resume_worker`.

### Agreed tool: `intercom_resume_worker`

- Coordinator-only.
- Input: `to` (worker name).
- Reopen using the configured session ID and project directory through the configured launcher.
- If resume fails, return the failure and reason without changing configuration or creating a replacement.
- No launch failure authorizes implicit removal, replacement, or fallback. Recovery is an explicit coordinator-agent decision.
- Resumed workers wait for instructions rather than automatically continuing unfinished work.

### Agreed tool: `intercom_set_multiplexer`

- Coordinator-only.
- Input: `multiplexer`, accepting `herdr` or `none` in V1.
- Updates shared config for future launches (including resume).
- Does not move or restart existing workers.

### Agreed tool: `intercom_reload_worker`

> Wire-name correction: current control kind is `reload`, not the historical `reload-config` spelling below. Tool name and passive configuration-only semantics are unchanged.

- Coordinator-only.
- Input: `to` (worker name).
- Rereads shared configuration, resolves the worker's current port and expected session ID, and sends a `reload-config` control message.
- Use to explicitly request a config read after configuration changes, or to retry a failed notification.
- `intercom_configure_worker` only saves configuration. The coordinator agent must separately call `intercom_reload_worker` to notify the worker; there is no automatic notification.
- Reload means reread PiIntercom configuration only. It does not restart Pi, reload extension code, cancel current work, or trigger an agent turn/new assignment.
- The worker refreshes configured responsibility/name and synchronizes its Herdr tab name as applicable.
- Returns notification send success/failure, not an agent reply. No automatic retry.
- Clearly document these semantics and the distinction from Pi's own reload in the tool description and user-facing documentation, not just in this design document.

### Agreed tool: `intercom_remove_worker`

- Coordinator-only.
- Input: `to` (worker name).
- Removes only the worker's configuration entry.
- Does not stop a running process or delete the saved Pi session. Close a running worker separately first.
- No implicit recovery or replacement is triggered.

## 2. Outstanding questions

Ask these one at a time, include a review and recommendation for each point, let the user decide, then move the answer into confirmed decisions. Do not silently treat recommendations as agreed requirements.

### Current discussion position

Resume failures leave configuration unchanged and are reported to the coordinator agent; there is no automatic replacement. The tool contracts above were authoritative at that historical discussion point; the consolidated target specification now supersedes them, and README documents current support. Duplicate-session detection is deferred to future optimization. Workers continue assigned work and peer communication while the coordinator is unavailable. Unknown session IDs, including forks, follow normal new-worker registration. Incoming prompts steer busy workers; runtime status is extension-only and includes a busy flag, while detailed progress is obtained with a prompt. Send failures are reported without automatic retries in V1. Durable message logging is deferred until the basic system works. Destination session-ID verification is required for every message. V1 endpoints are localhost-only with no authentication. Config-write protection covers extension operations only; workers cannot write config through the extension. Findings use normal prompt delivery with sender and purpose labels; control messages run extension code only. Coordinator startup readiness does not trigger a turn; wait for user input. `intercom_create_worker` is agreed: coordinator-only, optional projectDirectory defaulting to ".", launch result only. `intercom_configure_worker` only writes initial or updated configuration; intercom_reload_worker is a separate explicit operation. intercom_send accepts recipient name only and resolves the expected destination session ID for transport verification. intercom_list is available to coordinator and workers and returns the configured roster, not live status. intercom_request_status is coordinator-only, addresses a worker by name, and requests an asynchronous extension-only report. intercom_report_status is worker-only, takes no inputs, and invokes the shared reporting function. Explicit lifecycle names with the _worker suffix are confirmed, including intercom_resume_worker. The intercom_resume_worker contract is confirmed. intercom_set_multiplexer is confirmed, affecting future launches only. intercom_reload_worker is confirmed; clearly document that it rereads config only and must be called separately from configure_worker. Registration includes project directory alongside session ID and port. Incoming worker status and registration reports notify the coordinator agent through normal/steering delivery; status reception updates changed ports first. Localhost HTTP with one receiving endpoint per extension is confirmed. OS-selected free ports are confirmed when no port is configured or the configured port is unavailable. Both coordinator and workers synchronize Pi session names and applicable Herdr tab names with their designated names. configure_worker rejects names already used by another configured agent, including Coordinator. Name lookup and uniqueness checks are case-insensitive, preserving capitalization for display. HTTP receipt timeout is 5 seconds, with no automatic retries. User rejects implicit recovery logic. Resume failure must be reported without removal or replacement. configure_worker and reload_worker are explicitly separate operations. Automatic port updates on status receipt are approved bookkeeping. Close-worker cancellation plus graceful shutdown is reconfirmed. intercom_remove_worker explicitly removes config only. Late/unknown status reports notify without creating config entries. Registration leaves the worker anonymous and does not create a placeholder config entry. Coordinator explicitly creates its named config entry, then explicitly requests reload. Do not reopen this settled flow.

### Setup and configuration

1. Resolved: use session ID and project directory only; do not save a session-file locator.
2. Resolved: the initial coordinator root is Pi's current working directory.
3. Partially resolved: attempt coordinator connection, report failure, and still open the local endpoint. Provide a tool to retrigger worker reporting of session ID and port. Recovery/takeover for permanently missing sessions remains open.
4. Resolved: atomic creation for the same config path; one coordinator wins, others wait for valid config and register as workers.
5. Resolved: V1 workers must use the coordinator root or a descendant directory.
6. What is the final config schema, including schema version and multiplexer settings?

### Launching and lifecycle

7. Resolved: no sequential-launch restriction for role matching. Workers register unassigned; the coordinator subsequently assigns name/responsibility by session ID. Check the Herdr tab name on config read and automatically rename it on mismatch.
8. Resolved: `none` launches workers in separate visible terminals.
9. Resolved: V1 ships Herdr and `none` only, behind an extensible launcher interface.
10. Resolved: resumed workers wait for new instructions, even with unfinished previous work.
11. Which lifecycle tools are required: stop/resume one worker, stop/resume all, list workers, remove an entry?
12. Resolved: workers do not stop themselves; stopping a worker and its running Pi session requires an explicit coordinator call to its extension.
13. Superseded by explicit-recovery principle: report resume failure, preserve the config entry, and let the coordinator agent decide what to do. No automatic replacement.
14. Deferred: V1 does not detect or prevent duplicate activation of the same Pi session. See Future optimizations.
15. Partially resolved: workers continue assigned work and peer communication while the coordinator is unavailable. Reconnect/retry behavior remains open; the shared reporting function can be triggered by a worker tool or coordinator control message.
16. Role resolution is based on the current Pi session ID and shared config. Unknown IDs (including forks) register as new workers and wait; known IDs restore their configured role. Exact lifecycle resource cleanup remains an implementation detail.

### Messaging and execution

17. What is the minimal message vocabulary? Candidate types: registration, port update, config reload, prompt, information, status query, status. These are not finalized.
18. Resolved: inject incoming prompts as steering when busy, and start a normal turn when idle.
19. Resolved: findings start a normal turn if idle and steer if busy; use within existing assignment, without authorizing unrelated implementation.
20. Resolved: extension-only status reports include a busy flag. Detailed progress is requested through a separate agent prompt, steered into ongoing work when busy.
21. Resolved: report send failure to the calling agent once the attempt fails or times out; no automatic retries in V1.
22. Deferred: add logging after the basic system is working. Storage location, format, and Git-ignore policy can be decided then.
23. Are message IDs, optional correlation references, deduplication, and delivery acknowledgments required? None should impose request/reply semantics.
24. Resolved: every message includes the intended recipient session ID; the receiving extension rejects mismatches.
25. Resolved: label agent messages with sender and purpose; receiving findings does not itself authorize new implementation work.

### Tools, permissions, and security

26. Finalize the tools, their arguments, and a coordinator/worker permission matrix. See agreed tool sections above, including intercom_set_multiplexer.
27. Resolved: enforce worker read-only config access within the extension only, including its internal operations. Do not block ordinary Pi file/shell tools; this is not an OS security boundary.
28. Resolved: localhost-only endpoints, no authentication at this time.
29. Resolved: coordinator readiness does not trigger an agent turn; remain ready for user input. Worker config readiness likewise does not trigger work. Exact notification rendering is an implementation detail.

## 3. Future optimizations

### Additional operating systems

- V1 targets Windows; support for other operating systems is deferred.
- Keep platform-specific terminal launching behind the launcher interface.

### Message logging

- Add durable communication logging after the basic system is working, not as a prerequisite for the initial implementation.
- Decide storage format, location, retention, and Git-ignore policy at that point.
- Logging does not imply automatic retries or a durable delivery queue.

### Duplicate-session detection

- Explicitly out of scope for V1: detecting or preventing multiple running extension instances using the same Pi session ID.
- Consider a local session-ID lock with stale-lock recovery in a future version.
- Pi context identifies the current session; it is not a cross-process running-session registry.
- This would guard Intercom activation, not prevent Pi itself from opening the same session twice.

## 4. Technical notes to verify during implementation

- Pi supports loading an extension explicitly with `-e` for a new process.
- Already-running sessions need the extension discoverable/configured and a supported reload path; an unloaded extension cannot invoke its own tools.
- Session ID can be obtained through the extension session context. Confirm precise resume command behavior and session lookup before implementing the launcher.
- Persistent sockets and processes should be started at session startup or explicit activation, not unconditionally in the extension factory; cleanup must follow Pi's lifecycle.
- Consult installed Pi documentation and Herdr skills before implementation. No extension code or launcher integration has been implemented as part of this discussion.
