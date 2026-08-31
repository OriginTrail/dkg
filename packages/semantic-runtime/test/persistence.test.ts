import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DurableSemanticRuntimeHost,
  RuntimeAdapterRegistry,
  RuntimeEffectBroker,
  SemanticRuntimeStore,
  computeEffectRequestDigest,
  encodeCapabilityMetadata,
  type EffectProposal,
  type RuntimeAdapterOperation,
  type RuntimePolicyAdapter,
  type StrategyArtifactRecord,
} from '../src/index.js';

function artifact(): StrategyArtifactRecord {
  const canonicalPlan = Uint8Array.from([0x81, 0x01]);
  return {
    artifactHash: createHash('sha256')
      .update('DKG-STRATEGY-PLAN-V1\0')
      .update(canonicalPlan)
      .digest('hex'),
    strategyId: 'listener-boy',
    version: '1.0.0',
    canonicalPlan,
    sourceRef: 'artifact:listener-boy-source',
    reviewState: 'approved',
    createdAt: 100,
  };
}

function databasePath(): { directory: string; path: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-semantic-runtime-'));
  return { directory, path: path.join(directory, 'semantic-runtime.sqlite') };
}

function seedExecution(store: SemanticRuntimeStore): StrategyArtifactRecord {
  const plan = artifact();
  store.registerStrategyArtifact(plan);
  store.createExecution({
    executionId: 'exec-1',
    planId: plan.artifactHash,
    partitionId: 'partition-1',
    status: 'active',
    graphRevision: 'graph-revision-1',
    policyEpoch: 7n,
    rootProcessId: 'process-root',
    leaseEpoch: 1n,
  });
  return plan;
}

describe('SemanticRuntimeStore', () => {
  it('persists hash-linked events and validated snapshots across reopen', () => {
    const temporary = databasePath();
    try {
      let store = new SemanticRuntimeStore(temporary.path);
      seedExecution(store);
      store.commitRuntimeTransition({
        executionId: 'exec-1',
        expectedNextSeq: 1n,
        eventId: 'event-1',
        eventType: 'advance',
        eventCbor: Uint8Array.from([1, 2, 3]),
        stateDigest: new Uint8Array(32).fill(1),
        snapshot: {
          partitionId: 'partition-1',
          schemaVersion: 1,
          wasmAbiVersion: 65_537,
          cbor: Uint8Array.from([4, 5, 6]),
          createdAt: 101,
        },
      });
      store.commitRuntimeTransition({
        executionId: 'exec-1',
        expectedNextSeq: 2n,
        eventId: 'event-2',
        eventType: 'set-deadline',
        eventCbor: Uint8Array.from([7, 8]),
        stateDigest: new Uint8Array(32).fill(2),
      });
      store.verifyRuntimeEventChain('exec-1');
      expect(store.newestValidSnapshot('partition-1')?.seq).toBe(1n);
      store.close();

      store = new SemanticRuntimeStore(temporary.path);
      store.verifyRuntimeEventChain('exec-1');
      expect(store.execution('exec-1')).toMatchObject({
        nextEventSeq: 3n,
        snapshotSeq: 1n,
      });
      expect(store.runtimeEventsAfter('exec-1', 1n)).toHaveLength(1);
      store.close();
    } finally {
      fs.rmSync(temporary.directory, { recursive: true, force: true });
    }
  });
});

describe('DurableSemanticRuntimeHost', () => {
  it('restores the verified Wasm snapshot and continues the durable event sequence', async () => {
    const temporary = databasePath();
    const execution = {
      executionId: 'durable-exec',
      partitionId: 'durable-partition',
      graphRevision: 'graph-revision-1',
      policyEpoch: 1n,
      rootProcessId: 'root-process',
      leaseEpoch: 1n,
      artifact: artifact(),
    };
    const workerUrl = new URL('../dist/worker.js', import.meta.url);
    let runtime: DurableSemanticRuntimeHost | null = null;
    try {
      runtime = new DurableSemanticRuntimeHost({
        databasePath: temporary.path,
        execution,
        host: { workerUrl },
        snapshotEveryEvents: 1,
        now: () => 100,
      });
      await runtime.start();
      const firstEvent = {
        kind: 'advance' as const,
        eventId: new Uint8Array(32).fill(0x51),
        logicalTime: 10n,
        delta: 5n,
      };
      expect((await runtime.applyEvent(firstEvent)).accumulator).toBe(5n);
      expect((await runtime.applyEvent(firstEvent)).traceEvents[0]?.kind).toBe('duplicate-ignored');
      expect(runtime.persistence.runtimeEventsAfter('durable-exec', 0n)).toHaveLength(1);
      await runtime.stop();
      runtime = null;

      runtime = new DurableSemanticRuntimeHost({
        databasePath: temporary.path,
        execution,
        host: { workerUrl },
        snapshotEveryEvents: 1,
        now: () => 200,
      });
      await runtime.start();
      const resumed = await runtime.applyEvent({
        kind: 'advance',
        eventId: new Uint8Array(32).fill(0x52),
        logicalTime: 20n,
        delta: 2n,
      });
      expect(resumed.accumulator).toBe(7n);
      expect(runtime.persistence.execution('durable-exec')?.nextEventSeq).toBe(3n);
    } finally {
      await runtime?.stop().catch(() => undefined);
      fs.rmSync(temporary.directory, { recursive: true, force: true });
    }
  });
});

