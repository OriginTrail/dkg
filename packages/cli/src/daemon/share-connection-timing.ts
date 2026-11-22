import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { isIPv4, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';

import { observeShareGc } from './share-gc-timing.js';

interface LoopTick {
  at: number;
  active: number;
  idle: number;
}

interface LoopTiming {
  windowMs: number;
  utilization: number | null;
  maxTimerOverdueMs: number;
  maxIntervalStartUnixMs: number;
  maxIntervalEndUnixMs: number;
  maxIntervalUtilization: number | null;
  maxIntervalStillOpen: boolean;
}

export interface ConnectionTiming {
  requestDispatchedAtUnixMs: number;
  connectionUse: 'first' | 'reused' | 'unobserved';
  connectionObservedAtUnixMs?: number;
  connectionToRequestMs?: number;
  connectionPortHash?: string;
  loopAtDispatch: LoopTiming;
}

type GcObserver = ReturnType<typeof observeShareGc>;
interface RequestRecord { timing: ConnectionTiming; gc: GcObserver; gcBeforeDispatch?: ReturnType<GcObserver['snapshot']> }
const requests = new WeakMap<IncomingMessage, RequestRecord>();
const SAMPLE_MS = 500;
const MAX_TICKS = 41; // About 20 seconds at the normal sampling rate; report the actual window.

function loopTick(): LoopTick {
  const { active, idle } = performance.eventLoopUtilization();
  return { at: performance.now(), active, idle };
}

function utilization(from: LoopTick, to: LoopTick): number | null {
  const active = to.active - from.active;
  const total = active + to.idle - from.idle;
  return total > 0 ? Math.round(Math.min(1, Math.max(0, active / total)) * 1000) / 1000 : null;
}

/** Include the open interval: an HTTP callback can run before a delayed timer gets its next turn. */
function recentLoopTiming(ticks: LoopTick[], current: LoopTick): LoopTiming {
  const first = ticks[0]!;
  let start = first;
  let end = first;
  for (let i = 1; i <= ticks.length; i++) {
    const previous = ticks[i - 1]!;
    const next = ticks[i] ?? current;
    if (next.at - previous.at >= end.at - start.at) {
      start = previous;
      end = next;
    }
  }
  return {
    windowMs: Math.round(current.at - first.at),
    utilization: utilization(first, current),
    maxTimerOverdueMs: Math.round(Math.max(0, end.at - start.at - SAMPLE_MS)),
    maxIntervalStartUnixMs: Math.round(performance.timeOrigin + start.at),
    maxIntervalEndUnixMs: Math.round(performance.timeOrigin + end.at),
    maxIntervalUtilization: utilization(start, end),
    maxIntervalStillOpen: end === current,
  };
}

/** Ephemeral port hashes are guessable. Use this field only to join bounded local observations. */
function localPortHash(socket: Socket): string | undefined {
  const address = socket.remoteAddress?.replace(/^::ffff:/i, '');
  const port = socket.remotePort;
  if (!address || !(address === '::1' || (isIPv4(address) && address.startsWith('127.'))) ||
      port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) return;
  return createHash('sha256').update(String(port), 'ascii').digest('hex');
}

/** These are JavaScript callbacks. Time in the kernel before Node dispatches one is invisible here. */
export function observeShareConnections(
  server: Server,
  readTick: () => LoopTick = loopTick,
  observeGc: () => GcObserver = observeShareGc,
): void {
  if (process.env.DKG_ASYNC_PROMOTE_ADMISSION_TRACE !== '1') return;
  const sockets = new WeakMap<Socket, { observed: number; used: boolean }>();
  const gc = observeGc();
  const ticks = [readTick()];
  const timer = setInterval(() => {
    if (ticks.length === MAX_TICKS) ticks.shift();
    ticks.push(readTick());
  }, SAMPLE_MS);
  timer.unref();

  function onConnection(socket: Socket): void {
    sockets.set(socket, { observed: performance.now(), used: false });
  }
  function onRequest(req: IncomingMessage): void {
    const socket = sockets.get(req.socket);
    const first = socket && !socket.used;
    if (socket) socket.used = true;
    // Count every ordinary HTTP request on the connection, including non-admission routes.
    if (req.method !== 'POST') return;
    const current = readTick();
    const timing: ConnectionTiming = {
      requestDispatchedAtUnixMs: Math.round(performance.timeOrigin + current.at),
      connectionUse: socket ? (first ? 'first' : 'reused') : 'unobserved',
      loopAtDispatch: recentLoopTiming(ticks, current),
    };
    const portHash = localPortHash(req.socket);
    if (portHash !== undefined) timing.connectionPortHash = portHash;
    if (socket && first) {
      timing.connectionObservedAtUnixMs = Math.round(performance.timeOrigin + socket.observed);
      timing.connectionToRequestMs = Math.round(current.at - socket.observed);
    }
    const record: RequestRecord = { timing, gc };
    requests.set(req, record);
    // Summarize pre-dispatch GC now: later GC would evict those entries from the bounded ring before close.
    // One turn later, so GC entries recorded just before dispatch have reached the observer.
    setImmediate(() => { record.gcBeforeDispatch ??= dispatchGc(record); });
  }
  server.prependListener('connection', onConnection);
  server.prependListener('request', onRequest);
  server.once('close', () => {
    clearInterval(timer);
    gc.close();
    server.removeListener('connection', onConnection);
    server.removeListener('request', onRequest);
  });
}

export function shareConnectionTiming(req: IncomingMessage | undefined): ConnectionTiming | undefined {
  return req && requests.get(req)?.timing;
}


function dispatchGc(record: RequestRecord) {
  const { requestDispatchedAtUnixMs: dispatch, loopAtDispatch: loop } = record.timing;
  return record.gc.snapshot({ windowStart: dispatch - loop.windowMs, dispatch,
    intervalStart: loop.maxIntervalStartUnixMs, intervalEnd: loop.maxIntervalEndUnixMs });
}

// Taken one turn after dispatch (or at close, if that comes first), with the pre-dispatch boundaries.
export function shareDispatchGc(req: IncomingMessage | undefined) {
  const record = req && requests.get(req);
  if (!record) return;
  return record.gcBeforeDispatch ??= dispatchGc(record);
}
