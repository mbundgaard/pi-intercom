import { stripVTControlCharacters } from 'node:util';
import { truncateToWidth, visibleWidth } from 'pi-intercom-tui';
import { publicCloseMetadata, type ObservationSnapshot } from './snapshot.js';
import { workerObservation } from './worker-status.js';
import { currentConnection, sortWorkersByConnection } from './connections.js';
import { INTERCOM_VERSION } from './version.js';

const safe = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, ' ');
const clip = (value: string, width: number) => stripVTControlCharacters(truncateToWidth(safe(value), Math.max(0, width)));
const cell = (value: string, width: number) => {
  const text = clip(value, width);
  return text + ' '.repeat(Math.max(0, width - visibleWidth(text)));
};
const ageLabel = (milliseconds: number) => {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

const reportLabels: Record<string, string> = {
  blocked: 'Blocked', needs_decision: 'Needs decision', ready_for_review: 'Ready for review',
};
// Wrap only sanitized grapheme clusters, bounded by the terminal's remaining rows.
function wrapSummary(value: string, width: number, rows: number): string[] {
  if (width <= 0 || rows <= 0) return [];
  const result: string[] = [];
  let current = '';
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(safe(value))) {
    if (visibleWidth(current + segment) > width) {
      if (current) result.push(current);
      current = '';
      if (result.length >= rows) break;
    }
    current += visibleWidth(segment) <= width ? segment : clip(segment, width);
  }
  if (current && result.length < rows) result.push(current);
  return result;
}

