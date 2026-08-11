/** Focused integration lane for byte-aware exact-VM host recovery. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import type { OrdinalRecoveryTarget } from '../src/chain-reconciler.js';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';

interface RecoveryTarget extends OrdinalRecoveryTarget {
  readonly localCgId: string;
  readonly onChainCgId: string;
  readonly ordinal: number;
  readonly ual: string;
  readonly merkleRoot: string;
  readonly kaId: string;
  readonly reason: 'no-swm';
}

function recoveryTarget(
  localCgId: string,
  ordinal: number,
): RecoveryTarget {
  return {
    localCgId,
    onChainCgId: '1',
    ordinal,
    ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}`,
    merkleRoot: `root-${ordinal}`,
    kaId: String(ordinal),
    reason: 'no-swm',
  };
}

async function createRecoveryHarness(options: {
  name: string;
  localCgId: string;
  peers: readonly string[];
  targetCount: number;
  unknownFootprints?: boolean;
  useRegisteredChainFootprints?: boolean;
  footprintForOrdinal?: (
    ordinal: number,
  ) => Readonly<{ byteSize: bigint; merkleLeafCount: bigint }>;
  onFetch: (
    peerId: string,
    targets: readonly RecoveryTarget[],
    recovered: Set<number>,
    signal?: AbortSignal,
  ) => 'found' | 'clean-absent' | 'incomplete';
}) {
  return createVmRecoveryHostHarness({
    ...options,
    sizingUnavailable: options.unknownFootprints,
    useRegisteredChainFootprints: options.useRegisteredChainFootprints,
    footprintForOrdinal: options.footprintForOrdinal,
    targetForOrdinal: (ordinal) => recoveryTarget(options.localCgId, ordinal),
  });
}

describe('VM recovery microbatch host — adversarial integration', () => {
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map((agent) =>
      agent.stop().catch(() => undefined)));
  });

  it('rotates after spending one proven-holder reuse in the recovery slice', async () => {
    const holder = '12D3KooWExactProvenAHolder';
    const fallback = '12D3KooWExactProvenZFallback';
    const localCgId = '0x0000000000000000000000000000000000000001/proven-holder';
    const harness = await createRecoveryHarness({
      name: 'ExactVmProvenHolderBurst',
      localCgId,
      peers: [holder, fallback],
      targetCount: 4,
      unknownFootprints: true,
      onFetch: (_peerId, requested, recovered) => {
        for (const target of requested) recovered.add(target.ordinal);
        return 'found';
      },
    });
    agents.push(harness.agent);
    const result = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, harness.targets, 100, () => true,
    );

    expect(harness.fetched).toEqual([
      { peerId: holder, uals: [harness.targets[0]!.ual] },
      { peerId: holder, uals: [harness.targets[1]!.ual] },
      { peerId: fallback, uals: [harness.targets[2]!.ual] },
      { peerId: fallback, uals: [harness.targets[3]!.ual] },
    ]);
    expect(harness.maxActiveFetches()).toBe(1);
    expect(result.attemptedOrdinals).toEqual(harness.targets.map(({ ordinal }) => ordinal));
    expect([...result.outcomes.values()]).toEqual(
      harness.targets.map(() => ({ status: 'reconciled', blockNumber: 100 })),
    );
  });

  it('stops reusing a proven holder after a clean absence', async () => {
    const holder = '12D3KooWExactRevocationAHolder';
    const fallback = '12D3KooWExactRevocationZFallback';
    const localCgId = '0x0000000000000000000000000000000000000001/revoke-holder';
    const harness = await createRecoveryHarness({
      name: 'ExactVmProvenHolderRevocation',
      localCgId,
      peers: [holder, fallback],
      targetCount: 3,
      unknownFootprints: true,
      onFetch: (peerId, requested, recovered) => {
        let allFound = true;
        for (const target of requested) {
          const found = (peerId === holder && target.ordinal === 0)
            || (peerId === fallback && target.ordinal === 2);
          if (found) recovered.add(target.ordinal);
          else allFound = false;
        }
        return allFound ? 'found' : 'clean-absent';
      },
    });
    agents.push(harness.agent);
    const result = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, harness.targets, 100, () => true,
    );

    expect(harness.fetched).toEqual([
      { peerId: holder, uals: [harness.targets[0]!.ual] },
      { peerId: holder, uals: [harness.targets[1]!.ual] },
      { peerId: fallback, uals: [harness.targets[2]!.ual] },
    ]);
    expect(result.attemptedOrdinals).toEqual([0, 1, 2]);
    expect(result.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
    expect(result.outcomes.get(1)?.status).toBe('pending');
    expect(result.outcomes.get(2)).toEqual({ status: 'reconciled', blockNumber: 100 });
  });

  it('uses one proven-holder microbatch and independently revalidates every UAL', async () => {
    const holder = '12D3KooWMicrobatchAHolder';
    const fallback = '12D3KooWMicrobatchZFallback';
    const localCgId = '0x0000000000000000000000000000000000000001/many-small';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchManySmall',
      localCgId,
      peers: [holder, fallback],
      targetCount: 8,
      onFetch: (_peerId, requested, recovered) => {
        for (const target of requested) recovered.add(target.ordinal);
        return 'found';
      },
    });
    agents.push(harness.agent);

    const result = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, harness.targets, 100, () => true,
    );

    expect(harness.fetched).toEqual([
      { peerId: holder, uals: [harness.targets[0]!.ual] },
      { peerId: holder, uals: harness.targets.slice(1).map(({ ual }) => ual) },
    ]);
    expect(result.attemptedOrdinals).toEqual(harness.targets.map(({ ordinal }) => ordinal));
    expect([...result.outcomes.values()]).toEqual(
      harness.targets.map(() => ({ status: 'reconciled', blockNumber: 100 })),
    );
    expect(harness.maxActiveFetches()).toBe(1);
  });

  it('allows only one post-probe microbatch from a proven holder in one slice', async () => {
    const holder = '12D3KooWBoundedReuseHolder';
    const localCgId = '0x0000000000000000000000000000000000000001/bounded-reuse';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchBoundedReuse',
      localCgId,
      peers: [holder],
      targetCount: 25,
      onFetch: (_peerId, requested, recovered) => {
        for (const target of requested) recovered.add(target.ordinal);
        return 'found';
      },
    });
    agents.push(harness.agent);

    const result = await harness.run();

    expect(harness.fetched.map(({ uals }) => uals.length)).toEqual([1, 10]);
    expect(result.attemptedOrdinals).toEqual(
      Array.from({ length: 11 }, (_, ordinal) => ordinal),
    );
    expect(result.outcomes.size).toBe(11);
    expect(result.continuationOrdinal).toBe(11);
  });

  it('settles every UAL in a clean-absent microbatch into backoff', async () => {
    const holder = '12D3KooWCleanAbsentBatchHolder';
    const localCgId = '0x0000000000000000000000000000000000000001/clean-absent-batch';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchCleanAbsentSettlement',
      localCgId,
      peers: [holder],
      targetCount: 3,
      onFetch: (_peerId, requested, recovered) => {
        if (requested.length === 1 && requested[0]!.ordinal === 0) {
          recovered.add(0);
          return 'found';
        }
        return 'clean-absent';
      },
    });
    agents.push(harness.agent);
    const before = harness.internals.vmReconcileRotationNow();

    const result = await harness.run();

    expect(harness.fetched).toEqual([
      { peerId: holder, uals: [harness.targets[0]!.ual] },
      { peerId: holder, uals: harness.targets.slice(1).map(({ ual }) => ual) },
    ]);
    expect(result.attemptedOrdinals).toEqual([0, 1, 2]);
    expect(result.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
    for (const target of harness.targets.slice(1)) {
      expect(result.outcomes.get(target.ordinal)?.status).toBe('pending');
      const record = harness.internals.vmReconcileRotationState.get(
        harness.internals.vmReconcileRotationSlotKey(target),
      );
      expect(record).toMatchObject({
        phase: 'backoff',
        backoffKind: 'clean-absence',
      });
      expect(record?.cleanAbsentPeerIds).toEqual(new Set([holder]));
      expect(record?.nextRetryAt).toBeGreaterThan(before);
    }
  });

  it('enriches unknown targets through the production host before batching', async () => {
    const holder = '12D3KooWBridgeAHolder';
    const localCgId = '0x0000000000000000000000000000000000000001/host-bridge';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchHostBridge',
      localCgId,
      peers: [holder],
      targetCount: 8,
      useRegisteredChainFootprints: true,
      onFetch: (_peerId, requested, recovered) => {
        for (const target of requested) recovered.add(target.ordinal);
        return 'found';
      },
    });
    agents.push(harness.agent);
    expect(Object.hasOwn(harness.chainAdapter, 'getKnowledgeAssetUpdateContext')).toBe(false);
    for (const target of harness.targets) {
      const kaId = BigInt(target.kaId);
      harness.chainAdapter.__registerKC({
        kaId,
        contextGraphId: harness.contextGraphId,
        merkleRootHex: `0x${(kaId + 1n).toString(16).padStart(64, '0')}`,
        chunks: [],
        byteSize: 1_024n,
        merkleLeafCount: 8,
      });
    }

    // Count the production host's reads without replacing the adapter
    // implementations: liveness, policy, and sizing all come from the actual
    // in-memory ContextGraph/KA state seeded above.
    const liveness = vi.spyOn(harness.chainAdapter, 'isContextGraphActiveOnChain');
    const policy = vi.spyOn(harness.chainAdapter, 'getContextGraphAccessPolicy');
    const updateContext = vi.spyOn(harness.chainAdapter, 'getKnowledgeAssetUpdateContext');
    const unknownTargets = harness.targets;

    await harness.internals.recoverVmReconcileBatch(
      localCgId,
      1n,
      unknownTargets,
      100,
      () => true,
    );

    expect(liveness).toHaveBeenCalledTimes(1);
    expect(liveness).toHaveBeenCalledWith(1n);
    expect(policy).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledWith(1n);
    // The single-KA probe is already admitted before sizing. Only the
    // compatible non-prefix population (ordinals 1..7) spends bounded reads.
    expect(updateContext).toHaveBeenCalledTimes(7);
    expect(updateContext.mock.calls.map(([kaId]) => kaId)).toEqual(
      unknownTargets.slice(1).map(({ kaId }) => BigInt(kaId)),
    );
    expect(harness.fetched).toEqual([
      { peerId: holder, uals: [unknownTargets[0]!.ual] },
      { peerId: holder, uals: unknownTargets.slice(1).map(({ ual }) => ual) },
    ]);
    expect(harness.fetched[1]!.uals.length).toBeGreaterThan(1);
  });

  it('does not perform optional footprint RPCs while exact recovery is cooling down', async () => {
    const holder = '12D3KooWBridgeCooldownHolder';
    const localCgId = '0x0000000000000000000000000000000000000001/host-bridge-cooldown';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchHostBridgeCooldown',
      localCgId,
      peers: [holder],
      targetCount: 3,
      onFetch: () => 'incomplete',
    });
    agents.push(harness.agent);
    const unknownTargets = harness.targets;
    harness.internals.vmReconcileFetchCooldownAt.set(localCgId, Date.now());
    const liveness = vi.spyOn(harness.chainAdapter, 'isContextGraphActiveOnChain');
    const policy = vi.spyOn(harness.chainAdapter, 'getContextGraphAccessPolicy');
    const updateContext = vi.spyOn(harness.chainAdapter, 'getKnowledgeAssetUpdateContext');

    const result = await harness.internals.recoverVmReconcileBatch(
      localCgId,
      1n,
      unknownTargets,
      100,
      () => true,
    );

    expect(result).toMatchObject({
      attemptedOrdinals: [],
      continuationOrdinal: 0,
      cooldownOnly: true,
    });
    expect(liveness).not.toHaveBeenCalled();
    expect(policy).not.toHaveBeenCalled();
    expect(updateContext).not.toHaveBeenCalled();
    expect(harness.fetched).toEqual([]);
  });

  it('requests ten 100-triple KAs as one probe followed by one nine-asset batch', async () => {
    const holder = '12D3KooWExactCountSmallHolder';
    const localCgId = '0x0000000000000000000000000000000000000001/exact-count-small';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchExactCountSmall',
      localCgId,
      peers: [holder],
      targetCount: 10,
      footprintForOrdinal: () => ({ byteSize: 8_192n, merkleLeafCount: 100n }),
      onFetch: (_peerId, requested, recovered) => {
        for (const target of requested) recovered.add(target.ordinal);
        return 'found';
      },
    });
    agents.push(harness.agent);

    const result = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, harness.targets, 100, () => true,
    );

    expect(harness.fetched.map(({ uals }) => uals.length)).toEqual([1, 9]);
    expect(result.attemptedOrdinals).toEqual(harness.targets.map(({ ordinal }) => ordinal));
  });

  it('requests one 500-triple probe and one eight-asset batch, then yields', async () => {
    const holder = '12D3KooWExactCountMediumHolder';
    const localCgId = '0x0000000000000000000000000000000000000001/exact-count-medium';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchExactCountMedium',
      localCgId,
      peers: [holder],
      targetCount: 10,
      footprintForOrdinal: () => ({ byteSize: 32_768n, merkleLeafCount: 500n }),
      onFetch: (_peerId, requested, recovered) => {
        for (const target of requested) recovered.add(target.ordinal);
        return 'found';
      },
    });
    agents.push(harness.agent);

    const result = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, harness.targets, 100, () => true,
    );

    expect(harness.fetched.map(({ uals }) => uals.length)).toEqual([1, 8]);
    expect(result.attemptedOrdinals).toEqual(
      harness.targets.slice(0, 9).map(({ ordinal }) => ordinal),
    );
    expect(result.continuationOrdinal).toBe(9);
  });

  it('commits found members but rotates unresolved members without false absence', async () => {
    const holder = '12D3KooWPartialAHolder';
    const fallback = '12D3KooWPartialZFallback';
    const localCgId = '0x0000000000000000000000000000000000000001/partial';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchPartialCoverage',
      localCgId,
      peers: [holder, fallback],
      targetCount: 6,
      onFetch: (peerId, requested, recovered) => {
        if (peerId === holder) {
          for (const target of requested) {
            if (target.ordinal <= 2) recovered.add(target.ordinal);
          }
          // Aggregate transfer success is intentionally insufficient evidence
          // that every requested UAL was present.
          return 'found';
        }
        for (const target of requested) recovered.add(target.ordinal);
        return 'found';
      },
    });
    agents.push(harness.agent);

    const first = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, harness.targets, 100, () => true,
    );

    expect(harness.fetched).toEqual([
      { peerId: holder, uals: [harness.targets[0]!.ual] },
      { peerId: holder, uals: harness.targets.slice(1).map(({ ual }) => ual) },
    ]);
    expect(first.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
    expect(first.outcomes.get(1)).toEqual({ status: 'reconciled', blockNumber: 100 });
    expect(first.outcomes.get(2)).toEqual({ status: 'reconciled', blockNumber: 100 });
    for (const ordinal of [3, 4, 5]) {
      expect(first.outcomes.get(ordinal)).toMatchObject({ status: 'pending' });
    }

    // A later bounded sweep supplies only the still-pending set. Rotation
    // evidence retained by #2183 selects the next provider; recovered members
    // are neither re-requested nor falsely credited as absent.
    const unresolved = [3, 4, 5].map((ordinal) => {
      const outcome = first.outcomes.get(ordinal);
      if (outcome?.status !== 'pending' || !outcome.recovery) {
        throw new Error(`expected pending recovery target for ordinal ${ordinal}`);
      }
      return outcome.recovery as RecoveryTarget;
    });
    const second = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, unresolved, 100, () => true,
    );

    expect(harness.fetched.slice(2)).toEqual([
      { peerId: fallback, uals: [unresolved[0]!.ual] },
      { peerId: fallback, uals: unresolved.slice(1).map(({ ual }) => ual) },
    ]);
    expect(second.attemptedOrdinals).toEqual(unresolved.map(({ ordinal }) => ordinal));
    expect([...second.outcomes.values()]).toEqual(
      unresolved.map(() => ({ status: 'reconciled', blockNumber: 100 })),
    );
  });

  it('revokes a proven-holder hint after an incomplete microbatch response', async () => {
    const holder = '12D3KooWIncompleteAHolder';
    const fallback = '12D3KooWIncompleteZFallback';
    const localCgId = '0x0000000000000000000000000000000000000001/incomplete';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchIncompleteRevocation',
      localCgId,
      peers: [holder, fallback],
      targetCount: 5,
      onFetch: (peerId, requested, recovered) => {
        if (peerId === holder && requested.length === 1 && requested[0]!.ordinal === 0) {
          recovered.add(0);
          return 'found';
        }
        if (peerId === holder) return 'incomplete';
        for (const target of requested) recovered.add(target.ordinal);
        return 'found';
      },
    });
    agents.push(harness.agent);

    const first = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, harness.targets, 100, () => true,
    );

    expect(harness.fetched).toEqual([
      { peerId: holder, uals: [harness.targets[0]!.ual] },
      { peerId: holder, uals: harness.targets.slice(1).map(({ ual }) => ual) },
    ]);
    expect(first.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
    for (const ordinal of [1, 2, 3, 4]) {
      expect(first.outcomes.get(ordinal)).toMatchObject({ status: 'pending' });
    }

    const unresolved = [1, 2, 3, 4].map((ordinal) => {
      const outcome = first.outcomes.get(ordinal);
      if (outcome?.status !== 'pending' || !outcome.recovery) {
        throw new Error(`expected pending recovery target for ordinal ${ordinal}`);
      }
      return outcome.recovery as RecoveryTarget;
    });
    const second = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, unresolved, 100, () => true,
    );

    // The old successful probe must not leave a stale holder preference after
    // the multi-UAL request becomes incomplete. The next sweep starts with the
    // unresolved set at the fallback and can establish a new local hint there.
    expect(harness.fetched.slice(2)).toEqual([
      { peerId: fallback, uals: [unresolved[0]!.ual] },
      { peerId: fallback, uals: unresolved.slice(1).map(({ ual }) => ual) },
    ]);
    expect(second.attemptedOrdinals).toEqual(unresolved.map(({ ordinal }) => ordinal));
    expect([...second.outcomes.values()]).toEqual(
      unresolved.map(() => ({ status: 'reconciled', blockNumber: 100 })),
    );
  });

  it('revokes a proven-holder hint when the reuse transport throws', async () => {
    const holder = '12D3KooWThrowingAHolder';
    const fallback = '12D3KooWThrowingZFallback';
    const localCgId = '0x0000000000000000000000000000000000000001/throwing-reuse';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchThrownReuseRevocation',
      localCgId,
      peers: [holder, fallback],
      targetCount: 5,
      onFetch: (peerId, requested, recovered) => {
        if (peerId === holder && requested.length === 1 && requested[0]!.ordinal === 0) {
          recovered.add(0);
          return 'found';
        }
        if (peerId === holder) throw new Error('stream reset');
        for (const target of requested) recovered.add(target.ordinal);
        return 'found';
      },
    });
    agents.push(harness.agent);

    const first = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, harness.targets, 100, () => true,
    );

    expect(harness.fetched).toEqual([
      { peerId: holder, uals: [harness.targets[0]!.ual] },
      { peerId: holder, uals: harness.targets.slice(1).map(({ ual }) => ual) },
    ]);
    expect(first.outcomes.get(0)).toEqual({ status: 'reconciled', blockNumber: 100 });
    const unresolved = harness.targets.slice(1).map((target) => {
      const outcome = first.outcomes.get(target.ordinal);
      if (outcome?.status !== 'pending' || !outcome.recovery) {
        throw new Error(`expected pending recovery target for ordinal ${target.ordinal}`);
      }
      return outcome.recovery as RecoveryTarget;
    });

    const second = await harness.internals.recoverVmReconcileBatch(
      localCgId, 1n, unresolved, 100, () => true,
    );

    expect(harness.fetched.slice(2)).toEqual([
      { peerId: fallback, uals: [unresolved[0]!.ual] },
      { peerId: fallback, uals: unresolved.slice(1).map(({ ual }) => ual) },
    ]);
    expect(second.attemptedOrdinals).toEqual(unresolved.map(({ ordinal }) => ordinal));
    expect([...second.outcomes.values()]).toEqual(
      unresolved.map(() => ({ status: 'reconciled', blockNumber: 100 })),
    );
  });

  it('stops after lifecycle abort without installing outcomes or starting another batch', async () => {
    const controller = new AbortController();
    const localCgId = '0x0000000000000000000000000000000000000001/abort';
    let reconcileCalls = 0;
    const harness = await createRecoveryHarness({
      name: 'MicrobatchAbort',
      localCgId,
      peers: ['12D3KooWMicrobatchAbortHolder'],
      targetCount: 5,
      onFetch: (_peerId, requested, recovered) => {
        for (const target of requested) recovered.add(target.ordinal);
        controller.abort();
        return 'found';
      },
    });
    agents.push(harness.agent);
    harness.internals.reconcileChainOrdinal = async () => {
      reconcileCalls += 1;
      return { status: 'reconciled', blockNumber: 100 };
    };

    const result = await harness.internals.recoverVmReconcileBatch(
      localCgId,
      1n,
      harness.targets,
      100,
      () => true,
      controller.signal,
    );

    expect(harness.fetched).toEqual([
      { peerId: '12D3KooWMicrobatchAbortHolder', uals: [harness.targets[0]!.ual] },
    ]);
    expect(reconcileCalls).toBe(0);
    expect(result.outcomes.size).toBe(0);
    expect(result.attemptedOrdinals).toEqual([]);
    expect(result.hasImmediateRecoveryWork).toBe(false);
  });

  it('retains no attempt evidence when stale at executor entry', async () => {
    const peerId = '12D3KooWStaleExecutorHolder';
    const localCgId = '0x0000000000000000000000000000000000000001/stale-entry';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchStaleEntry',
      localCgId,
      peers: [peerId],
      targetCount: 1,
      onFetch: () => {
        throw new Error('stale executor must not fetch');
      },
    });
    agents.push(harness.agent);
    const target = harness.targets[0]!;
    const slotKey = harness.internals.vmReconcileRotationSlotKey(target);
    const replication = vi.spyOn(
      harness.agent as unknown as { emitReplication(event: unknown): void },
      'emitReplication',
    );

    const result = await harness.internals.executeVmRecoveryBatch({
      localCgId,
      onChainCgId: 1n,
      peerId,
      attempts: [{
        entry: {
          index: 0,
          target,
          prepared: { slotKey, suppressed: false },
        },
        installedRecord: undefined,
        candidatePeerIds: [peerId],
      }],
      unavailablePeerIds: [],
      headBlock: 100,
      isRecoveryCurrent: () => false,
      ctx: createOperationContext('system'),
    });

    expect(result).toEqual({ kind: 'not-started-stale' });
    expect(harness.fetched).toEqual([]);
    expect(harness.internals.vmReconcileRotationState.size).toBe(0);
    expect(replication).not.toHaveBeenCalled();
  });

  it('does not let a stale attempt clear a replacement lifecycle cooldown', async () => {
    const peerId = '12D3KooWReplacementCooldownHolder';
    const localCgId = '0x0000000000000000000000000000000000000001/replacement-cooldown';
    const harness = await createRecoveryHarness({
      name: 'MicrobatchReplacementCooldown',
      localCgId,
      peers: [peerId],
      targetCount: 1,
      onFetch: () => {
        throw new Error('stale attempt must stop before exact fetch');
      },
    });
    agents.push(harness.agent);
    let enteredProtocolWait!: () => void;
    const protocolWaitEntered = new Promise<void>((resolve) => {
      enteredProtocolWait = resolve;
    });
    let releaseProtocolWait!: () => void;
    const protocolWaitRelease = new Promise<void>((resolve) => {
      releaseProtocolWait = resolve;
    });
    harness.internals.waitForSyncProtocol = async () => {
      enteredProtocolWait();
      await protocolWaitRelease;
      return true;
    };
    let firstLifecycleCurrent = true;

    const staleAttempt = harness.internals.recoverVmReconcileBatch(
      localCgId,
      1n,
      harness.targets,
      100,
      () => firstLifecycleCurrent,
    );
    await protocolWaitEntered;
    const staleOwner = harness.internals.vmReconcileFetchCooldownOwner.get(localCgId);
    expect(staleOwner).toBeDefined();

    firstLifecycleCurrent = false;
    harness.internals.clearVmReconcileActiveFetchCooldown(localCgId);
    expect(harness.internals.shouldRunVmReconcileActiveFetch(localCgId)).toBe(true);
    const replacementOwner = harness.internals.vmReconcileFetchCooldownOwner.get(localCgId);
    const replacementTimestamp = harness.internals.vmReconcileFetchCooldownAt.get(localCgId);
    expect(replacementOwner).toBeDefined();
    expect(replacementOwner).not.toBe(staleOwner);

    releaseProtocolWait();
    const result = await staleAttempt;

    expect(result.attemptedOrdinals).toEqual([]);
    expect(harness.fetched).toEqual([]);
    expect(harness.internals.vmReconcileFetchCooldownOwner.get(localCgId))
      .toBe(replacementOwner);
    expect(harness.internals.vmReconcileFetchCooldownAt.get(localCgId))
      .toBe(replacementTimestamp);
  });
});
