import path from 'node:path';
import type { ActivityPhase, ActivityDetail } from './activity.js';
import { randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, opendir, rename, stat, unlink } from 'node:fs/promises';

export const LOG_DIRECTORY = '.pi-intercom/logs';
export const LOG_FILE_PATTERN = /^writer-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl(?:\.[12]|\.closed)?$/;
export const LOG_LIMITS = { fileBytes: 1024 * 1024, filesPerInstance: 3, queueEntries: 256, entryBytes: 4096, retentionMs: 7 * 24 * 60 * 60 * 1000, directoryBytes: 32 * 1024 * 1024, scanEntries: 4096, closeTimeoutMs: 250 } as const;
export const EVENT_TYPES = ['runtime.starting', 'runtime.ready', 'runtime.closed', 'runtime.failed', 'config.changed', 'config.reloaded', 'transport.send', 'transport.receipt', 'transport.failed', 'transport.received', 'transport.rejected', 'registration.received', 'status.received', 'launch.result', 'host.submission', 'host.activity', 'host.ui_prompt'] as const;
export type EventType = typeof EVENT_TYPES[number];
const OUTCOMES = ['attempted', 'returned', 'failed', 'http_receipt', 'handler_failed', 'started', 'settled', 'snapshot', 'ended', 'written', 'removed', 'ready'] as const;
const ERROR_CODES = ['operation_failed', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EADDRINUSE', 'EACCES', 'EPERM', 'ENOENT', 'ENOSPC'] as const;
const KINDS = ['message', 'report', 'registration', 'status', 'idle', 'request_status', 'reload', 'stop', 'close', 'close_prepare', 'close_identity', 'close_request', 'handoff_report', 'close_ready', 'close_commit'] as const;
const OPERATIONS = ['configure_worker', 'set_multiplexer', 'remove_worker', 'create_worker', 'resume_worker', 'port_update', 'initialize'] as const;
export interface EventMetadata {
  peerSessionId?: string;
  peerName?: string;
  correlationId?: string;
  kind?: typeof KINDS[number];
  busy?: boolean;
  phase?: ActivityPhase;
  detail?: ActivityDetail;
  port?: number;
  role?: 'coordinator' | 'worker' | 'anonymous';
  outcome?: typeof OUTCOMES[number];
  errorCode?: typeof ERROR_CODES[number];
  operation?: typeof OPERATIONS[number];
}
export interface Observation extends EventMetadata {
  version: 1;
  timestamp: string;
  /** Log-file writer identity only: never a transport or agent identity. */
  writerId: string;
  sessionId: string;
  event: EventType;
}
export interface Observer { record(event: EventType, metadata?: EventMetadata): void; close(): Promise<void>; maintain?(): void }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function safeText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function includes<T extends string>(list: readonly T[], value: unknown): value is T { return typeof value === 'string' && list.includes(value as T); }
/** Project only explicitly allowed metadata, including when reading untrusted on-disk logs. */
export function sanitizeObservation(value: unknown): Observation | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !includes(EVENT_TYPES, v.event) || !safeText(v.sessionId, 256) || typeof v.writerId !== 'string' || !uuid.test(v.writerId)) return;
  if (typeof v.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.timestamp) || !Number.isFinite(Date.parse(v.timestamp))) return;
  const result: Observation = { version: 1, timestamp: v.timestamp, writerId: v.writerId, sessionId: v.sessionId, event: v.event };
  if (safeText(v.peerSessionId, 256)) result.peerSessionId = v.peerSessionId;
  if (safeText(v.peerName, 128)) result.peerName = v.peerName;
  if (safeText(v.correlationId, 128) && /^[a-zA-Z0-9-]+$/.test(v.correlationId)) result.correlationId = v.correlationId;
  if (includes(KINDS, v.kind)) result.kind = v.kind;
  if (typeof v.busy === 'boolean') result.busy = v.busy;
  if (includes(['working', 'thinking', 'responding', 'tool', 'idle'], v.phase)) result.phase = v.phase;
  if (includes(['processing', 'thinking', 'responding', 'reading_files', 'editing_files', 'running_command', 'using_tool', 'multiple_tools', 'settled'], v.detail)) result.detail = v.detail;
  if (Number.isInteger(v.port) && Number(v.port) >= 1 && Number(v.port) <= 65535) result.port = Number(v.port);
  if (includes(['coordinator', 'worker', 'anonymous'], v.role)) result.role = v.role;
  if (includes(OUTCOMES, v.outcome)) result.outcome = v.outcome;
  if (includes(ERROR_CODES, v.errorCode)) result.errorCode = v.errorCode;
  if (includes(OPERATIONS, v.operation)) result.operation = v.operation;
  return result;
}
/** Never inspect error.message/stack, response bodies, paths, or arbitrary error codes. */
export function observationError(error: unknown): EventMetadata['errorCode'] {
  try {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    return includes(ERROR_CODES, code) ? code : 'operation_failed';
  } catch { return 'operation_failed'; }
}
export class LocalObserver implements Observer {
  readonly writerId = randomUUID();
  readonly directory: string;
  readonly file: string;
  private queue: string[] = [];
  private pending?: Promise<void>;
  private initialized = false;
  private bytes = 0;
  private closed = false;
  private disabled = false;
  private maintenance = false;
  private timer?: ReturnType<typeof setInterval>;
  dropped = 0;
  constructor(root: string, readonly sessionId: string, private readonly limits: { fileBytes?: number; queueEntries?: number } = {}) {
    this.directory = path.join(root, LOG_DIRECTORY);
    this.file = path.join(this.directory, `writer-${this.writerId}.jsonl`);
  }
  record(event: EventType, metadata: EventMetadata = {}): void {
    try {
      if (this.closed || this.disabled) return;
      const observation = sanitizeObservation({ ...metadata, version: 1, timestamp: new Date().toISOString(), writerId: this.writerId, sessionId: this.sessionId, event });
      if (!observation) return;
      const line = JSON.stringify(observation) + '\n';
      const capacity = Math.max(1, Math.min(LOG_LIMITS.queueEntries, this.limits.queueEntries ?? LOG_LIMITS.queueEntries));
      if (Buffer.byteLength(line) > LOG_LIMITS.entryBytes || this.queue.length >= capacity) { this.dropped++; return; }
      this.queue.push(line);
      this.schedule();
    } catch { /* Observability must never throw into communication. */ }
  }
  private schedule(): void {
    if (this.pending || this.disabled) return;
    this.pending = Promise.resolve().then(() => this.drain()).catch(() => {
      // Disable this writer after an I/O failure; no retry queue and no communication failure.
      this.disabled = true; this.dropped += this.queue.length; this.queue = [];
    }).finally(() => {
      this.pending = undefined;
      if (this.queue.length && !this.disabled) this.schedule();
    });
  }
  /** Runtime calls only on the coordinator. No process probes or activity inference. */
  maintain(): void {
    if (this.closed || this.disabled || this.timer) return;
    const request = () => { this.maintenance = true; this.schedule(); };
    this.timer = setInterval(request, 60_000); this.timer.unref(); request();
  }
  protected append(file: string, line: string): Promise<void> { return appendFile(file, line, { encoding: 'utf8', mode: 0o600 }); }
  private async prune(): Promise<void> {
    const files: { file: string; base: string; mtime: number; bytes: number }[] = [];
    const closed = new Set<string>();
    let scanned = 0;
    for await (const entry of await opendir(this.directory)) {
      if (++scanned > LOG_LIMITS.scanEntries) break;
      if (!entry.isFile() || !LOG_FILE_PATTERN.test(entry.name)) continue;
      const file = path.join(this.directory, entry.name);
      const base = file.replace(/\.(?:closed|[12])$/, '');
      if (file.endsWith('.closed')) closed.add(base);
      const info = await stat(file).catch(() => undefined);
      if (info) files.push({ file, base, mtime: info.mtimeMs, bytes: info.size });
    }
    let total = files.reduce((sum, file) => sum + file.bytes, 0);
    const groups = [...closed].map(base => {
      const members = files.filter(file => file.base === base);
      return { members, newest: Math.max(...members.map(file => file.mtime)) };
    }).sort((a, b) => a.newest - b.newest);
    for (const group of groups) {
      // Only gracefully closed writer groups are eligible. Active/crashed writers stay untouched.
      if (Date.now() - group.newest > LOG_LIMITS.retentionMs || total > LOG_LIMITS.directoryBytes) {
        // Remove the closed marker last, retaining eligibility if an earlier unlink fails.
        for (const file of group.members.sort((a, b) => Number(a.file.endsWith('.closed')) - Number(b.file.endsWith('.closed')))) {
          try { await unlink(file.file); total -= file.bytes; } catch { break; }
        }
      }
    }
  }
  private async drain(): Promise<void> {
    if (!this.initialized) {
      const parent = path.dirname(this.directory);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      if ((await lstat(parent)).isSymbolicLink()) throw new Error('log parent must not be a symlink');
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if ((await lstat(this.directory)).isSymbolicLink()) throw new Error('log directory must not be a symlink');
      this.initialized = true;
    }
    if (this.maintenance) { this.maintenance = false; await this.prune().catch(() => {}); }
    const maxBytes = Math.max(LOG_LIMITS.entryBytes, Math.min(LOG_LIMITS.fileBytes, this.limits.fileBytes ?? LOG_LIMITS.fileBytes));
    while (this.queue.length) {
      const line = this.queue.shift()!, size = Buffer.byteLength(line);
      if (this.bytes + size > maxBytes) {
        await unlink(`${this.file}.2`).catch(e => { if (e.code !== 'ENOENT') throw e; });
        await rename(`${this.file}.1`, `${this.file}.2`).catch(e => { if (e.code !== 'ENOENT') throw e; });
        await rename(this.file, `${this.file}.1`).catch(e => { if (e.code !== 'ENOENT') throw e; });
        this.bytes = 0;
      }
      await this.append(this.file, line); this.bytes += size;
    }
  }
  async close(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.closed = true;
    while (this.pending) await this.pending;
    // An atomic suffix change is the sole inactive-writer signal. Crashes leave no such signal.
    if (this.initialized && !this.disabled) await rename(this.file, `${this.file}.closed`).catch(() => {});
  }
}