/** Presentation only. All user-controlled text is sanitized before trusted ANSI styling. */
export function renderMonitor(snapshot: ObservationSnapshot | undefined, width: number, height: number,
  now = Date.now(), color = false, options: { selectedIndex?: number; details?: boolean } = {}): string[] {
  width = Math.max(0, Math.min(1000, Math.floor(width)));
  height = Math.max(0, Math.min(1000, Math.floor(height)));
  if (!width || !height) return [];
  const paint = (code: string, text: string) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const dim = (text: string) => paint('90', text);
  const line = (text: string) => clip(text, width);
  const lines: string[] = [];
  if (!snapshot?.config) {
    lines.push(paint('33', line('  Status unavailable — waiting for local observations')));
  } else {
    const workers = sortWorkersByConnection(snapshot.config.agents.filter(agent => !agent.coordinator), snapshot.connections, now);
    // Connection is independent of historical activity and public reports.
    const wide = width >= 100;
    const nameWidth = wide ? Math.min(22, Math.max(10, width - 100)) : Math.max(1, Math.min(10, width - 16));
    const activityWidth = 8, ageWidth = 16, reportWidth = 16;
    const table = (name: string, connection: string, activity: string, age: string, detail: string, report = '—', tone = '90', selected = false) => {
      const prefix = `${selected ? '› ' : '  '}${cell(name, nameWidth)}  `;
      const status = cell(connection, 12);
      const tail = `  ${cell(report, reportWidth)}  ${cell(activity, activityWidth)}${width >= 78 ? `  ${cell(age, ageWidth)}` : ''}${wide ? `  ${detail}` : ''}`;
      // Clip each lower-priority section independently so a truncated tail never
      // steals space from a fully fitting connection label. Styling is trusted.
      const namePart = clip(prefix, width);
      const statusRoom = Math.max(0, width - visibleWidth(namePart));
      const statusPart = clip(status, statusRoom);
      const tailRoom = Math.max(0, statusRoom - visibleWidth(statusPart));
      return (selected ? paint('1;36', namePart) : namePart) + paint(tone, statusPart) + dim(clip(tail, tailRoom));
    };
    lines.push(paint('1', table('Worker', 'Connection', 'Activity', 'Seen', 'Last activity', 'Report')));
    lines.push(dim(line('  ' + '─'.repeat(Math.max(0, width - 2)))));
    const selectedIndex = Math.min(workers.length - 1, Math.max(-1, options.selectedIndex ?? -1));
    const showDetails = Boolean(options.details && selectedIndex >= 0 && height >= 8);
    const selectedReport = snapshot.reports?.find(report => report.sessionId === workers[selectedIndex]?.sessionId && reportLabels[report.status]);
    const selectedSaved = workers[selectedIndex] ? publicCloseMetadata(workers[selectedIndex]) : {};
    const hasSaved = !!(selectedSaved.handoff || selectedSaved.closeJob);
    const detailBudget = showDetails ? Math.min(hasSaved ? 22 : selectedReport ? 15 : 8, height - 5) : 0;
    const available = Math.max(0, height - lines.length - 2 - detailBudget);
    const needsOverflow = workers.length > available;
    const count = Math.min(workers.length, Math.max(0, available - (needsOverflow && available > 1 ? 1 : 0)));
    const start = Math.max(0, Math.min(Math.max(0, workers.length - count), selectedIndex - count + 1));
    let selectedDetail: string[] = [];
    for (const [offset, worker] of workers.slice(start, start + count).entries()) {
      const observation = workerObservation(snapshot, worker.sessionId, now);
      const activity = observation.observedStatus, evidence = observation.lastActivity;
      const age = observation.observationAgeSeconds === null ? '—' : ageLabel(observation.observationAgeSeconds * 1000) + (observation.stale ? ' (old)' : '');
      const connection = currentConnection(worker.sessionId, snapshot.connections, now);
      const tone = connection.state === 'disconnected' ? '33' : connection.state === 'connected' ? '32' : '90';
      const checkedAge = connection.checkedAt ? now - Date.parse(connection.checkedAt) : NaN;
      const connectionDetails = [
        line(`  Connection: ${connection.state} · ${connection.reason}`),
        line(`  Checked: ${connection.checkedAt ?? 'never'} · ${Number.isFinite(checkedAge) && checkedAge >= 0 ? ageLabel(checkedAge) : 'age unknown'}`),
      ];
      const workspaceDetails = [
        line(`  Worktree: ${worker.worktree || 'Missing — reconfigure worker'}`),
        line(`  Branch: ${worker.branch || 'Missing — reconfigure worker'}`),
      ];
      const selected = start + offset === selectedIndex;
      const report = snapshot.reports?.find(report => report.sessionId === worker.sessionId && reportLabels[report.status]);
      lines.push(table(worker.name, connection.state, activity, age, evidence, report ? reportLabels[report.status] : '—', tone, selected));
      if (selected && showDetails && hasSaved) {
        const savedAge = (timestamp: string) => {
          const elapsed = now - Date.parse(timestamp);
          return elapsed < 0 || !Number.isFinite(elapsed) ? 'clock uncertain' : ageLabel(elapsed) + (elapsed > snapshot.staleAfterMs ? ' (old)' : '');
        };
        const { handoff, closeJob } = selectedSaved;
        const context = [
          ...(closeJob ? [line(`  Close workflow: ${closeJob.state}${closeJob.reason ? ` · ${closeJob.reason}` : ''} · ${savedAge(closeJob.updatedAt)}`)] : []),
          line(handoff ? `  Saved handoff (public): ${savedAge(handoff.updatedAt)}` : '  Saved handoff: none'),
        ];
        selectedDetail = [
          ...context,
          ...(handoff ? wrapSummary(`Handoff: ${handoff.summary}`, Math.max(0, width - 2), Math.min(4, Math.max(0, detailBudget - context.length))).map(text => line(`  ${text}`)) : []),
          ...(handoff ? [line(`  Handoff saved: ${handoff.updatedAt}`)] : []),
          ...(report ? [
            line(`  Report: ${reportLabels[report.status]} · ${savedAge(report.updatedAt)}`),
            line('  Self-reported, pending review'),
            ...wrapSummary(`Summary: ${report.summary}`, Math.max(0, width - 2), 2).map(text => line(`  ${text}`)),
          ] : []),
          ...connectionDetails,
          line(`  Responsibility: ${worker.description || 'Not specified'}`),
          ...workspaceDetails,
          line(`  Observed status: ${activity} · ${age}`),
          line(`  Last activity: ${evidence}`),
          ...(closeJob ? [line(`  Close updated: ${closeJob.updatedAt}`), line('  Workflow state is not proof all child processes terminated')] : []),
        ];
      } else if (selected && showDetails && report) {
        const elapsed = now - Date.parse(report.updatedAt);
        const reportAge = !Number.isFinite(elapsed) || elapsed < 0 ? 'clock uncertain' : ageLabel(elapsed) + (elapsed > snapshot.staleAfterMs ? ' (old)' : '');
        const contextRows = detailBudget >= 11 ? [
          paint('1', line(`  ${worker.name}`)),
          ...connectionDetails,
          line(`  Responsibility: ${worker.description || 'Not specified'}`),
          ...workspaceDetails,
          line(`  Observed status: ${activity} · ${age}`),
          ...(detailBudget >= 12 ? [line(`  Last activity: ${evidence}`)] : []),
        ] : [];
        selectedDetail = [
          ...contextRows,
          line(`  Report: ${reportLabels[report.status]} · ${reportAge}`),
          line('  Self-reported, pending review'),
          ...wrapSummary(`Summary: ${report.summary}`, Math.max(0, width - 2), Math.max(0, detailBudget - 2 - contextRows.length)).map(text => line(`  ${text}`)),
        ];
      } else if (selected && showDetails) selectedDetail = [
        ...connectionDetails,
        line(`  Responsibility: ${worker.description || 'Not specified'}`),
        ...workspaceDetails,
        line(`  Observed status: ${activity} · ${age}`),
        line(`  Last activity: ${evidence}`),
      ];
    }
    if (workers.length > count && available > count) lines.push(dim(line(`  ${workers.length - count} more · rows ${count ? start + 1 : 0}–${start + count} of ${workers.length} · ↑↓ to browse`)));
    lines.push(...selectedDetail.slice(0, detailBudget));
    if (!workers.length && available) lines.push(dim(line('  No workers configured yet')));
  }
  // Anchor the hint at the bottom; do not fill the pane with decorative boxes.
  const partial = snapshot && (snapshot.truncated || snapshot.errors.length);
  const controls = options.details ? 'q quit · Esc back · ↑↓ select' : 'q quit · ↑↓ select · Enter details';
  const hasReports = snapshot?.reports?.some(report => reportLabels[report.status] && snapshot.config?.agents.some(agent => !agent.coordinator && agent.sessionId === report.sessionId));
  const version = `v${safe(INTERCOM_VERSION)}`;
  const fullVersion = `Intercom ${version}`;
  const label = width >= visibleWidth(controls) + visibleWidth(fullVersion) + 4 ? fullVersion : version;
  const room = width - visibleWidth(label) - 2;
  let footer = width < 6 ? 'q' : 'q quit';
  if (room >= 6) {
    const compactControls = options.details ? 'q quit · Esc · ↑↓' : 'q quit · ↑↓ · Enter';
    const prefix = room >= 8 ? '  ' : '';
    const available = room - prefix.length;
    const hint = visibleWidth(controls) <= available ? controls : visibleWidth(compactControls) <= available ? compactControls : 'q quit';
    const caveats = `${partial ? ' · Partial observations' : ''}${hasReports ? ' · Reports: self-reported, pending review' : ''}`;
    // Lower-priority caveats may truncate, but never consume the quit hint or
    // the reserved version label. Keep the version flush with the right edge.
    const left = prefix + hint + clip(caveats, Math.max(0, available - visibleWidth(hint)));
    footer = left + ' '.repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(label))) + label;
  }
  lines.splice(Math.max(0, height - 1));
  while (lines.length < height - 1) lines.push('');
  lines.push(dim(line(footer)));
  return lines.slice(0, height);
}
