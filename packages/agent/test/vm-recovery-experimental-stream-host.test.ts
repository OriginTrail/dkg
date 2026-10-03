import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext, PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';
import type { ExactBatchStreamOutcome, ExactRecoveryTransportMode } from '../src/sync/requester/exact-recovery-transport.js';
import { VmRecoveryProviderPolicy } from '../src/vm-recovery-provider-policy.js';
import { VM_RECOVERY_STREAM_SETBACK_LIMITS } from '../src/vm-recovery-stream-setback-policy.js';
import { EXACT_BATCH_STREAM_PROTOCOL } from '../src/sync/exact-batch-stream-contract.js';
import { rememberExactBatchStreamResourceRefusal, rememberExactBatchStreamUnsupported } from '../src/sync/exact-batch-stream-capability.js';

const older = '12D3KooWAAStreamOlder';
const olderB = '12D3KooWBBStreamOlder';
const olderC = '12D3KooWCCStreamOlder';
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
      h.internals.vmReconcileTransportBudgetPolicy.recordAdmitted(h.targets[1]!, older);
    }
    h.internals.vmReconcileRotationState.clear();
    expect(h.internals.vmReconcileTransportBudgetPolicy.attemptOrdinal(h.targets[1]!, older)).toBe(3);
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

/**
 * Stream-capable Cores among peers that only speak the ordinary wire. A stream
 * answer is scripted per Core, `complete` when its script is empty; the other
 * peers never hold the asset, and each of their probes takes `legacyProbeMs`
 * of the recovery clock, which nothing else moves.
 */
