import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { SemanticRuntimeStore } from '../src/persistence.js';
import { ProgramTraceRecorder, readProgramTrace } from '../src/program-trace.js';
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
describe('Program call traces', () => {
  it('preserves dispatch order for concurrent calls and survives reopening', async () => {
    const { store, file, trace } = fixture(); let resolve!: (v: number) => void;
    const first = trace.call('1', 'tool', 'urn:first', () => new Promise<number>(r => resolve = r));
    await trace.call('2', 'program', 'urn:second', async c => { c.executionIri = 'urn:child'; return 2; });
    resolve(1); await first; trace.finish(); store.setExecutionStatus('exec', 'completed'); store.verifyRuntimeEventChain('exec');
    const reopened = new SemanticRuntimeStore(file);
    try { expect(readProgramTrace(reopened, 'exec')).toEqual(trace.trace); } finally { reopened.close(); }
    expect(trace.trace.calls.map(c => c.result)).toEqual([1, 2]);
  });
  it('bounds result previews and does not journal late responses after timeout', async () => {
    const { store, trace } = fixture();
    for (let i = 0; i < 30; i++) await trace.call(String(i), 'tool', 'urn:read', async () => 'ü'.repeat(10000));
    expect(trace.trace.calls.every(c => c.resultTruncated)).toBe(true);
    let resolve!: (v: number) => void;
    const pending = trace.call('late', 'tool', 'urn:slow', () => new Promise<number>(r => resolve = r));
    trace.finish(new Error('timeout')); store.setExecutionStatus('exec', 'failed');
    const events = store.runtimeEventsAfter('exec', 0n).length; resolve(9); await pending;
    expect(store.runtimeEventsAfter('exec', 0n)).toHaveLength(events);
    expect(trace.trace.calls.at(-1)?.status).toBe('interrupted');
    expect(JSON.stringify(trace.trace).length).toBeLessThan(100000);
  });
  it('marks unfinished recorded calls interrupted instead of inventing a result', () => {
    const { store, trace } = fixture(); void trace.call('1', 'tool', 'urn:read', () => new Promise(() => {}));
    expect(readProgramTrace(store, 'exec')).toMatchObject({ status: 'interrupted', calls: [{ status: 'interrupted' }] });
  });
});
