import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { validateConfig, type Config } from './config.js';
import { readWorkerReports, type WorkerReport } from './reports.js';
import type { WorkerConnection } from './connections.js';
import { validateHandoff, validateCloseJob, type Handoff, type CloseJob } from './handoff.js';
import { LOG_DIRECTORY, LOG_FILE_PATTERN, sanitizeObservation, type Observation } from './observability.js';

const CONFIG_BYTES = 1024 * 1024, TAIL_BYTES = 128 * 1024, TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 32, MAX_ENTRIES = 512, MAX_EVENTS = 500, MAX_AGENTS = 256;
export interface ObservationSnapshot {
  version: 1;
  generatedAt: string;
  staleAfterMs: number;
  config: Pick<Config, 'multiplexer' | 'agents'> | null;
  events: Observation[];
  reports?: WorkerReport[];
  /** Ephemeral explicit health checks; never persisted or inferred from activity logs. */
  connections?: WorkerConnection[];
  truncated: boolean;
  errors: string[];
}

/** Public saved context only; reject malformed/private protocol metadata. */
export function publicCloseMetadata(agent: { handoff?: unknown; closeJob?: unknown }): { handoff?: Handoff; closeJob?: CloseJob } {
  const result: { handoff?: Handoff; closeJob?: CloseJob } = {};
  try {
    if (agent.handoff !== undefined) {
      validateHandoff(agent.handoff);
      const { version, summary, updatedAt, jobId } = agent.handoff;
      result.handoff = { version, summary, updatedAt, jobId };
    }
  } catch { /* Invalid optional context is not public evidence. */ }
  try {
    if (agent.closeJob !== undefined) {
      validateCloseJob(agent.closeJob);
      const { jobId, state, createdAt, updatedAt, deadlineAt, reason } = agent.closeJob;
      result.closeJob = { jobId, state, createdAt, updatedAt, deadlineAt, ...(reason ? { reason } : {}) };
    }
  } catch { /* Never expose arbitrary errors or private protocol fields. */ }
  return result;
}

// Only fixed, extension-owned paths are read. Reject symlink/junction components
// rather than allowing a local log/config link to expose an unrelated file.
async function confined(root: string, relative: string): Promise<string> {
  const base = await realpath(root);
  let current = base;
  for (const segment of relative.split(/[\\/]/)) {
    if (!segment || segment === '.' || segment === '..') throw new Error('invalid path');
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('linked path');
    if (path.relative(current, await realpath(current)) !== '') throw new Error('redirected path');
  }
  return current;
}

async function boundedRead(file: string, limit: number, tail = false): Promise<{ text: string; truncated: boolean; bytes: number }> {
  if (!(await lstat(file)).isFile()) throw new Error('not a file');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('not a file');
    if (!tail && stat.size > limit) throw new Error('file too large');
    const size = Math.min(stat.size, limit), start = tail ? Math.max(0, stat.size - size) : 0;
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    // Drop potentially partial UTF-8/JSON at both tail boundaries. Writers append
    // complete newline-terminated records; incomplete records are not evidence.
    if (tail) {
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      text = text.slice(0, text.lastIndexOf('\n') + 1);
    }
    return { text, truncated: stat.size > limit, bytes: bytesRead };
  } finally { await handle.close(); }
}

/** Bounded, sanitized local evidence, independent of any UI or HTTP server. */
export async function readObservationSnapshot(root: string): Promise<ObservationSnapshot> {
  const result: ObservationSnapshot = { version: 1, generatedAt: new Date().toISOString(), staleAfterMs: 60000, config: null, events: [], truncated: false, errors: [] };
  try {
    const file = await confined(root, '.pi-intercom/config.json');
    const config = validateConfig(JSON.parse((await boundedRead(file, CONFIG_BYTES)).text));
    result.truncated ||= config.agents.length > MAX_AGENTS;
    result.config = { multiplexer: config.multiplexer, agents: config.agents.slice(0, MAX_AGENTS).map(a => ({
      sessionId: a.sessionId, name: a.name, coordinator: a.coordinator, description: a.description,
      projectDirectory: a.projectDirectory, port: a.port,
      ...(!a.coordinator ? { worktree: a.worktree, branch: a.branch } : {}), ...publicCloseMetadata(a),
    })) };
  } catch { result.errors.push('config_unavailable'); }
  try {
    const directory = await confined(root, LOG_DIRECTORY);
    const files: { name: string; modified: number }[] = [];
    const entries = await opendir(directory);
    let scanned = 0;
    for await (const entry of entries) {
      if (++scanned > MAX_ENTRIES) { result.truncated = true; break; }
      if (!entry.isFile() || !LOG_FILE_PATTERN.test(entry.name)) continue;
      try {
        const file = await confined(root, `${LOG_DIRECTORY}/${entry.name}`);
        files.push({ name: entry.name, modified: (await lstat(file)).mtimeMs });
      } catch { /* Rotations can remove a file while scanning. */ }
    }
    files.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
    result.truncated ||= files.length > MAX_FILES;
    let budget = TOTAL_BYTES;
    for (const file of files.slice(0, MAX_FILES)) {
      if (budget <= 0) { result.truncated = true; break; }
      try {
        const resolved = await confined(root, `${LOG_DIRECTORY}/${file.name}`);
        const read = await boundedRead(resolved, Math.min(TAIL_BYTES, budget), true);
        budget -= read.bytes;
        result.truncated ||= read.truncated;
        for (const line of read.text.split('\n')) {
          if (!line) continue;
          try {
            const event = sanitizeObservation(JSON.parse(line));
            if (event) result.events.push(event);
          } catch { /* Ignore malformed/partial/foreign records, never expose raw data. */ }
        }
      } catch { if (!result.errors.includes('log_read_failed')) result.errors.push('log_read_failed'); }
    }
    result.events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (result.events.length > MAX_EVENTS) { result.events = result.events.slice(-MAX_EVENTS); result.truncated = true; }
  } catch { result.errors.push('logs_unavailable'); }
  result.reports = result.config
    ? await readWorkerReports(root, result.config.agents.filter(agent => !agent.coordinator).map(agent => agent.sessionId))
    : [];
  return result;
}
