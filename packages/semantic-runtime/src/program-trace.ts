import { createHash } from 'node:crypto';
import { decode, encode } from 'cborg';
import type { SemanticRuntimeStore } from './persistence.js';

export interface ProgramCallTrace {
  id: string; kind: 'tool' | 'program'; target: string;
  startedAt: string; durationMs?: number; status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  result?: unknown; resultTruncated?: boolean; error?: string; executionIri?: string;
}
export interface ProgramExecutionTrace {
  version: 1; executionIri: string; startedAt: string; durationMs?: number;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted'; calls: ProgramCallTrace[];
  failure?: { location: string; message: string };
}
const EVENT = 'typescript-call-trace-v1';
/** Bounded diagnostic events in the existing durable journal. No schema migration. */
export class ProgramTraceRecorder {
  readonly trace: ProgramExecutionTrace;
  private closed = false;
  private resultBytes = 0;
  private readonly started = performance.now();
  constructor(private readonly store: SemanticRuntimeStore, executionIri: string) {
    this.trace = { version: 1, executionIri, startedAt: new Date().toISOString(), status: 'running', calls: [] };
    this.persist({ type: 'start', startedAt: this.trace.startedAt });
  }
  async call<T>(id: string, kind: ProgramCallTrace['kind'], target: string, run: (call: ProgramCallTrace) => Promise<T>): Promise<T> {
    if (this.closed || this.trace.calls.length >= 256) throw new Error('PROGRAM_TRACE_CALL_LIMIT');
    const call: ProgramCallTrace = { id, kind, target, startedAt: new Date().toISOString(), status: 'running' };
    const started = performance.now(); this.trace.calls.push(call); this.persist({ type: 'call', call });
    try {
      const result = await run(call);
      if (!this.closed) {
        const json = JSON.stringify(result) ?? 'null';
        const bytes = Buffer.byteLength(json);
        if (bytes <= 4096 && this.resultBytes + bytes <= 65536) { call.result = JSON.parse(json); this.resultBytes += bytes; }
        else {
          call.resultTruncated = true;
          const encoded = Buffer.from(json);
          let end = Math.min(1024, Math.max(0, 65536 - this.resultBytes));
          // Do not split a UTF-8 code point or exceed the aggregate preview budget.
          while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
          if (end > 0) { call.result = encoded.subarray(0, end).toString('utf8'); this.resultBytes += end; }
        }
        call.status = 'succeeded';
      }
      return result;
    } catch (error) {
      if (!this.closed) { call.status = 'failed'; call.error = message(error); }
      throw error;
    } finally {
      if (!this.closed) { call.durationMs = Math.max(0, Math.round(performance.now() - started)); this.persist({ type: 'call', call }); }
    }
  }
  finish(error?: unknown) {
    if (this.closed) return;
    this.closed = true;
    this.trace.status = error === undefined ? 'succeeded' : 'failed';
    this.trace.durationMs = Math.max(0, Math.round(performance.now() - this.started));
    for (const call of this.trace.calls) if (call.status === 'running') { call.status = 'interrupted'; this.persist({ type: 'call', call }); }
    if (error !== undefined) this.trace.failure = { location: 'Program execution', message: message(error) };
    this.persist({ type: 'finish', status: this.trace.status, durationMs: this.trace.durationMs, ...(this.trace.failure ? { failure: this.trace.failure } : {}) });
  }
  private persist(event: unknown) {
    const execution = this.store.execution(this.trace.executionIri)!;
    const bytes = encode(event);
    this.store.commitRuntimeTransition({ executionId: this.trace.executionIri, expectedNextSeq: execution.nextEventSeq,
      eventId: `trace:${execution.nextEventSeq}`, eventType: EVENT, eventCbor: bytes,
      stateDigest: createHash('sha256').update(bytes).digest() });
  }
}
function message(error: unknown) { return (error instanceof Error ? error.message : String(error)).slice(0, 2048); }
export function readProgramTrace(store: SemanticRuntimeStore, executionIri: string): ProgramExecutionTrace | undefined {
  let trace: ProgramExecutionTrace | undefined;
  for (const record of store.runtimeEventsAfter(executionIri, 0n)) {
    if (record.eventType !== EVENT) continue;
    const event = decode(record.cbor) as any;
    if (event.type === 'start') trace = { version: 1, executionIri, startedAt: event.startedAt, status: 'interrupted', calls: [] };
    else if (trace && event.type === 'call') {
      const index = trace.calls.findIndex(c => c.id === event.call.id);
      if (index < 0) trace.calls.push(event.call); else trace.calls[index] = event.call;
    } else if (trace && event.type === 'finish') Object.assign(trace, { status: event.status, durationMs: event.durationMs, ...(event.failure ? { failure: event.failure } : {}) });
  }
  if (trace) for (const call of trace.calls) if (call.status === 'running') call.status = 'interrupted';
  return trace;
}
