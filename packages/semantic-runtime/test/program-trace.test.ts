import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { encode } from 'cborg';
import { SemanticRuntimeStore } from '../src/persistence.js';
import { ProgramTraceRecorder, readProgramTrace } from '../src/program-trace.js';
import { readProgramCallHistory, readProgramExecutionJournal } from '../src/program-execution-journal.js';
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'trace-test-'));
  const file = join(dir, 'runtime.sqlite'), store = new SemanticRuntimeStore(file);
  cleanups.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const canonicalPlan = new Uint8Array([1]);
  const artifactHash = createHash('sha256').update('DKG-STRATEGY-PLAN-V1\0').update(canonicalPlan).digest('hex');
  store.registerStrategyArtifact({ artifactHash, strategyId: 'test', version: '1', canonicalPlan, sourceRef: 'test', reviewState: 'approved', createdAt: Date.now() });
  store.createExecution({ executionId: 'exec', planId: artifactHash, partitionId: 'p', status: 'active', graphRevision: 'g', policyEpoch: 1n, rootProcessId: 'exec', leaseEpoch: 0n });
  return { store, file, trace: new ProgramTraceRecorder(store, 'exec') };
}
function historicalEvent(store: SemanticRuntimeStore, value: unknown, eventType = 'typescript-call-trace-v1') {
  const bytes = encode(value), seq = store.execution('exec')!.nextEventSeq;
  store.commitRuntimeTransition({ executionId: 'exec', expectedNextSeq: seq, eventId: `trace:${seq}`, eventType,
    eventCbor: bytes, stateDigest: createHash('sha256').update(bytes).digest() });
}
describe('Program call traces', () => {
  it('decodes historical identities independently of diagnostic data without rewriting journal bytes', () => {
    const { store, file } = fixture();
    const identity = { id: '1', kind: 'program', target: 'urn:child' };
    historicalEvent(store, { type: 'call', call: { ...identity, startedAt: 17, status: 'new-display-state', result: 'preview' } });
    historicalEvent(store, { type: 'call', call: { ...identity, startedAt: '2026-11-11T00:00:00Z', status: 'succeeded', resultTruncated: true } });
    historicalEvent(store, { type: 'finish', status: 'failed', durationMs: 1 });
    historicalEvent(store, { type: 'start', startedAt: '2026-11-11T00:00:01Z' });
    const bytes = store.runtimeEventsAfter('exec', 0n).map(event => event.cbor);
    const reopened = new SemanticRuntimeStore(file);
    try {
      expect(readProgramCallHistory(reopened, 'exec')).toEqual({ version: 1, executionIri: 'exec', calls: [identity] });
      expect(readProgramTrace(reopened, 'exec')?.calls).toEqual([]);
      expect(readProgramExecutionJournal(reopened, 'exec').events[1]).toEqual({ type: 'call', identity });
      expect(reopened.runtimeEventsAfter('exec', 0n).map(event => event.cbor)).toEqual(bytes);
      reopened.verifyRuntimeEventChain('exec');
    } finally { reopened.close(); }
  });
  it.each([
    null, { type: 'call' }, { type: 'unknown' },
    ...[{ id: '' }, { id: 1 }, { kind: 'other' }, { target: null }].map(patch => ({ type: 'call', call: { id: '1', kind: 'tool', target: 'urn:native', ...patch } })),
  ])('rejects malformed authoritative event %j without supplying a diagnostic trace', event => {
    const { store } = fixture(); historicalEvent(store, event);
    expect(() => readProgramCallHistory(store, 'exec')).toThrow('PROGRAM_EXECUTION_JOURNAL_INVALID');
    expect(readProgramTrace(store, 'exec')).toBeUndefined();
  });
  it('rejects unsupported call journal versions instead of omitting their calls', () => {
    const { store } = fixture();
    historicalEvent(store, { type: 'call', call: { id: '1', kind: 'program', target: 'urn:child' } }, 'typescript-call-trace-v2');
    expect(() => readProgramCallHistory(store, 'exec')).toThrow('PROGRAM_EXECUTION_JOURNAL_INVALID');
  });
  it('retains all call identities across empty attempts, including conflicting mixed calls', async () => {
    const { store, file, trace } = fixture();
    await trace.call({ id: '1', kind: 'tool', target: 'urn:native' }, async () => 1);
    trace.finish(new Error('interrupted'));
    const next = new ProgramTraceRecorder(store, 'exec');
    await next.call({ id: '1', kind: 'program', target: 'urn:child' }, async () => 2);
    new ProgramTraceRecorder(store, 'exec'); // Crash before the first callback.
    expect(readProgramTrace(store, 'exec')?.calls).toEqual([]);
    const reopened = new SemanticRuntimeStore(file);
    try {
      expect(readProgramCallHistory(reopened, 'exec').calls).toEqual([
        { id: '1', kind: 'tool', target: 'urn:native' }, { id: '1', kind: 'program', target: 'urn:child' },
      ]);
    } finally { reopened.close(); }
  });
  it('preserves dispatch order for concurrent calls and survives reopening', async () => {
    const { store, file, trace } = fixture(); let resolve!: (v: number) => void;
    const first = trace.call({ id: '1', kind: 'tool', target: 'urn:first' }, () => new Promise<number>(r => resolve = r));
    await trace.call({ id: '2', kind: 'program', target: 'urn:second' }, async c => { c.executionIri = 'urn:child'; return 2; });
    resolve(1); await first; trace.finish(); store.setExecutionStatus('exec', 'completed'); store.verifyRuntimeEventChain('exec');
    const reopened = new SemanticRuntimeStore(file);
    try { expect(readProgramTrace(reopened, 'exec')).toEqual(trace.trace); } finally { reopened.close(); }
    expect(trace.trace.calls.map(c => c.result)).toEqual([1, 2]);
  });
  it('bounds result previews and does not journal late responses after timeout', async () => {
    const { store, trace } = fixture();
    for (let i = 0; i < 30; i++) await trace.call({ id: String(i), kind: 'tool', target: 'urn:read' }, async () => 'ü'.repeat(10000));
    expect(trace.trace.calls.every(c => c.resultTruncated)).toBe(true);
    let resolve!: (v: number) => void;
    const pending = trace.call({ id: 'late', kind: 'tool', target: 'urn:slow' }, () => new Promise<number>(r => resolve = r));
    trace.finish(new Error('timeout')); store.setExecutionStatus('exec', 'failed');
    const events = store.runtimeEventsAfter('exec', 0n).length; resolve(9); await pending;
    expect(store.runtimeEventsAfter('exec', 0n)).toHaveLength(events);
    expect(trace.trace.calls.at(-1)?.status).toBe('interrupted');
    expect(JSON.stringify(trace.trace).length).toBeLessThan(100000);
  });
  it('marks unfinished recorded calls interrupted instead of inventing a result', () => {
    const { store, trace } = fixture(); void trace.call({ id: '1', kind: 'tool', target: 'urn:read' }, () => new Promise(() => {}));
    expect(readProgramTrace(store, 'exec')).toMatchObject({ status: 'interrupted', calls: [{ status: 'interrupted' }] });
  });
  it('preserves empty diagnostic failure messages in the historical response shape', () => {
    const { store, trace } = fixture(); trace.finish(new Error(''));
    expect(readProgramTrace(store, 'exec')).toEqual(trace.trace);
  });
});
