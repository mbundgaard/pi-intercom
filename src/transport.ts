import http from 'node:http';
import { fail, port, text } from './config.js';
import type { ReportStatus } from './reports.js';
import { HANDOFF_KINDS, validateHandoffPayload, type HandoffKind } from './handoff.js';

export const BODY_LIMIT = 64 * 1024;
export const RECEIPT_TIMEOUT = 5000;
export type Kind = 'message' | 'report' | 'registration' | 'status' | 'idle' | 'request_status' | 'reload' | 'stop' | 'close' | HandoffKind;
export interface Envelope {
  version: 1;
  kind: Kind;
  from: string;
  to: string;
  payload: Record<string, unknown>;
  /** Optional diagnostics correlation only; never authentication or agent identity. */
  correlationId?: string;
}
export function reportPayload(payload: Record<string, unknown>): { status: ReportStatus; summary: string } {
  if (!['blocked', 'needs_decision', 'ready_for_review', 'clear'].includes(payload.status as string)) fail('invalid report status');
  const status = payload.status as ReportStatus;
  const summary = payload.summary ?? '';
  if (typeof summary !== 'string' || summary.length > 2000 || (status !== 'clear' && !summary.trim()) || (status === 'clear' && summary !== '')) fail('report requires a public summary of 1–2000 characters, or empty summary for clear');
  return { status, summary };
}
export function envelope(value: unknown): Envelope {
  const m = value as Envelope;
  if (!m || m.version !== 1 || !['message', 'report', 'registration', 'status', 'idle', 'request_status', 'reload', 'stop', 'close', ...HANDOFF_KINDS].includes(m.kind)) fail('invalid wire schema/version/kind');
  text(m.from, 'sender sessionId', 256); text(m.to, 'recipient sessionId', 256);
  if (m.correlationId !== undefined && (typeof m.correlationId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(m.correlationId))) fail('invalid correlation ID');
  if (!m.payload || Array.isArray(m.payload) || typeof m.payload !== 'object') fail('invalid payload');
  if (m.kind === 'message') text(m.payload.message, 'message', 48000);
  if (m.kind === 'report') reportPayload(m.payload);
  if (HANDOFF_KINDS.includes(m.kind)) validateHandoffPayload(m.kind, m.payload);
  if (m.kind === 'registration' || m.kind === 'status') port(m.payload.port);
  if (m.kind === 'registration') text(m.payload.projectDirectory, 'projectDirectory');
  if (m.kind === 'status' && typeof m.payload.busy !== 'boolean') fail('invalid busy flag');
  return m;
}
export interface Endpoint { port: number; close(): Promise<void> }
export async function listen(preferred: number | undefined, accept: (message: Envelope) => Promise<void>, health?: () => { version: 1; sessionId: string }): Promise<Endpoint> {
  const server = http.createServer(async (req, res) => {
    const reply = (status: number, data: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json', connection: 'close' }); res.end(JSON.stringify(data)); } };
    if (req.method === 'GET' && req.url === '/intercom/health') {
      try {
        if (!health) reply(404, { error: 'health unavailable' });
        else {
          const identity = health();
          if (identity.version !== 1 || typeof identity.sessionId !== 'string' || !identity.sessionId.trim() || identity.sessionId.length > 256) throw new Error('invalid health identity');
          reply(200, { version: 1, sessionId: identity.sessionId });
        }
      } catch { reply(503, { error: 'health unavailable' }); }
      req.resume(); return;
    }
    if (req.method !== 'POST' || req.url !== '/intercom') { reply(404, { error: 'POST /intercom required' }); req.resume(); return; }
    let bytes = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > BODY_LIMIT) { reply(413, { error: 'body exceeds 64 KiB' }); return; }
        chunks.push(Buffer.from(chunk));
      }
      await accept(envelope(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      reply(202, { accepted: true });
    } catch (error) { reply(400, { error: String(error) }); }
  });
  server.requestTimeout = RECEIPT_TIMEOUT;
  server.headersTimeout = RECEIPT_TIMEOUT;
  server.setTimeout(RECEIPT_TIMEOUT, socket => socket.destroy());
  const bind = (p: number) => new Promise<void>((resolve, reject) => {
    const error = (e: Error) => { server.off('listening', ready); reject(e); };
    const ready = () => { server.off('error', error); resolve(); };
    server.once('error', error); server.once('listening', ready); server.listen(p, '127.0.0.1');
  });
  try { await bind(preferred ?? 0); }
  catch (e) { if (preferred && (e as NodeJS.ErrnoException).code === 'EADDRINUSE') await bind(0); else throw e; }
  const address = server.address();
  if (!address || typeof address === 'string') fail('listener has no port');
  return { port: address.port, close: () => new Promise((resolve, reject) => {
    server.close(e => e ? reject(e) : resolve()); server.closeAllConnections();
  }) };
}
export async function send(destinationPort: number, message: Envelope, timeout = RECEIPT_TIMEOUT): Promise<void> {
  port(destinationPort); envelope(message);
  const body = JSON.stringify(message);
  if (Buffer.byteLength(body) > BODY_LIMIT) fail('message exceeds 64 KiB');
  // Node HTTP bypasses proxy environment variables; never redirects or retries.
  await new Promise<void>((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: destinationPort, path: '/intercom', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let result = '';
      res.on('data', chunk => { result += chunk; if (result.length > BODY_LIMIT) req.destroy(new Error('oversized acknowledgment')); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          if (res.statusCode !== 202 || JSON.parse(result).accepted !== true) fail(`receipt rejected (${res.statusCode}): ${result}`);
          resolve();
        } catch (e) { reject(e); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('PiIntercom: receipt timeout; outcome unknown; no automatic retry')), timeout);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject); req.end(body);
  });
}
