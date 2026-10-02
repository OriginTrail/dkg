import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext, PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';
import type { ExactRecoveryTransportMode } from '../src/sync/requester/exact-recovery-transport.js';
import { EXACT_BATCH_STREAM_PROTOCOL } from '../src/sync/exact-batch-stream-contract.js';
import { rememberExactBatchStreamResourceRefusal, rememberExactBatchStreamUnsupported } from '../src/sync/exact-batch-stream-capability.js';

const older = '12D3KooWAAStreamOlder';
const core = '12D3KooWZZStreamCore';
const cg = '0x0000000000000000000000000000000000000001/stream-profile';
const agents: Array<{ stop(): Promise<void> }> = [];

/** Planner/host fixture only: exact transport and ordinal chain outcomes are fixture ports. */
async function harness(options: { public?: boolean; core?: boolean; advertised?: boolean; unknown?: boolean; oversize?: boolean; soleCore?: boolean; failCoreProbe?: boolean; targetCount?: number } = {}) {
  const h = await createVmRecoveryHostHarness({
    name: 'ExperimentalVmStreamProfile', localCgId: cg, peers: options.soleCore ? [core] : [older, core], targetCount: options.targetCount ?? 13,
    accessPolicy: options.public === false ? 1 : 0,
    sizingUnavailable: options.unknown,
    footprintForOrdinal: () => ({ byteSize: (options.oversize ? 9n : 4n) * 1024n * 1024n, merkleLeafCount: 10_000n }),
    targetForOrdinal: ordinal => ({ localCgId: cg, onChainCgId: '1', ordinal,
      kaId: String(ordinal), merkleRoot: `root-${ordinal}`, reason: 'no-swm' as const,
      ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}` }),
    onFetch: (peer, targets, recovered) => {
      if (peer === older) return 'clean-absent';
      if (options.failCoreProbe) return 'incomplete';
      for (const target of targets) recovered.add(target.ordinal);
      return 'found';
    },
  });
  agents.push(h.agent);
  if (options.core !== false) h.internals.peerCapabilityRegistry.observe(core, { source: 'identify-snapshot', protocols: [PROTOCOL_STORAGE_ACK] });
  vi.spyOn(h.agent, 'getPeerProtocols').mockImplementation(async peer => peer === core && options.advertised !== false ? [EXACT_BATCH_STREAM_PROTOCOL] : []);
  const authority = vi.spyOn(h.agent, 'resolveRegisteredContextGraphAuthority').mockResolvedValue(
    options.public === false ? { kind: 'private', onChainId: '1' } as never : { kind: 'public', onChainId: '1' } as never);
  const policy = vi.spyOn(h.agent, 'readLiveOnChainAccessPolicy');
  const transportModes: Array<ExactRecoveryTransportMode | undefined> = [];
  const attemptTimeouts: Array<{ peerId: string; totalTimeoutMs?: number }> = [];
  const fetch = h.internals.syncExactKnowledgeAssetsFromPeerDetailed.bind(h.internals);
  h.internals.syncExactKnowledgeAssetsFromPeerDetailed = async (peer, graph, uals, requestOptions) => {
    transportModes.push(requestOptions?.exactRecoveryTransportMode);
    attemptTimeouts.push({ peerId: peer, totalTimeoutMs: requestOptions?.totalTimeoutMs });
    return fetch(peer, graph, uals, requestOptions);
  };
  return { ...h, authority, policy, transportModes, attemptTimeouts };
}

afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  await Promise.all(agents.splice(0).map(agent => agent.stop()));
});

describe('experimental public Core streaming recovery host', () => {
  it('bounds the legacy peer after a failed public Core stream without shortening the Core attempt', async () => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
    const h = await harness({ failCoreProbe: true });
    await h.run();
    expect(h.attemptTimeouts[0]).toEqual({ peerId: core, totalTimeoutMs: undefined });
    expect(h.attemptTimeouts.some((attempt) => attempt.peerId === older
      && attempt.totalTimeoutMs === 120_000)).toBe(true);
  });

  it('does not restart a full legacy scan after an exact probe spends its shared deadline', async () => {
    const h = await harness();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const legacy = vi.spyOn(h.agent, 'runLegacyDurableSyncDetailed');
    h.internals.syncExactKnowledgeAssetsFromPeerDetailed = async (_peer, _graph, _uals, options) => {
      options?.onWorkStarted?.();
      clock.mockReturnValue(1_120_000);
      return {
        admission: 'work-started',
        result: {
          fetchedDataTriples: 0, fetchedMetaTriples: 0, insertedTriples: 0,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: 'incomplete',
        responderCapability: 'legacy-filter-unsupported',
      };
    };

    const result = await h.internals.executeVmRecoveryBatch({
      localCgId: cg,
      onChainCgId: h.contextGraphId,
      peerId: older,
      attempts: [{
        entry: { index: 0, target: h.targets[0]!, prepared: { slotKey: 'fixture', suppressed: false } },
        installedRecord: undefined,
        candidatePeerIds: [older, core],
      }],
      unavailablePeerIds: [],
      headBlock: 100,
      isRecoveryCurrent: () => true,
      ctx: createOperationContext('system'),
      exactRecoveryTransportMode: 'legacy',
      legacyAttemptTimeoutMs: 120_000,
    });

    expect(legacy).not.toHaveBeenCalled();
    expect(result.kind).toBe('completed');
    expect(h.recovered.size).toBe(0);
  });

  it('passes only the unused part of the exact-probe budget into a legacy fallback', async () => {
    const h = await harness();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const legacy = vi.spyOn(h.agent, 'runLegacyDurableSyncDetailed').mockResolvedValue({
      admission: 'work-started',
      result: {
        fetchedDataTriples: 0, fetchedMetaTriples: 0, insertedTriples: 0,
        failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
      },
    } as never);
    h.internals.syncExactKnowledgeAssetsFromPeerDetailed = async (_peer, _graph, _uals, options) => {
      options?.onWorkStarted?.();
      clock.mockReturnValue(1_045_000);
      return {
        admission: 'work-started',
        result: {
          fetchedDataTriples: 0, fetchedMetaTriples: 0, insertedTriples: 0,
          failedPeers: 0, failedPhases: 0, deferredBackpressure: 0,
        },
        disposition: 'incomplete',
        responderCapability: 'legacy-filter-unsupported',
      };
    };

    await h.internals.executeVmRecoveryBatch({
      localCgId: cg,
      onChainCgId: h.contextGraphId,
      peerId: older,
      attempts: [{
        entry: { index: 0, target: h.targets[0]!, prepared: { slotKey: 'fixture', suppressed: false } },
        installedRecord: undefined,
        candidatePeerIds: [older, core],
      }],
      unavailablePeerIds: [],
      headBlock: 100,
      isRecoveryCurrent: () => true,
      ctx: createOperationContext('system'),
      exactRecoveryTransportMode: 'legacy',
      legacyAttemptTimeoutMs: 120_000,
    });

    expect(legacy).toHaveBeenCalledOnce();
    expect(legacy.mock.calls[0]?.[6]).toMatchObject({ totalTimeoutMs: 75_000 });
  });

  it('retains the ordinary legacy budget when no stream Core is available', async () => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '0');
    const h = await harness();
    await h.run();
    expect(h.attemptTimeouts.length).toBeGreaterThan(0);
    expect(h.attemptTimeouts.every((attempt) => attempt.totalTimeoutMs === undefined)).toBe(true);
  });

  it('restores the full legacy probe budget after three physical attempts despite rotation reset', async () => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
    const h = await harness({ failCoreProbe: true, targetCount: 2 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      h.internals.recordVmReconcilePhysicalAttempt(h.targets[1]!, older);
    }
    h.internals.vmReconcileRotationState.clear();
    expect(h.internals.vmReconcilePhysicalAttemptOrdinal(h.targets[1]!, older)).toBe(3);
    await h.run();
    expect(h.attemptTimeouts.some((attempt) => attempt.peerId === older
      && attempt.totalTimeoutMs === undefined)).toBe(true);
  });

  it('eventually gives an unconfirmed-roster legacy holder a full attempt', async () => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
    const h = await harness({ failCoreProbe: true, targetCount: 2 });
    h.internals.resolveCuratorPeerIdsForCg = async () => ({
      peerIds: [older, core], curatorIsLocal: false, legacyTripleResolved: false, lookupFailed: true,
    });
    const fetch = h.internals.syncExactKnowledgeAssetsFromPeerDetailed;
    h.internals.syncExactKnowledgeAssetsFromPeerDetailed = async (peer, graph, uals, options) => {
      const result = await fetch(peer, graph, uals, options);
      if (peer === older && options?.totalTimeoutMs === undefined) {
        h.recovered.add(1);
        return { ...result, disposition: 'found', result: {
          ...result.result, fetchedDataTriples: 1, fetchedMetaTriples: 8, insertedTriples: 9,
        } };
      }
      return result;
    };

    for (let pass = 0; pass < 4; pass += 1) {
      // The absence-proof record can expire or be evicted between sweeps; the
      // admitted physical-attempt cadence remains independent of that record.
      h.internals.vmReconcileRotationState.clear();
      h.internals.vmReconcileRotationAdmissionCursorByCg.set(cg, 0);
      h.internals.clearVmReconcileActiveFetchCooldown(cg);
      await h.run();
    }

    const legacyAttempts = h.attemptTimeouts.filter((attempt) => attempt.peerId === older);
    expect(legacyAttempts.map((attempt) => attempt.totalTimeoutMs)).toEqual([
      120_000, 120_000, 120_000, undefined,
    ]);
    expect(h.recovered.has(1)).toBe(true);
  });

  it('probes the supported Core first then streams ten large KAs without changing the proof roster', async () => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
    const h = await harness();
    const sizing = vi.spyOn(h.chainAdapter, 'getKnowledgeAssetUpdateContext');
    const result = await h.run();
    expect(h.fetched.map(({ peerId, uals }) => [peerId, uals.length])).toEqual([[core, 1], [core, 10]]);
    expect(h.transportModes).toEqual(['stream-preferred', 'stream-required']);
    expect(h.authority).toHaveBeenCalledOnce(); expect(h.policy).not.toHaveBeenCalled();
    // The probe observes one KA; the compatible holder prefix spends at most
    // ten reads. Untouched suffix ordinals retain their independent turn.
    expect(sizing.mock.calls.map(([id]) => id)).toEqual(Array.from({ length: 11 }, (_, ordinal) => BigInt(ordinal)));
    expect(h.maxActiveFetches()).toBe(1);
    expect(result.outcomes.size).toBe(11); expect(result.continuationOrdinal).toBe(11);
    expect(h.internals.preferredSyncPeers.get(cg)).toBe(older);
    for (const ordinal of [11, 12]) {
      const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[ordinal]!))!;
      expect([...record.candidatePeerIds]).toEqual([older, core]);
      expect(record.attemptedPeerIds.size).toBe(0); expect(record.cleanAbsentPeerIds.size).toBe(0);
    }
  });

  it('streams when only the name the switch was first deployed under is set', async () => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', undefined);
    vi.stubEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM', '1');
    const h = await harness();
    await h.run();
    expect(h.fetched.map(({ peerId, uals }) => [peerId, uals.length])).toEqual([[core, 1], [core, 10]]);
    expect(h.transportModes).toEqual(['stream-preferred', 'stream-required']);
  });

  it.each(['unset', '0', 'private', 'unknown-authority', 'no-protocol', 'not-core'] as const)('retains ordinary ordering/large-KA singleton limits when %s', async guard => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', guard === 'unset' ? undefined : guard === '0' ? '0' : '1');
    const h = await harness({ public: guard !== 'private', core: guard !== 'not-core', advertised: guard !== 'no-protocol' });
    if (guard === 'unknown-authority') h.authority.mockResolvedValue({ kind: 'unknown' } as never);
    await h.run();
    expect(h.fetched[0]!.peerId).toBe(older);
    expect(h.fetched.every(({ uals }) => uals.length === 1)).toBe(true);
    expect(h.transportModes.every(mode => mode === 'legacy')).toBe(true);
    expect(h.attemptTimeouts.every((attempt) => attempt.totalTimeoutMs === undefined)).toBe(true);
    if (guard === 'unset' || guard === '0' || guard === 'not-core' || guard === 'no-protocol') expect(h.authority).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'oversize'] as const)('retains legacy singleton wire for %s footprints even on a public supported Core', async footprint => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
    const h = await harness({ unknown: footprint === 'unknown', oversize: footprint === 'oversize' });
    await h.run();
    expect(h.fetched.map(({ peerId, uals }) => [peerId, uals.length])).toEqual([[core, 1], [core, 1]]);
    expect(h.transportModes).toEqual(['legacy', 'legacy']);
  });

  it('plans bounded ordinary recovery from the sole Core after a scoped resource refusal', async () => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
    const h = await harness({ soleCore: true });
    // This fixture owns scheduling, while scope capture/settlement and the real
    // embedded responder are exercised separately by the lifecycle suites.
    const scope = Object.freeze({ contextGraphId: cg, bindingKey: 'fixture-binding-scope' });
    vi.spyOn(h.agent, 'captureExperimentalExactBatchRefusalScope').mockReturnValue(scope);
    const connectionKey = h.internals.getSyncReconcilerConnectionKey(core);
    rememberExactBatchStreamResourceRefusal(h.agent, core, connectionKey, connectionKey,
      // The default recovery cadence plus jitter may exceed one minute.
      scope, scope, Date.now() - 75_000);
    await h.run();
    expect(h.fetched.map(({ peerId, uals }) => [peerId, uals.length])).toEqual([[core, 1], [core, 1]]);
    expect(h.transportModes).toEqual(['legacy', 'legacy']);
    expect(h.maxActiveFetches()).toBe(1);
    expect(h.recovered).toEqual(new Set([0, 1]));
    expect(h.internals.peerCapabilityRegistry.supportsCore(core)).toBe(true);
  });

  it('leaves a stale unsupported advertisement eligible only for the ordinary smaller plan', async () => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
    const h = await harness();
    const connectionKey = h.internals.getSyncReconcilerConnectionKey(core);
    rememberExactBatchStreamUnsupported(h.agent, core, connectionKey, connectionKey, Date.now());
    await h.run();
    expect(h.fetched[0]!.peerId).toBe(older);
    expect(h.transportModes.every(mode => mode === 'legacy')).toBe(true);
    expect(h.fetched.every(({ uals }) => uals.length === 1)).toBe(true);
    expect(h.internals.peerCapabilityRegistry.supportsCore(core)).toBe(true);
  });
});
