import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  RuntimeAdapterRegistry, RuntimeEffectBroker, SemanticRuntimeStore,
  encodeCapabilityMetadata, type EffectProposal, type RuntimeAdapterOperation,
  type RuntimePolicyAdapter,
} from '../src/index.js';

const temporary: string[] = [];
const stores: SemanticRuntimeStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function open(file: string): SemanticRuntimeStore { const store = new SemanticRuntimeStore(file); stores.push(store); return store; }
const bytes = (n: number) => new Uint8Array(32).fill(n);
const pause = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };

function fixture(options: { resumable?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-checkpoint-recovery-')); temporary.push(directory);
  const databasePath = path.join(directory, 'runtime.sqlite'); const store = open(databasePath);
  const canonicalPlan = Uint8Array.from([0x81, 0x01]);
  const artifactHash = createHash('sha256').update('DKG-STRATEGY-PLAN-V1\0').update(canonicalPlan).digest('hex');
  store.registerStrategyArtifact({ artifactHash, canonicalPlan, strategyId: 'recovery-fixture', version: '1',
    sourceRef: 'local:fixture', reviewState: 'approved', createdAt: 10 });
  store.createExecution({ executionId: 'exec', planId: artifactHash, partitionId: 'partition', status: 'active',
    graphRevision: 'graph-pinned', policyEpoch: 7n, rootProcessId: 'process', leaseEpoch: 1n });
  store.putCapability({ capabilityId: 'cap', executionId: 'exec',
    metadataCbor: encodeCapabilityMetadata({ subject: 'operator', audience: 'dkg-semantic-runtime', executionId: 'exec',
      verbs: ['invoke'], resources: ['model/*'], delegationDepth: 0, oneShot: true, budgetMicros: 1000n }),
    hostBindingKey: 'local:model', policyEpoch: 7n, notBefore: 1, expiresAt: 10000,
    oneShot: true, consumedAt: null, revokedAt: null });
  let allowed = true; let enabled = true; let epoch = 7n; let policyHook = async () => {};
  let dispatches = 0; let resumes = 0; let reconciles = 0;
  let resumeHook: RuntimeAdapterOperation['resume'] = async () => ({ status: 'succeeded', output: { answer: 'durable' }, evidenceRef: 'receipt:stable' });
  const operation: RuntimeAdapterOperation = {
    id: 'model/checkpointed', version: '1', enabled: () => enabled, effectClass: 'model-invocation', verb: 'invoke',
    idempotencyClass: 'idempotent_with_key', reconciliationRule: 'authenticated-status', validateInput: value => value,
    dispatch: async () => { dispatches++; throw new Error('AMBIGUOUS_PROVIDER_OUTCOME'); },
    ...(options.resumable === false ? {} : { resume: async (token, input) => { resumes++; return resumeHook!(token, input); } }),
    reconcile: async () => { reconciles++; return { status: 'applied', output: { answer: 'durable' }, evidenceRef: 'receipt:status' }; },
    couldHaveReachedTarget: () => true,
  };
  const registry = new RuntimeAdapterRegistry(); registry.register(operation);
  const policy: RuntimePolicyAdapter = { evaluate: async () => {
    await policyHook(); return { decision: allowed ? 'allow' : 'deny', policyId: 'operator-policy', policyEpoch: epoch,
      factsDigest: bytes(3), reasonCode: allowed ? 'ALLOW' : 'DENY' };
  } };
  const authority = { adapterVersions: new Map([['model/checkpointed', '1']]), allowedEffectClasses: new Set(['model-invocation']) };
  const brokerFor = (target = store) => new RuntimeEffectBroker(target, policy, registry, authority);
  const broker = brokerFor();
  const proposal: EffectProposal = { effectId: 'effect', executionId: 'exec', processId: 'process', stepId: 'step', attemptId: 'attempt',
    principal: 'operator', adapterId: 'model/checkpointed', adapterVersion: '1', verb: 'invoke', resource: 'model/fixture',
    normalizedInput: { prompt: 'approved' }, capabilityId: 'cap', idempotencyKey: 'stable-key', budgetReservation: 100n, now: 100 };
  return { store, broker, databasePath, proposal, artifactHash, canonicalPlan, brokerFor,
    deny() { allowed = false; }, disable() { enabled = false; }, stalePolicy() { epoch = 8n; },
    onPolicy(fn: () => Promise<void>) { policyHook = fn; }, onResume(fn: NonNullable<RuntimeAdapterOperation['resume']>) { resumeHook = fn; },
    get dispatches() { return dispatches; }, get resumes() { return resumes; }, get reconciles() { return reconciles; },
    async interrupt() { await broker.prepareEffect(proposal); expect((await broker.dispatchPrepared('effect', 101)).state).toBe('unknown'); },
  };
}

describe('adapter checkpoint durability', () => {
  it('migrates a populated v1 database to v2 without changing its events, capability, effect or artifact', async () => {
    const f = fixture(); await f.interrupt();
    f.store.commitRuntimeTransition({ executionId: 'exec', expectedNextSeq: 1n, eventId: 'event', eventType: 'fixture',
      eventCbor: Uint8Array.from([1, 2]), stateDigest: bytes(4), snapshot: { partitionId: 'partition', schemaVersion: 1,
        wasmAbiVersion: 65537, cbor: Uint8Array.from([3, 4]), createdAt: 110 } });
    const execution = f.store.execution('exec'); const effect = f.store.effect('effect'); const cap = f.store.capability('cap');
    const events = f.store.runtimeEventsAfter('exec', 0n); const transitions = f.store.effectTransitions('effect');
    f.store.close();
    // v2 only adds adapter_checkpoint: removing it yields the exact v1 schema
    // around real populated authorization/effect/event records.
    const old = new Database(f.databasePath);
    old.exec('DROP TABLE adapter_checkpoint; PRAGMA user_version=1;'); old.close();
    const migrated = open(f.databasePath);
    expect(migrated.execution('exec')).toEqual(execution); expect(migrated.effect('effect')).toEqual(effect);
    expect(migrated.capability('cap')).toEqual(cap); expect(migrated.runtimeEventsAfter('exec', 0n)).toEqual(events);
    expect(migrated.effectTransitions('effect')).toEqual(transitions); expect(migrated.strategyArtifact(f.artifactHash)?.canonicalPlan).toEqual(f.canonicalPlan);
    expect(migrated.newestValidSnapshot('partition')?.seq).toBe(1n);
    migrated.verifyEffectChain('effect'); migrated.verifyRuntimeEventChain('exec');
    expect(migrated.writeAdapterCheckpoint('effect', effect!.requestDigest, Uint8Array.from([9]), 0)).toBe(1);
    const inspect = new Database(f.databasePath, { readonly: true }); expect(inspect.pragma('user_version', { simple: true })).toBe(2); inspect.close();
  });

  it('binds checkpoints to the original effect digest and uses CAS across stores/reopen', async () => {
    const f = fixture(); await f.interrupt(); const effect = f.store.effect('effect')!;
    expect(() => f.store.writeAdapterCheckpoint('missing', effect.requestDigest, bytes(1), 0)).toThrow(/does not exist/);
    expect(() => f.store.writeAdapterCheckpoint('effect', bytes(7), bytes(1), 0)).toThrow(/digest mismatch/);
    expect(f.store.adapterCheckpoint('effect')).toBeNull();
    expect(f.store.writeAdapterCheckpoint('effect', effect.requestDigest, Uint8Array.from([1]), 0)).toBe(1);
    const second = open(f.databasePath); const staleVersion = second.adapterCheckpoint('effect')!.version;
    expect(f.store.writeAdapterCheckpoint('effect', effect.requestDigest, Uint8Array.from([2]), 1)).toBe(2);
    expect(() => second.writeAdapterCheckpoint('effect', effect.requestDigest, Uint8Array.from([3]), staleVersion)).toThrow(/concurrent/);
    expect(second.adapterCheckpoint('effect')).toEqual({ version: 2, payload: Uint8Array.from([2]) });
    expect(() => second.writeAdapterCheckpoint('effect', effect.requestDigest, bytes(1), -1)).toThrow(/bounds/);
    expect(() => second.writeAdapterCheckpoint('effect', effect.requestDigest, new Uint8Array(32 * 1024 * 1024 + 1), 2)).toThrow(/bounds/);
    second.close(); f.store.close();
    const reopened = open(f.databasePath); expect(reopened.adapterCheckpoint('effect')).toEqual({ version: 2, payload: Uint8Array.from([2]) });
    expect(reopened.effect('effect')?.requestDigest).toEqual(effect.requestDigest);
  });

  it('rolls both reconciliation transitions back if the terminal write fails', async () => {
    const f = fixture(); await f.interrupt();
    f.store.transitionEffect('effect', 'reconciling', 'status', new Uint8Array(), 102);
    const before = f.store.effectTransitions('effect');
    const sql = new Database(f.databasePath);
    sql.exec(`CREATE TRIGGER fail_terminal BEFORE INSERT ON effect_transition WHEN NEW.state='succeeded'
      BEGIN SELECT RAISE(ABORT, 'injected terminal failure'); END;`);
    expect(() => f.store.completeReconciliation('effect', 'succeeded', 'receipt', Uint8Array.from([1]), 103)).toThrow(/injected/);
    expect(f.store.effect('effect')?.state).toBe('reconciling'); expect(f.store.effectTransitions('effect')).toEqual(before);
    sql.exec('DROP TRIGGER fail_terminal'); sql.close();
    expect(f.store.completeReconciliation('effect', 'succeeded', 'receipt', Uint8Array.from([1]), 104).state).toBe('succeeded');
    expect(f.store.effectTransitions('effect').slice(-2).map(t => t.state)).toEqual(['reconciled', 'succeeded']);
    f.store.verifyEffectChain('effect');
  });
});

describe('explicit effect continuation', () => {
  it('does not redispatch an ambiguous effect without an opt-in resume adapter', async () => {
    const f = fixture({ resumable: false }); await f.interrupt();
    await expect(f.broker.resumeUnknown('effect', 102)).rejects.toThrow(/does not support/);
    await expect(f.broker.dispatchPrepared('effect', 102)).rejects.toThrow(/unknown/);
    expect(f.dispatches).toBe(1); expect(f.resumes).toBe(0);
    expect((await f.broker.reconcileUnknown('effect', 103)).state).toBe('succeeded');
    expect(f.dispatches).toBe(1); expect(f.reconciles).toBe(1);
  });

  it.each(['revoked', 'expired', 'paused', 'policy-denied', 'stale-policy', 'disabled'])(
    'checks current %s authority before any continuation', async reason => {
      const f = fixture(); await f.interrupt();
      if (reason === 'revoked') f.store.revokeCapability('cap', 102);
      if (reason === 'paused') f.store.setExecutionStatus('exec', 'paused');
      if (reason === 'policy-denied') f.deny();
      if (reason === 'stale-policy') f.stalePolicy();
      if (reason === 'disabled') f.disable();
      await expect(f.broker.resumeUnknown('effect', reason === 'expired' ? 10001 : 102)).rejects.toThrow();
      expect(f.resumes).toBe(0); expect(f.dispatches).toBe(1); expect(f.store.effect('effect')?.state).toBe('unknown');
    });

  it.each(['revocation', 'disablement', 'execution-pause'])(
    'checks %s again after asynchronous policy evaluation', async change => {
      const f = fixture(); await f.interrupt();
      f.onPolicy(async () => {
        if (change === 'revocation') f.store.revokeCapability('cap', 102);
        if (change === 'disablement') f.disable();
        if (change === 'execution-pause') f.store.setExecutionStatus('exec', 'paused');
      });
      await expect(f.broker.resumeUnknown('effect', 102)).rejects.toThrow();
      expect(f.resumes).toBe(0); expect(f.store.effect('effect')?.state).toBe('unknown');
    });

  it('serializes the same continuation across broker/store instances and reuses its durable outcome', async () => {
    const f = fixture(); await f.interrupt(); const barrier = pause(); const entered = pause();
    f.onResume(async (token, input) => {
      expect(Object.isFrozen(token)).toBe(true); expect(token.effectId).toBe('effect'); expect(token.attemptId).toBe('attempt');
      expect(input).toEqual({ prompt: 'approved' }); entered.release(); await barrier.promise;
      return { status: 'succeeded', output: { answer: 'one result' }, evidenceRef: 'receipt:once' };
    });
    const secondStore = open(f.databasePath); const second = f.brokerFor(secondStore);
    const firstResult = f.broker.resumeUnknown('effect', 102); await entered.promise;
    const secondResult = second.resumeUnknown('effect', 102);
    await new Promise(resolve => setImmediate(resolve)); expect(f.resumes).toBe(1);
    barrier.release(); const results = await Promise.all([firstResult, secondResult]);
    expect(results.map(r => r.state)).toEqual(['succeeded', 'succeeded']); expect(f.resumes).toBe(1); expect(f.dispatches).toBe(1);
    expect(second.readOutcome('effect')?.output).toEqual({ answer: 'one result' }); f.store.verifyEffectChain('effect');
  });

  it('serializes read-only reconciliation with an active continuation', async () => {
    const f = fixture(); await f.interrupt(); const barrier = pause(); const entered = pause();
    f.onResume(async () => { entered.release(); await barrier.promise; return { status: 'succeeded', output: { answer: 'one' }, evidenceRef: 'receipt' }; });
    const resume = f.broker.resumeUnknown('effect', 102); await entered.promise;
    const reconcile = f.brokerFor().reconcileUnknown('effect', 103);
    await new Promise(resolve => setImmediate(resolve)); expect(f.reconciles).toBe(0);
    barrier.release(); expect((await resume).state).toBe('succeeded'); expect((await reconcile).state).toBe('succeeded');
    expect(f.reconciles).toBe(0); expect(f.resumes).toBe(1);
  });

  it('keeps an unresolved resumed outcome unknown across repeats and restart without repeating dispatch', async () => {
    const f = fixture(); await f.interrupt(); let attempts = 0;
    f.onResume(async () => { if (++attempts < 3) throw new Error('RECEIPT_NOT_ESTABLISHED');
      return { status: 'succeeded', output: { answer: 'established' }, evidenceRef: 'receipt:recovered' }; });
    expect((await f.broker.resumeUnknown('effect', 102)).state).toBe('unknown');
    expect((await f.broker.resumeUnknown('effect', 103)).state).toBe('unknown'); f.store.close();
    const reopened = open(f.databasePath); const recovered = f.brokerFor(reopened);
    expect((await recovered.resumeUnknown('effect', 104)).state).toBe('succeeded');
    expect(f.dispatches).toBe(1); expect(f.resumes).toBe(3); reopened.verifyEffectChain('effect');
    expect(recovered.readOutcome('effect')?.output).toEqual({ answer: 'established' });
  });
});
