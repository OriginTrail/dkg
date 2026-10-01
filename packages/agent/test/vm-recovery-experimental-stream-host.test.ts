import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';
import { EXACT_BATCH_STREAM_PROTOCOL } from '../src/sync/exact-batch-stream-contract.js';
import { rememberExactBatchStreamResourceRefusal, rememberExactBatchStreamUnsupported } from '../src/sync/exact-batch-stream-capability.js';

const older = '12D3KooWAAStreamOlder';
const core = '12D3KooWZZStreamCore';
const cg = '0x0000000000000000000000000000000000000001/stream-profile';
const agents: Array<{ stop(): Promise<void> }> = [];

/** Planner/host fixture only: exact transport and ordinal chain outcomes are fixture ports. */
async function harness(options: { public?: boolean; core?: boolean; advertised?: boolean; unknown?: boolean; oversize?: boolean; soleCore?: boolean } = {}) {
  const h = await createVmRecoveryHostHarness({
    name: 'ExperimentalVmStreamProfile', localCgId: cg, peers: options.soleCore ? [core] : [older, core], targetCount: 13,
    accessPolicy: options.public === false ? 1 : 0,
    sizingUnavailable: options.unknown,
    footprintForOrdinal: () => ({ byteSize: (options.oversize ? 9n : 4n) * 1024n * 1024n, merkleLeafCount: 10_000n }),
    targetForOrdinal: ordinal => ({ localCgId: cg, onChainCgId: '1', ordinal,
      kaId: String(ordinal), merkleRoot: `root-${ordinal}`, reason: 'no-swm' as const,
      ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}` }),
    onFetch: (peer, targets, recovered) => {
      if (peer === older) return 'clean-absent';
      for (const target of targets) recovered.add(target.ordinal);
      return 'found';
    },
  });
  agents.push(h.agent);
  if (options.core !== false) h.internals.peerCapabilityRegistry.observe(core, { source: 'identify', protocols: [PROTOCOL_STORAGE_ACK] });
  vi.spyOn(h.agent, 'getPeerProtocols').mockImplementation(async peer => peer === core && options.advertised !== false ? [EXACT_BATCH_STREAM_PROTOCOL] : []);
  const authority = vi.spyOn(h.agent, 'resolveRegisteredContextGraphAuthority').mockResolvedValue(
    options.public === false ? { kind: 'private', onChainId: '1' } as never : { kind: 'public', onChainId: '1' } as never);
  const policy = vi.spyOn(h.agent, 'readLiveOnChainAccessPolicy');
  const streamOnly: boolean[] = [];
  const streamDisabled: boolean[] = [];
  const fetch = h.internals.syncExactKnowledgeAssetsFromPeerDetailed.bind(h.internals);
  h.internals.syncExactKnowledgeAssetsFromPeerDetailed = async (peer, graph, uals, requestOptions) => {
    streamOnly.push((requestOptions as { experimentalExactBatchStreamOnly?: boolean } | undefined)?.experimentalExactBatchStreamOnly === true);
    streamDisabled.push((requestOptions as { experimentalExactBatchStreamDisabled?: boolean } | undefined)?.experimentalExactBatchStreamDisabled === true);
    return fetch(peer, graph, uals, requestOptions);
  };
  return { ...h, authority, policy, streamOnly, streamDisabled };
}

afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  await Promise.all(agents.splice(0).map(agent => agent.stop()));
});

describe('experimental public Core streaming recovery host', () => {
  it('probes the supported Core first then streams ten large KAs without changing the proof roster', async () => {
    vi.stubEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM', '1');
    const h = await harness();
    const result = await h.run();
    expect(h.fetched.map(({ peerId, uals }) => [peerId, uals.length])).toEqual([[core, 1], [core, 10]]);
    expect(h.streamOnly).toEqual([false, true]);
    expect(h.streamDisabled).toEqual([false, false]);
    expect(h.authority).toHaveBeenCalledOnce(); expect(h.policy).not.toHaveBeenCalled();
    expect(h.maxActiveFetches()).toBe(1);
    expect(result.outcomes.size).toBe(11); expect(result.continuationOrdinal).toBe(11);
    expect(h.internals.preferredSyncPeers.get(cg)).toBe(older);
    for (const ordinal of [11, 12]) {
      const record = h.internals.vmReconcileRotationState.get(h.internals.vmReconcileRotationSlotKey(h.targets[ordinal]!))!;
      expect([...record.candidatePeerIds]).toEqual([older, core]);
      expect(record.attemptedPeerIds.size).toBe(0); expect(record.cleanAbsentPeerIds.size).toBe(0);
    }
  });

  it.each(['unset', '0', 'private', 'unknown-authority', 'no-protocol', 'not-core'] as const)('retains ordinary ordering/large-KA singleton limits when %s', async guard => {
    vi.stubEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM', guard === 'unset' ? undefined : guard === '0' ? '0' : '1');
    const h = await harness({ public: guard !== 'private', core: guard !== 'not-core', advertised: guard !== 'no-protocol' });
    if (guard === 'unknown-authority') h.authority.mockResolvedValue({ kind: 'unknown' } as never);
    await h.run();
    expect(h.fetched[0]!.peerId).toBe(older);
    expect(h.fetched.every(({ uals }) => uals.length === 1)).toBe(true);
    expect(h.streamOnly.every(flag => !flag)).toBe(true);
    if (guard === 'unset' || guard === '0' || guard === 'not-core' || guard === 'no-protocol') expect(h.authority).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'oversize'] as const)('retains legacy singleton wire for %s footprints even on a public supported Core', async footprint => {
    vi.stubEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM', '1');
    const h = await harness({ unknown: footprint === 'unknown', oversize: footprint === 'oversize' });
    await h.run();
    expect(h.fetched.map(({ peerId, uals }) => [peerId, uals.length])).toEqual([[core, 1], [core, 1]]);
    expect(h.streamOnly).toEqual([false, false]);
    expect(h.streamDisabled).toEqual([true, true]);
  });

  it('plans bounded ordinary recovery from the sole Core after a scoped resource refusal', async () => {
    vi.stubEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM', '1');
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
    expect(h.streamOnly).toEqual([false, false]);
    expect(h.streamDisabled).toEqual([true, true]);
    expect(h.maxActiveFetches()).toBe(1);
    expect(h.recovered).toEqual(new Set([0, 1]));
    expect(h.internals.peerCapabilityRegistry.supportsCore(core)).toBe(true);
  });

  it('leaves a stale unsupported advertisement eligible only for the ordinary smaller plan', async () => {
    vi.stubEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM', '1');
    const h = await harness();
    const connectionKey = h.internals.getSyncReconcilerConnectionKey(core);
    rememberExactBatchStreamUnsupported(h.agent, core, connectionKey, connectionKey, Date.now());
    await h.run();
    expect(h.fetched[0]!.peerId).toBe(older);
    expect(h.streamOnly.every(flag => !flag)).toBe(true);
    expect(h.fetched.every(({ uals }) => uals.length === 1)).toBe(true);
    expect(h.internals.peerCapabilityRegistry.supportsCore(core)).toBe(true);
  });
});
