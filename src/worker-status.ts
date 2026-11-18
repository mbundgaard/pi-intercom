import { publicCloseMetadata, type ObservationSnapshot } from './snapshot.js';
import { currentConnection, sortWorkersByConnection } from './connections.js';

const labels: Record<string, string> = {
  processing: 'Processing', thinking: 'Thinking', responding: 'Writing response',
  reading_files: 'Reading files', editing_files: 'Editing files', running_command: 'Running command',
  using_tool: 'Using a tool', multiple_tools: 'Running multiple tools', settled: 'Turn settled',
};
export function workerObservation(snapshot: ObservationSnapshot, sessionId: string, now = Date.now()) {
  const events = snapshot.events.filter(e => e.sessionId === sessionId &&
    ['runtime.ready', 'host.activity', 'runtime.closed'].includes(e.event) &&
    (e.event === 'runtime.closed' || typeof e.busy === 'boolean') && Number.isFinite(Date.parse(e.timestamp)));
  const latest = events.reduce<(typeof events)[number] | undefined>((best, e) =>
    !best || Date.parse(e.timestamp) > Date.parse(best.timestamp) ? e : best, undefined);
  let observedStatus = 'unknown', lastActivity = 'no observation';
  let observationAgeSeconds: number | null = null, stale: boolean | null = null;
  let evidence = 'missing';
  if (latest) {
    const elapsed = now - Date.parse(latest.timestamp);
    if (elapsed < 0) { evidence = 'clock_uncertain'; lastActivity = 'clock uncertain'; }
    else {
      observationAgeSeconds = Math.floor(elapsed / 1000);
      stale = elapsed > snapshot.staleAfterMs;
      const ties = events.filter(e => e.timestamp === latest.timestamp);
      const conflict = ties.some(e => (e.event === 'runtime.closed') !== (latest.event === 'runtime.closed') || e.busy !== latest.busy || (e.phase && latest.phase && e.phase !== latest.phase));
      if (conflict) { evidence = 'conflicting'; lastActivity = 'conflicting records'; }
      else {
        evidence = stale ? 'stale' : 'recent';
        observedStatus = latest.event === 'runtime.closed' ? 'closed' : !latest.busy ? 'idle' : latest.phase === 'thinking' ? 'thinking' : 'working';
        const detail = events.filter(e => e.writerId === latest.writerId && e.detail && !['processing', 'settled'].includes(e.detail) && Date.parse(e.timestamp) <= Date.parse(latest.timestamp))
          .reduce<(typeof events)[number] | undefined>((best, e) => !best || e.timestamp > best.timestamp ? e : best, undefined);
        lastActivity = latest.event === 'runtime.closed' ? 'Runtime closed'
          : (detail?.detail ? labels[detail.detail] : latest.detail ? labels[latest.detail] : latest.busy ? 'Processing' : 'No active turn');
      }
    }
  }
  return { observedStatus, lastActivity, observedAt: latest?.timestamp ?? null, observationAgeSeconds, stale, evidence };
}

/** Bounded JSON data for agents/any presentation layer. No Telegram, UI, probing or model calls. */
export function workerStatusPage(snapshot: ObservationSnapshot, options: { name?: string; offset?: number; limit?: number } = {}, now = Date.now()) {
  const offset = options.offset ?? 0, limit = options.limit ?? 10;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid pagination: offset >= 0, limit 1–20');
  if (options.name !== undefined && (typeof options.name !== 'string' || !options.name.trim())) throw new Error('Worker name must be nonblank');
  let roster = snapshot.config?.agents.filter(a => !a.coordinator) ?? [];
  if (options.name !== undefined) {
    roster = roster.filter(a => a.name.toLowerCase() === options.name!.toLowerCase());
    if (snapshot.config && !roster.length) throw new Error('Worker name not found in the retained snapshot');
  }
  const workers: Array<{ sessionId: string; [key: string]: unknown }> = [];
  const result = { version: 1, source: 'local-observations', generatedAt: new Date(now).toISOString(),
    statusMeaning: 'Activity is last observed, not task completion. Connectivity is a separate endpoint check, never proof of termination. Reports are self-reported, not approval. Handoff is saved public context, not task completion; closeJob is workflow state, never proof that all child processes terminated.',
    truncated: snapshot.truncated, errors: snapshot.errors, totalInSnapshot: roster.length, offset,
    nextOffset: null as number | null, workers };
  for (const agent of roster.slice(offset, offset + limit)) {
    const report = snapshot.reports?.find(r => r.sessionId === agent.sessionId && r.status !== 'clear');
    const reportAge = report ? now - Date.parse(report.updatedAt) : NaN;
    const saved = publicCloseMetadata(agent);
    const ageSeconds = (timestamp: string) => {
      const age = now - Date.parse(timestamp);
      return Number.isFinite(age) && age >= 0 ? Math.floor(age / 1000) : null;
    };
    const entry = { sessionId: agent.sessionId, name: agent.name, description: agent.description,
      worktree: agent.worktree ?? null, branch: agent.branch ?? null,
      configuration: agent.worktree && agent.branch ? 'configured (not proof of loaded configuration)' : 'reconfiguration_required',
      ...workerObservation(snapshot, agent.sessionId, now),
      connection: currentConnection(agent.sessionId, snapshot.connections, now),
      handoff: saved.handoff ? { ...saved.handoff, ageSeconds: ageSeconds(saved.handoff.updatedAt), selfReported: true } : null,
      closeJob: saved.closeJob ? { ...saved.closeJob, ageSeconds: ageSeconds(saved.closeJob.updatedAt) } : null,
      report: report ? { status: report.status, summary: report.summary, updatedAt: report.updatedAt,
        ageSeconds: Number.isFinite(reportAge) && reportAge >= 0 ? Math.floor(reportAge / 1000) : null,
        selfReported: true } : null };
    workers.push(entry);
    if (Buffer.byteLength(JSON.stringify(result, null, 2)) > 40000) { workers.pop(); break; }
  }
  if (offset + workers.length < roster.length) result.nextOffset = offset + workers.length;
  // Page boundaries remain in saved roster order; disconnected entries sort last within the page.
  workers.splice(0, workers.length, ...sortWorkersByConnection(workers, snapshot.connections, now));
  return result;
}