describe('RuntimeEffectBroker', () => {
  function setup(options: {
    dispatch: RuntimeAdapterOperation<{ node: string }, { changed: boolean }>['dispatch'];
    reconcile?: RuntimeAdapterOperation<{ node: string }, { changed: boolean }>['reconcile'];
    boundary?: ConstructorParameters<typeof RuntimeEffectBroker>[4]['boundary'];
  }) {
    const temporary = databasePath();
    const store = new SemanticRuntimeStore(temporary.path);
    seedExecution(store);
    const input = { node: 'node-a' };
    const requestDigest = computeEffectRequestDigest(
      'infra/drain-node',
      '1',
      'drain',
      'node/node-a',
      input,
    );
    store.putCapability({
      capabilityId: 'cap-1',
      executionId: 'exec-1',
      metadataCbor: encodeCapabilityMetadata({
        subject: 'operator-1',
        audience: 'dkg-semantic-runtime',
        executionId: 'exec-1',
        verbs: ['drain'],
        resources: ['node/*'],
        delegationDepth: 0,
        oneShot: true,
        budgetMicros: 100n,
      }),
      hostBindingKey: 'binding/node-operator',
      policyEpoch: 7n,
      notBefore: 1,
      expiresAt: 1_000,
      oneShot: true,
      consumedAt: null,
      revokedAt: null,
    });
    store.putApproval({
      approvalId: 'approval-1',
      executionId: 'exec-1',
      effectClass: 'infrastructure-change',
      principal: 'operator-1',
      requestDigest,
      notBefore: 1,
      expiresAt: 1_000,
      oneShot: true,
      consumedAt: null,
    });
    const registry = new RuntimeAdapterRegistry();
    registry.register({
      id: 'infra/drain-node',
      version: '1',
      effectClass: 'infrastructure-change',
      verb: 'drain',
      idempotencyClass: 'non_repeatable',
      reconciliationRule: 'query-node-drain-state',
      validateInput(value): { node: string } {
        if (
          typeof value !== 'object'
          || value === null
          || !('node' in value)
          || typeof value.node !== 'string'
        ) throw new Error('INVALID_INPUT');
        return { node: value.node };
      },
      dispatch: options.dispatch,
      reconcile: options.reconcile ?? (async () => ({
        status: 'applied',
        evidenceRef: 'evidence:node-a-drained',
        output: { changed: true },
      })),
      couldHaveReachedTarget: () => true,
    });
    const policy: RuntimePolicyAdapter = {
      evaluate: async () => ({
        decision: 'allow',
        policyId: 'ccl:runtime-effects@1',
        policyEpoch: 7n,
        factsDigest: new Uint8Array(32).fill(9),
        reasonCode: 'POLICY_ALLOW',
      }),
    };
    const broker = new RuntimeEffectBroker(
      store,
      policy,
      registry,
      {
        adapterVersions: new Map([['infra/drain-node', '1']]),
        allowedEffectClasses: new Set(['infrastructure-change']),
      },
      { boundary: options.boundary },
    );
    const proposal: EffectProposal = {
      effectId: 'effect-1',
      executionId: 'exec-1',
      processId: 'process-remediation',
      stepId: 'step-drain',
      attemptId: 'attempt-1',
      principal: 'operator-1',
      adapterId: 'infra/drain-node',
      adapterVersion: '1',
      verb: 'drain',
      resource: 'node/node-a',
      normalizedInput: input,
      capabilityId: 'cap-1',
      approvalId: 'approval-1',
      idempotencyKey: 'drain-node-a-once',
      budgetReservation: 10n,
      now: 100,
    };
    return { temporary, store, broker, proposal };
  }

  it('commits preparation before dispatch and preserves the audit chain', async () => {
    let dispatched = 0;
    const fixture = setup({
      dispatch: async (authorization, input) => {
        dispatched += 1;
        expect(authorization.effectId).toBe('effect-1');
        expect(input.node).toBe('node-a');
        return {
          status: 'succeeded',
          output: { changed: true },
          evidenceRef: 'evidence:drain-1',
        };
      },
    });
    try {
      expect((await fixture.broker.prepareEffect(fixture.proposal)).state).toBe('prepared');
      expect(fixture.store.approval('approval-1')?.consumedAt).toBe(100);
      expect(fixture.store.capability('cap-1')?.consumedAt).toBe(100);
      expect((await fixture.broker.prepareEffect(fixture.proposal)).state).toBe('prepared');
      expect((await fixture.broker.dispatchPrepared('effect-1', 101)).state).toBe('succeeded');
      expect(dispatched).toBe(1);
      fixture.store.verifyEffectChain('effect-1');
      expect(fixture.store.effectTransitions('effect-1').map((entry) => entry.state)).toEqual([
        'prepared',
        'dispatching',
        'succeeded',
      ]);
    } finally {
      fixture.store.close();
      fs.rmSync(fixture.temporary.directory, { recursive: true, force: true });
    }
  });

  it('marks a post-dispatch crash ambiguous and reconciles without blind retry', async () => {
    let dispatched = 0;
    const fixture = setup({
      dispatch: async () => {
        dispatched += 1;
        return {
          status: 'succeeded',
          output: { changed: true },
          evidenceRef: 'evidence:target-accepted',
        };
      },
      boundary: (boundary) => {
        if (boundary === 'adapter-returned') throw new Error('SIMULATED_HOST_CRASH');
      },
    });
    try {
      await fixture.broker.prepareEffect(fixture.proposal);
      expect((await fixture.broker.dispatchPrepared('effect-1', 101)).state).toBe('unknown');
      await expect(fixture.broker.dispatchPrepared('effect-1', 102)).rejects.toThrow(/unknown/);
      expect(dispatched).toBe(1);
      expect((await fixture.broker.reconcileUnknown('effect-1', 103)).state).toBe('succeeded');
      expect(dispatched).toBe(1);
    } finally {
      fixture.store.close();
      fs.rmSync(fixture.temporary.directory, { recursive: true, force: true });
    }
  });

  it('fails closed at every committed dispatch boundary without duplicating the mutation', async () => {
    for (const crashAt of [
      'prepared-committed',
      'dispatching-committed',
      'outcome-committed',
    ] as const) {
      let dispatched = 0;
      const fixture = setup({
        dispatch: async () => {
          dispatched += 1;
          return {
            status: 'succeeded',
            output: { changed: true },
            evidenceRef: 'evidence:target-accepted',
          };
        },
        boundary: (boundary) => {
          if (boundary === crashAt) throw new Error(`SIMULATED_CRASH_${crashAt}`);
        },
      });
      try {
        if (crashAt === 'prepared-committed') {
          await expect(fixture.broker.prepareEffect(fixture.proposal)).rejects.toThrow(/SIMULATED/);
          expect(fixture.store.effect('effect-1')?.state).toBe('prepared');
          expect(dispatched).toBe(0);
          continue;
        }
        await fixture.broker.prepareEffect(fixture.proposal);
        if (crashAt === 'dispatching-committed') {
          await expect(fixture.broker.dispatchPrepared('effect-1', 101)).rejects.toThrow(/SIMULATED/);
          expect(fixture.store.effect('effect-1')?.state).toBe('dispatching');
          expect(dispatched).toBe(0);
          fixture.store.close();
          const recovered = new SemanticRuntimeStore(fixture.temporary.path);
          expect(recovered.effect('effect-1')?.state).toBe('unknown');
          recovered.close();
          continue;
        }
        await expect(fixture.broker.dispatchPrepared('effect-1', 101)).rejects.toThrow(/SIMULATED/);
        expect(fixture.store.effect('effect-1')?.state).toBe('succeeded');
        expect(dispatched).toBe(1);
        await expect(fixture.broker.dispatchPrepared('effect-1', 102)).rejects.toThrow(/succeeded/);
        expect(dispatched).toBe(1);
      } finally {
        fixture.store.close();
        fs.rmSync(fixture.temporary.directory, { recursive: true, force: true });
      }
    }
  });

  it('turns durable dispatching state into unknown when the store reopens', async () => {
    const fixture = setup({
      dispatch: async () => ({
        status: 'succeeded',
        output: { changed: true },
        evidenceRef: 'unused',
      }),
    });
    let store: SemanticRuntimeStore | null = fixture.store;
    try {
      await fixture.broker.prepareEffect(fixture.proposal);
      store.transitionEffect('effect-1', 'dispatching', 'attempt-started', new Uint8Array(), 101);
      store.close();
      store = new SemanticRuntimeStore(fixture.temporary.path);
      expect(store.effect('effect-1')?.state).toBe('unknown');
      store.verifyEffectChain('effect-1');
    } finally {
      store?.close();
      fs.rmSync(fixture.temporary.directory, { recursive: true, force: true });
    }
  });
});
