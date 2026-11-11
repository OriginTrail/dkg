import { createHash } from 'node:crypto';
import { decode, encode } from 'cborg';
import type { SemanticRuntimeStore } from './persistence.js';

export interface ProgramCallIdentity { readonly id: string; readonly kind: 'tool' | 'program'; readonly target: string }
export type ProgramExecutionStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';
export interface ProgramCallDiagnostics {
  startedAt: string; status: ProgramExecutionStatus; durationMs?: number;
  result?: unknown; resultTruncated?: boolean; error?: string; executionIri?: string;
}
type Failure = { location: string; message: string };
/** v1 keeps the historical event type and CBOR shape, including field order. */
type StoredEvent =
  | { type: 'start'; startedAt: string }
  | { type: 'call'; call: ProgramCallIdentity & ProgramCallDiagnostics }
  | { type: 'finish'; status: ProgramExecutionStatus; durationMs: number; failure?: Failure };
export type ProgramExecutionJournalEvent =
  | { type: 'start'; startedAt?: string }
  | { type: 'call'; identity: ProgramCallIdentity; diagnostics?: ProgramCallDiagnostics }
  | { type: 'finish'; status?: ProgramExecutionStatus; durationMs?: number; failure?: Failure };
const EVENT = 'typescript-call-trace-v1';
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const duration = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const status = (v: unknown): v is ProgramExecutionStatus => v === 'running' || v === 'succeeded' || v === 'failed' || v === 'interrupted';
export class ProgramExecutionJournalError extends Error {
  constructor() { super('PROGRAM_EXECUTION_JOURNAL_INVALID'); }
}
const invalid = () => new ProgramExecutionJournalError();

/** Identity is authoritative; absent or invalid presentation data cannot erase it. */
function decodeEvent(bytes: Uint8Array): ProgramExecutionJournalEvent {
  let value: unknown;
  try { value = decode(bytes); } catch { throw invalid(); }
  if (!record(value)) throw invalid();
  if (value.type === 'start') return { type: 'start', ...(text(value.startedAt) ? { startedAt: value.startedAt } : {}) };
  if (value.type === 'finish') return { type: 'finish',
    ...(status(value.status) ? { status: value.status } : {}),
    ...(duration(value.durationMs) ? { durationMs: value.durationMs } : {}),
    ...(record(value.failure) && typeof value.failure.location === 'string' && typeof value.failure.message === 'string'
      ? { failure: { location: value.failure.location, message: value.failure.message } } : {}) };
  if (value.type !== 'call' || !record(value.call)) throw invalid();
  const call = value.call;
  if (!text(call.id) || !text(call.target) || (call.kind !== 'tool' && call.kind !== 'program')) throw invalid();
  const identity: ProgramCallIdentity = { id: call.id, kind: call.kind, target: call.target };
  const diagnostics: ProgramCallDiagnostics | undefined = text(call.startedAt) && status(call.status)
    ? { startedAt: call.startedAt, status: call.status,
      ...(duration(call.durationMs) ? { durationMs: call.durationMs } : {}),
      ...(Object.hasOwn(call, 'result') ? { result: call.result } : {}),
      ...(typeof call.resultTruncated === 'boolean' ? { resultTruncated: call.resultTruncated } : {}),
      ...(typeof call.error === 'string' ? { error: call.error } : {}),
      ...(text(call.executionIri) ? { executionIri: call.executionIri } : {}) } : undefined;
  return { type: 'call', identity, ...(diagnostics ? { diagnostics } : {}) };
}

/** Call admission is persisted before dispatch, independently of its result preview. */
export function appendProgramExecutionEvent(store: SemanticRuntimeStore, executionIri: string, event: StoredEvent): void {
  const execution = store.execution(executionIri)!;
  const bytes = encode(event);
  decodeEvent(bytes);
  store.commitRuntimeTransition({ executionId: executionIri, expectedNextSeq: execution.nextEventSeq,
    eventId: `trace:${execution.nextEventSeq}`, eventType: EVENT, eventCbor: bytes,
    stateDigest: createHash('sha256').update(bytes).digest() });
}

export function readProgramExecutionJournal(store: SemanticRuntimeStore, executionIri: string): {
  version: 1; executionIri: string; events: ProgramExecutionJournalEvent[];
} {
  const events: ProgramExecutionJournalEvent[] = [];
  for (const event of store.runtimeEventsAfter(executionIri, 0n)) {
    if (event.eventType === EVENT) events.push(decodeEvent(event.cbor));
    else if (event.eventType.startsWith('typescript-call-trace-')) throw invalid();
  }
  return { version: 1, executionIri, events };
}

/** Every attempt contributes identities. Conflicting identities for one id are
 * retained, so a presentation reset cannot permit replay of mixed executions. */
export function readProgramCallHistory(store: SemanticRuntimeStore, executionIri: string): {
  version: 1; executionIri: string; calls: ProgramCallIdentity[];
} {
  const journal = readProgramExecutionJournal(store, executionIri), calls = new Map<string, ProgramCallIdentity>();
  for (const event of journal.events) if (event.type === 'call') {
    const { id, kind, target } = event.identity;
    calls.set(JSON.stringify([id, kind, target]), event.identity);
  }
  return { version: journal.version, executionIri, calls: [...calls.values()] };
}
