import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';
import { Logger, createOperationContext, currentAsyncAdmissionDiagnosticContext, type BackpressureSnapshot } from '@origintrail-official/dkg-core';
import { isStoreOperation } from './store-operation-outcome.js';

const logger = new Logger('ShareStoreTiming');
const holds = new AsyncLocalStorage<ShareStoreHold>();
const calls = new AsyncLocalStorage<PhysicalCall>();
const controlQueues = new Set(['store-control-share', 'store-control-publisher', 'store-control-preflight']);
// Only fixed scheduler namespaces and operation names can enter a diagnostic.
const queueOperations = [
  'claimNext.candidates', 'clearTerminalJob', 'deleteJob', 'findActiveConflict', 'list', 'list.payloads',
  'ownershipReader', 'readJob', 'reconcile', 'recoverExpired', 'recoverPostCommit', 'recoverPostCommit.payloads',
  'retention.delete', 'retention.scan', 'retention.verify', 'selectorLookup', 'stats', 'writeJob',
];
const sources = new Set([
  ...queueOperations.map(name => `publisher.asyncPromote.${name}`),
  'agent.writePreflight.declaration', 'api.readGraphs.rows', 'storage.readGraphRegistryRecord', 'storage.readGraphStartup',
]);
function publicSource(value: string): string {
  if (sources.has(value)) {
    return value;
  }
  for (const prefix of ['blazegraph.', 'sparql-http.']) {
    if (value.startsWith(prefix) && isStoreOperation(value.slice(prefix.length))) return value;
  }
  return 'other';
}
const ms = (v: number) => Math.max(0, Math.round(v));
const epoch = (v: number) => Math.round(performance.timeOrigin + v);

function log(fields: object) {
  try { logger.info(createOperationContext('system'), JSON.stringify(fields)); } catch { /* evidence only */ }
}

interface HttpSample {
  created: number;
  sent?: number;
  headers?: number;
  bodyDone?: number;
  error?: boolean;
}
const httpRequests = new WeakMap<object, HttpSample>();
let observing = false;

// Undici emits these on the actual transport, including Node's built-in fetch. Only keep timestamps.
// A WeakMap joins headers/trailers to their own request even if the dispatch context has changed.
function observeHttp() {
  if (observing) return;
  observing = true;
  for (const event of ['request:create', 'client:sendHeaders', 'request:headers', 'request:trailers', 'request:error'] as const) {
    channel('undici:' + event).subscribe(message => {
      try {
        const { request } = message as { request?: object };
        if (!request) return;
        const now = performance.now();
        if (event === 'request:create') {
          const call = calls.getStore();
          if (!call || call.done) return;
          const sample = { created: now };
          call.httpCount++;
          // Keep the latest physical HTTP attempt. The count makes multi-request coverage explicit.
          call.http = sample;
          httpRequests.set(request, sample);
          return;
        }
        const sample = httpRequests.get(request);
        if (!sample) return;
        if (event === 'client:sendHeaders') sample.sent = now;
        else if (event === 'request:headers') sample.headers = now;
        else if (event === 'request:trailers') sample.bodyDone = now;
        else sample.error = true;
      } catch { /* diagnostics subscribers must never throw into undici */ }
    });
  }
}

function httpFields(h?: HttpSample) {
  if (!h) return undefined;
  return { createdAtUnixMs: epoch(h.created),
    sendHeadersAtUnixMs: h.sent === undefined ? undefined : epoch(h.sent),
    headersAtUnixMs: h.headers === undefined ? undefined : epoch(h.headers),
    bodyReceivedAtUnixMs: h.bodyDone === undefined ? undefined : epoch(h.bodyDone), error: h.error };
}

let sequence = 0;
/** A detached worker may wake inside the lock but its later work belongs to its own operation. */
export function withoutShareStoreHold<T>(fn: () => T): T {
  return holds.getStore() ? holds.exit(fn) : fn();
}

