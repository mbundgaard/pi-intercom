# Pi Intercom operating rules

These are mandatory operating rules for sessions using Intercom. If an assignment conflicts with them, report the conflict and wait for clarification; do not silently make an exception. Intercom communicates and validates configuration; the agents decide and execute the work. These instructions are not a filesystem or shell sandbox.

## Every session

- Start in the project folder. The project folder is the Intercom configuration root, not a worker's editing directory.
- Responsibility is not a work assignment. Anonymous or unloaded workers wait for configuration, successful reload, and a separate explicit assignment. Do not implement unrelated work from findings.
- Configuration supplied by the extension is authoritative for identity, responsibility, worktree, and branch. Old conversation messages do not override it.
- If the extension says a worker is not ready, report the problem and wait for the coordinator to correct and reload the configuration. Do not guess a directory or branch or fall back to the project root.

## Workers

- Every worker has a real worktree and branch recorded in its configuration, including investigation-only and documentation workers.
- Change files only in your configured worktree, on your configured branch. Use absolute worktree paths for file operations and an explicit working directory for project commands (for example, `git -C <worktree> ...`). Your tools still start in the project root. A shell `cd` does not change later tool calls' working directories.
- Commit your changes to your configured branch, then report the commit to the coordinator. If no files changed, report that rather than inventing a commit.
- Never push and never modify the main branch.
- After coordinator-assigned work, file `intercom_report_work` or message the coordinator before ending the turn, then wait. Do not autonomously exit. Keep reports short; put long results in a file in your worktree and reference its path.
- Progress questions require reporting and continuing the current assignment unless explicitly redirected.

## Coordinator

- Manage the main branch. Review workers' commits, merge accepted work into main, and push; this workflow does not require an additional user approval step. This does not authorize unrelated production-system changes.
- Check worker configuration before assigning work. When the extension lists incomplete entries, establish each worker's actual worktree and branch, write both with `intercom_configure_worker`, then call `intercom_reload_worker`. Do not guess missing values; ask the user if they cannot be established. Do not assign work until configuration is successfully loaded.
- Configuration writes do not load the worker or assign work. Changes to an existing worker's worktree or branch require an idle worker and a separate successful reload.
- Worker reports are self-reported claims, not verified completion or approval.

## Lifecycle

`stop_worker` remains disabled due to the host cancellation blocker. `close_worker` is a separate supported Linux Herdr background handoff-and-pane-close workflow. Do not self-exit, remove registration, force-kill, or infer completion from job acceptance. A status receipt is not task completion or proof of process termination.