async function streamHolderHarness(options: {
  legacyPeers?: readonly string[];
  streamPeers?: readonly string[];
  legacyProbeMs?: number;
  targetCount?: number;
} = {}) {
  vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
  const legacyPeers = options.legacyPeers ?? [older, olderB];
  const streamPeers = options.streamPeers ?? [core];
  const clock = { now: 1_000_000, legacyProbeMs: options.legacyProbeMs ?? 61_000 };
  const answers = new Map<string, ExactBatchStreamOutcome[]>(streamPeers.map(peer => [peer, []]));
  const alwaysBusy = new Set<string>();
  let lastAnswer: ExactBatchStreamOutcome = 'complete';
  const h = await createVmRecoveryHostHarness({
    name: 'StreamHolderSetback', localCgId: cg, peers: [...legacyPeers, ...streamPeers], targetCount: options.targetCount ?? 13,
    footprintForOrdinal: () => ({ byteSize: 4n * 1024n * 1024n, merkleLeafCount: 10_000n }),
    targetForOrdinal: ordinal => ({ localCgId: cg, onChainCgId: '1', ordinal,
      kaId: String(ordinal), merkleRoot: `root-${ordinal}`, reason: 'no-swm' as const,
      ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}` }),
    onFetch: (peer, targets, recovered) => {
      if (!streamPeers.includes(peer)) { clock.now += clock.legacyProbeMs; return 'clean-absent'; }
      lastAnswer = alwaysBusy.has(peer) ? 'responder-busy' : answers.get(peer)!.shift() ?? 'complete';
      if (lastAnswer !== 'complete') return 'incomplete';
      for (const target of targets) recovered.add(target.ordinal);
      return 'found';
    },
  });
  agents.push(h.agent);
  h.internals.vmReconcileRotationNow = () => clock.now;
  for (const peer of streamPeers) {
    h.internals.peerCapabilityRegistry.observe(peer, { source: 'identify-snapshot', protocols: [PROTOCOL_STORAGE_ACK] });
  }
  vi.spyOn(h.agent, 'getPeerProtocols').mockImplementation(async peer => streamPeers.includes(peer) ? [EXACT_BATCH_STREAM_PROTOCOL] : []);
  vi.spyOn(h.agent, 'resolveRegisteredContextGraphAuthority').mockResolvedValue({ kind: 'public', onChainId: '1' } as never);
  const asked: Array<readonly [peer: string, assets: number, mode: ExactRecoveryTransportMode | undefined]> = [];
  const fetch = h.internals.syncExactKnowledgeAssetsFromPeerDetailed.bind(h.internals);
  h.internals.syncExactKnowledgeAssetsFromPeerDetailed = async (peer, graph, uals, requestOptions) => {
    const mode = requestOptions?.exactRecoveryTransportMode;
    asked.push([peer, (uals as readonly string[]).length, mode]);
    const result = await fetch(peer, graph, uals, requestOptions);
    // Only an exchange over the stream reports a stream outcome.
    return streamPeers.includes(peer) && mode !== 'legacy' ? { ...result, streamOutcome: lastAnswer } : result;
  };
  const info = vi.spyOn((h.agent as unknown as { log: { info: (...args: unknown[]) => void } }).log, 'info');
  return {
    ...h, clock, asked, alwaysBusy,
    coreAnswers: answers.get(core)!,
    /** The next pass over the targets still missing, as the reconciler would start it; resolves with whom it asked. */
    runPending: async () => {
      const before = asked.length;
      h.internals.clearVmReconcileActiveFetchCooldown(cg);
      await h.internals.recoverVmReconcileBatch(cg, h.contextGraphId,
        h.targets.filter(target => !h.recovered.has(target.ordinal)), 100, () => true);
      return asked.slice(before);
    },
    record: (ordinal: number) => h.internals.vmReconcileRotationState.get(
      h.internals.vmReconcileRotationSlotKey(h.targets[ordinal]!)),
    /** The peers asked for one target, in order. */
    askedFor: (ordinal: number) => h.fetched.filter(({ uals }) => uals.includes(h.targets[ordinal]!.ual)).map(({ peerId }) => peerId),
    setbackLines: () => info.mock.calls.map(([, message]) => String(message))
      .filter(line => line.startsWith('VM exact recovery stream setback for')),
  };
}

describe('a stream Core whose attempt ended without a verdict on its data', () => {
  const { holdOffMs, maxInterruptedInStreak } = VM_RECOVERY_STREAM_SETBACK_LIMITS;
  const peersOf = (pass: ReadonlyArray<readonly [string, number, unknown]>) => pass.map(([peer]) => peer);

  it('is asked again on the stream within the same pass, after one other peer, when it answered busy', async () => {
    const h = await streamHolderHarness();
    h.coreAnswers.push('responder-busy');
    expect(await h.runPending()).toEqual([
      [core, 1, 'stream-preferred'],
      // One peer without the stream is probed while the Core is left alone.
      [older, 1, 'legacy'],
      [core, 1, 'stream-preferred'],
      [core, 10, 'stream-required'],
    ]);
    // The asset of the refused probe kept its turn at the Core; the other peer's answer is recorded as usual.
    expect([...h.record(0)!.attemptedPeerIds]).toEqual([]);
    expect([...h.record(1)!.attemptedPeerIds]).toEqual([older]);
    expect([...h.record(1)!.cleanAbsentPeerIds]).toEqual([older]);
    expect(h.setbackLines()).toEqual([
      `VM exact recovery stream setback for "${cg}" from ${core.slice(-8)}: kind=responder-busy assets=1 keepsTurn=1 holdOffMs=${holdOffMs}`,
    ]);

    // The Core has served since: the next pass goes straight back to it for both assets still missing.
    expect(peersOf(await h.runPending())).toEqual([core]);
    expect(h.recovered.size).toBe(13);
  });

  it('is left alone until its hold-off has passed, and keeps one of the pass\'s peer slots meanwhile', async () => {
    // The other peers answer at once here, so no time passes inside a pass.
    const h = await streamHolderHarness({ legacyPeers: [older, olderB, olderC], legacyProbeMs: 0 });
    h.coreAnswers.push('responder-busy');
    // Three peers at most per pass: the Core and two others. The Core is not asked twice.
    expect(peersOf(await h.runPending())).toEqual([core, older, olderB]);

    // A pass that starts inside the hold-off still keeps the Core's slot: two other peers, not three.
    h.clock.now += holdOffMs - 1;
    const during = peersOf(await h.runPending());
    expect(during).toHaveLength(2);
    expect(during).not.toContain(core);

    h.clock.now += 1;
    expect((await h.runPending())[0]).toEqual([core, 1, 'stream-preferred']);
  });

  it('lets an asset ask its other peers before it returns to a Core that stays busy', async () => {
    const h = await streamHolderHarness({ targetCount: 1 });
    h.alwaysBusy.add(core);
    for (let pass = 0; pass < 5; pass += 1) {
      await h.runPending();
      h.clock.now += holdOffMs;
    }
    // Never twice in a row at the busy Core while another peer has not been asked.
    expect(h.askedFor(0)).toEqual([core, older, core, olderB, core]);
    // Its turn at the Core is still open: the cycle did not complete, so it is not backing off.
    expect(h.record(0)).toMatchObject({ phase: 'collecting' });
    expect(h.record(0)!.attemptedPeerIds.has(core)).toBe(false);
  });

  it('goes to another stream Core that has served instead of back to the busy one', async () => {
    // The busy Core sorts first, so it is the first stream peer of the roster.
    const busyCore = '12D3KooWYYStreamCore';
    const h = await streamHolderHarness({ legacyPeers: [older], streamPeers: [busyCore, core] });
    h.alwaysBusy.add(busyCore);
    expect(await h.runPending()).toEqual([
      [busyCore, 1, 'stream-preferred'],
      [core, 1, 'stream-preferred'],
      [core, 10, 'stream-required'],
    ]);
    // Past the hold-off the busy Core could be asked again. Both assets still
    // missing go to the Core that served: the one the busy Core was asked for,
    // and the one no peer was asked for yet.
    h.clock.now += holdOffMs;
    expect(await h.runPending()).toEqual([[core, 2, 'stream-required']]);
    expect(h.recovered.size).toBe(13);
  });

  it('asks the stream Core that last served this graph before another stream Core', async () => {
    const otherCore = '12D3KooWYYStreamCore';
    const h = await streamHolderHarness({ legacyPeers: [older], streamPeers: [otherCore, core] });
    const first = () => h.internals.selectVmReconcileExactCandidate(undefined, [older, otherCore, core],
      new VmRecoveryProviderPolicy(), { localCgId: cg, onChainCgId: '1', experimentalStreamPeerIds: new Set([otherCore, core]) });
    // Roster order while neither has served.
    expect(first()).toBe(otherCore);
    expect(h.internals.vmReconcilePublicCoreTransportPreferencePolicy.remember(
      cg, '1', core, h.internals.getSyncReconcilerConnectionKey(core))).toBe(true);
    expect(first()).toBe(core);
  });

  it('costs its assets their turn, as before, when the stream broke and the Core has not served this graph', async () => {
    const h = await streamHolderHarness();
    h.coreAnswers.push('stream-interrupted');
    // Spent for this pass even though a minute passes on each other probe.
    expect(peersOf(await h.runPending())).toEqual([core, older, olderB]);
    expect([...h.record(0)!.attemptedPeerIds]).toEqual([core]);
    expect(h.setbackLines()).toEqual([
      `VM exact recovery stream setback for "${cg}" from ${core.slice(-8)}: kind=stream-interrupted assets=1 keepsTurn=0 holdOffMs=0`,
    ]);
  });

  it('keeps the turn when the stream of a Core that has served breaks, a bounded number of times in a row', async () => {
    // Twelve assets: the first pass recovers eleven and leaves exactly one.
    const h = await streamHolderHarness({ targetCount: 12 });
    expect(await h.runPending()).toEqual([[core, 1, 'stream-preferred'], [core, 10, 'stream-required']]);
    const last = 11;
    expect(h.recovered.has(last)).toBe(false);

    for (let broken = 1; broken <= maxInterruptedInStreak; broken += 1) {
      h.coreAnswers.push('stream-interrupted');
      expect(peersOf(await h.runPending())).toEqual([core]);
      // The asset keeps its turn at the Core, and asks another peer before it returns to it.
      expect(h.record(last)!.attemptedPeerIds.has(core)).toBe(false);
      h.clock.now += holdOffMs;
      expect(peersOf(await h.runPending())).toHaveLength(1);
      expect(peersOf(h.asked.slice(-1))).not.toContain(core);
    }

    // One break too many: the Core's turn is spent, which completes the cycle and backs the asset off.
    h.coreAnswers.push('stream-interrupted');
    expect(peersOf(await h.runPending())).toEqual([core]);
    expect(h.record(last)!.attemptedPeerIds.has(core)).toBe(true);
    expect(h.record(last)).toMatchObject({ phase: 'backoff', backoffKind: 'incomplete-cycle' });
    expect(h.askedFor(last)).toEqual([core, older, core, olderB, core]);
    expect(h.setbackLines().map(line => /keepsTurn=(\d)/.exec(line)![1]))
      .toEqual([...Array.from({ length: maxInterruptedInStreak }, () => '1'), '0']);
  });

  it.each(['the graph\'s recovery state is cleared', 'recovery is closed'] as const)(
    'is no longer held off once %s', async (boundary) => {
      const h = await streamHolderHarness({ legacyProbeMs: 0 });
      h.coreAnswers.push('responder-busy');
      expect(peersOf(await h.runPending())).toEqual([core, older, olderB]);

      if (boundary === 'recovery is closed') {
        h.internals.closeVmReconcileRotationState();
        h.internals.openVmReconcileRotationState();
      } else {
        h.internals.clearVmReconcileRotationStateForContextGraph(cg);
      }
      // No time has passed: only the forgotten hold-off lets the Core be asked first again.
      expect((await h.runPending())[0]).toEqual([core, 1, 'stream-preferred']);
    });

  it('does not let a failing log sink change what a setback costs', async () => {
    const h = await streamHolderHarness();
    const log = (h.agent as unknown as { log: { info: (...args: unknown[]) => void } }).log;
    vi.mocked(log.info).mockImplementation((_context: unknown, message: unknown) => {
      if (String(message).includes('stream setback')) throw new Error('sink failed');
    });
    h.coreAnswers.push('responder-busy');
    expect(peersOf(await h.runPending())).toEqual([core, older, core, core]);
    expect([...h.record(0)!.attemptedPeerIds]).toEqual([]);
  });
});