export class ShareStoreHold {
  readonly id = ++sequence;
  active = true;
  private total = 0;
  private readonly pending = new Set<PhysicalCall>();
  private readonly slowest: ReturnType<PhysicalCall['summary']>[] = [];
  private waitingMs = 0;
  private runningMs = 0;
  private droppedConcurrent = 0;

  run<T>(fn: () => T): T { return holds.run(this, fn); }
  add(call: PhysicalCall) {
    this.total++;
    if (this.pending.size < 4) this.pending.add(call);
    else this.droppedConcurrent++;
  }
  finish(call: PhysicalCall) {
    this.pending.delete(call);
    const row = call.summary();
    this.waitingMs += row.queueMs;
    this.runningMs += row.runningMs;
    this.slowest.push(row);
    this.slowest.sort((a,b) => b.elapsedMs - a.elapsedMs);
    if (this.slowest.length > 4) this.slowest.pop();
  }
  snapshot() {
    return { holdId: this.id, storeCalls: this.total, sumQueueMs: this.waitingMs, sumRunningMs: this.runningMs,
      pending: [...this.pending].map(c => c.summary()), droppedConcurrent: this.droppedConcurrent, slowest: [...this.slowest] };
  }
}

class PhysicalCall {
  readonly queued = performance.now();
  started?: number;
  ended?: number;
  done = false;
  outcome = 'pending';
  httpCount = 0;
  http?: HttpSample;
  constructor(readonly source: string, readonly op: string, readonly lane: string, readonly pressure: unknown,
              readonly hold?: ShareStoreHold, readonly requestId?: string) {}
  run<T>(work: () => T): T {
    this.started = performance.now();
    return calls.run(this, work);
  }
  finish(outcome: string) {
    if (this.done) return;
    this.done = true;
    this.ended = performance.now();
    this.outcome = outcome;
    this.hold?.finish(this);
    if (this.hold && !this.hold.active) {
      log({ event: 'async_share_store_late_settlement', holdId: this.hold.id, ...this.summary() });
    } else if (!this.hold && this.requestId) {
      log({ event: 'async_share_store_timing', requestId: this.requestId, ...this.summary() });
    }
  }
  summary() {
    const end = this.ended ?? performance.now();
    return { source: this.source, operation: this.op, lane: this.lane, queuedAtUnixMs: epoch(this.queued),
      startedAtUnixMs: this.started === undefined ? undefined : epoch(this.started), elapsedMs: ms(end-this.queued),
      queueMs: ms((this.started ?? end)-this.queued), runningMs: this.started === undefined ? 0 : ms(end-this.started),
      outcome: this.outcome, pressure: this.pressure, httpCount: this.httpCount, lastHttp: httpFields(this.http) };
  }
}

export function traceShareStoreCall(source: string, op: unknown, lane: string, control: string | undefined, pressure?: () => BackpressureSnapshot) {
  if (process.env.DKG_ASYNC_PROMOTE_ADMISSION_TRACE !== '1') return;
  const holder = holds.getStore();
  const hold = holder?.active ? holder : undefined;
  const context = currentAsyncAdmissionDiagnosticContext();
  if (!hold && context?.route !== 'share_async') return;
  try {
    observeHttp();
    const controlQueue = control && controlQueues.has(control) ? control : undefined;
    const atJoin = pressure?.().lanes.map(l => ({ lane: l.lane, queued: l.queued, active: l.activeOperations.slice(0, 3).map(a => ({
      source: publicSource(a.operation), count: a.count, oldestAgeMs: a.oldestAgeMs,
    })) }));
    const call = new PhysicalCall(publicSource(source), isStoreOperation(op) ? op : 'other',
      controlQueue ?? lane, atJoin, hold, context?.route === 'share_async' ? context.requestId : undefined);
    hold?.add(call);
    return call;
  } catch { return undefined; }
}
