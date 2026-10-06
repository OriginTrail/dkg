/** A transient miss of the registered-public observation must not pin a whole recovery pass to the legacy wire. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_STORAGE_ACK } from '@origintrail-official/dkg-core';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';
import type { ExactRecoveryTransportMode } from '../src/sync/requester/exact-recovery-transport.js';
import { EXACT_BATCH_STREAM_PROTOCOL } from '../src/sync/exact-batch-stream-contract.js';
import { vmRecoveryPreparationFor } from '../src/vm-recovery-preparation.js';
import type { VmRecoveryRegisteredPublicEvidence } from '../src/vm-recovery-pass-authority.js';

const older = '12D3KooWAAStreamOlder';
const core = '12D3KooWZZStreamCore';
const cg = '0x0000000000000000000000000000000000000001/stream-evidence';
const agents: Array<{ stop(): Promise<void> }> = [];

const unavailable = { kind: 'unavailable', onChainId: 1n, reason: 'chain-access-policy-unavailable' } as never;
const available = { kind: 'public', onChainId: 1n } as never;

async function harness(options: { retryIntervalMs?: number; olderDelayMs?: number } = {}) {
  // These fixtures pin the recovery executor's own authority reads (one per pass, and none on an
  // ordinary pass). The holder tier reads the graph's access policy through the same resolver, once
  // per refresh, and would be counted as one of them; it has its own wiring tests
  // (vm-reconcile-holder-tier-agent.test.ts), so these hosts run without it.
  vi.stubEnv('DKG_VM_RECONCILE_HOLDER_TIER', '0');
  const h = await createVmRecoveryHostHarness({
    name: 'StreamEvidenceRetry', localCgId: cg, peers: [older, core], targetCount: 13,
    footprintForOrdinal: () => ({ byteSize: 4n * 1024n * 1024n, merkleLeafCount: 10_000n }),
    targetForOrdinal: ordinal => ({ localCgId: cg, onChainCgId: '1', ordinal,
      kaId: String(ordinal), merkleRoot: `root-${ordinal}`, reason: 'no-swm' as const,
      ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}` }),
    onFetch: async (peer, targets, recovered) => {
      if (peer === older) {
        // A slow legacy provider: its attempt can outlast the retry spacing.
        if (options.olderDelayMs) await new Promise(resolve => setTimeout(resolve, options.olderDelayMs));
        return 'clean-absent';
      }
      for (const target of targets) recovered.add(target.ordinal);
      return 'found';
    },
  });
  agents.push(h.agent);
  h.internals.peerCapabilityRegistry.observe(core, { source: 'identify-snapshot', protocols: [PROTOCOL_STORAGE_ACK] });
  vi.spyOn(h.agent, 'getPeerProtocols').mockImplementation(async peer => peer === core ? [EXACT_BATCH_STREAM_PROTOCOL] : []);
  const authority = vi.spyOn(h.agent, 'resolveRegisteredContextGraphAuthority');
  const transportModes: Array<ExactRecoveryTransportMode | undefined> = [];
  /** What each exchange was handed by its pass, and whether that was usable while the exchange ran. */
  const handedOver: Array<{ evidence: VmRecoveryRegisteredPublicEvidence | undefined; usableDuring: boolean | undefined }> = [];
  const fetch = h.internals.syncExactKnowledgeAssetsFromPeerDetailed.bind(h.internals);
  h.internals.syncExactKnowledgeAssetsFromPeerDetailed = async (peer, graph, uals, requestOptions) => {
    transportModes.push(requestOptions?.exactRecoveryTransportMode);
    const evidence = requestOptions?.registeredPublicEvidence;
    handedOver.push({ evidence, usableDuring: evidence?.usableFor(cg, requestOptions?.signal) });
    return fetch(peer, graph, uals, requestOptions);
  };
  if (options.retryIntervalMs !== undefined) {
    // Pre-create the host's owner with a test spacing; the host reuses it. Its reader looks the
    // adapter method up when it reads, so a test that instruments the adapter after the harness
    // is built still sees the owner's speculative reads and not only the planner's live ones.
    vmRecoveryPreparationFor(h.agent, { readUpdateContext: (id, readOptions) => h.chainAdapter.getKnowledgeAssetUpdateContext!(id, readOptions) },
      { authorityRetryMinIntervalMs: options.retryIntervalMs });
  }
  return { ...h, authority, transportModes, handedOver };
}

afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  await Promise.all(agents.splice(0).map(agent => agent.stop()));
});

describe('registered-public observation gating the stream wire', () => {
  it('keeps the original single read per pass, and the legacy wire, when preparation is off', async () => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
    const h = await harness();
    h.authority.mockResolvedValueOnce(unavailable).mockResolvedValue(available);
    await h.run();
    expect(h.authority).toHaveBeenCalledOnce();
    expect(h.fetched[0]!.peerId).toBe(older);
    expect(h.transportModes.every(mode => mode === 'legacy')).toBe(true);
  });

  it('asks once more at pass start, then uses the stream wire from the first provider', async () => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
    vi.stubEnv('DKG_VM_RECOVERY_PREFETCH_ENABLED', '1');
    const h = await harness({ retryIntervalMs: 40 });
    h.authority.mockResolvedValueOnce(unavailable).mockResolvedValue(available);
    await h.run();
    expect(h.authority).toHaveBeenCalledTimes(2);
    // With the observation restored the advertised Core is chosen first, as on a healthy pass.
    expect(h.fetched.map(({ peerId, uals }) => [peerId, uals.length])).toEqual([[core, 1], [core, 10]]);
    expect(h.transportModes).toEqual(['stream-preferred', 'stream-required']);
  });

  it('restores the stream wire for the later providers when the observation recovers during the pass', async () => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
    vi.stubEnv('DKG_VM_RECOVERY_PREFETCH_ENABLED', '1');
    const h = await harness({ retryIntervalMs: 30, olderDelayMs: 80 });
    // Both reads at pass start miss, the first provider (legacy only) takes longer than the
    // retry spacing, and the read made before the next provider answers.
    h.authority.mockResolvedValueOnce(unavailable).mockResolvedValueOnce(unavailable).mockResolvedValue(available);
    await h.run();

    expect(h.authority.mock.calls.length).toBeGreaterThanOrEqual(3);
    const peers = h.fetched.map(({ peerId }) => peerId);
    expect(peers[0]).toBe(older);
    // The first attempt could only use the legacy wire; once the observation recovered, the
    // advertised Core is chosen on the stream wire for the rest of the pass.
    expect(h.transportModes[0]).toBe('legacy');
    const coreAttempts = h.fetched.flatMap(({ peerId }, index) => (peerId === core ? [index] : []));
    expect(coreAttempts.length).toBeGreaterThan(0);
    for (const index of coreAttempts) {
      expect(['stream-preferred', 'stream-required']).toContain(h.transportModes[index]);
    }
  });

  it('starts the next-batch sizing reads only after the first read of the observation', async () => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
    vi.stubEnv('DKG_VM_RECOVERY_PREFETCH_ENABLED', '1');
    const h = await harness({ retryIntervalMs: 40 });
    const events: string[] = [];
    h.authority.mockImplementation(async () => { events.push('authority'); return available; });
    const original = h.chainAdapter.getKnowledgeAssetUpdateContext!.bind(h.chainAdapter);
    h.chainAdapter.getKnowledgeAssetUpdateContext = async (kaId, readOptions) => {
      events.push(`read:${kaId}`);
      return original(kaId, readOptions);
    };
    await h.run();
    // The first target is the probe's own asset and keeps its live read; every other target of the
    // pass is read only by the preparation owner (its hints are then consumed, never re-read live),
    // so a `read:1` can only be a speculative read. It must be visible, and it must follow the read
    // that gates the wire: that read is never queued behind speculative sizing.
    expect(events).toContain('read:1');
    expect(events[0]).toBe('authority');
    expect(events.indexOf('authority')).toBeLessThan(events.indexOf('read:1'));
  });

  it('never reads it more often than the spacing allows', async () => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
    vi.stubEnv('DKG_VM_RECOVERY_PREFETCH_ENABLED', '1');
    const h = await harness({ retryIntervalMs: 60 });
    h.authority.mockResolvedValue(unavailable);
    await h.run();
    // One read at pass start and one after the wait; the attempts that follow come back
    // within the spacing, so none of them reads again.
    expect(h.authority).toHaveBeenCalledTimes(2);
    expect(h.transportModes.every(mode => mode === 'legacy')).toBe(true);
  });

  it('stays bounded by the number of provider attempts when the observation never recovers', async () => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
    vi.stubEnv('DKG_VM_RECOVERY_PREFETCH_ENABLED', '1');
    const h = await harness({ retryIntervalMs: 0 });
    h.authority.mockResolvedValue(unavailable);
    await h.run();
    expect(h.authority.mock.calls.length).toBeLessThanOrEqual(h.fetched.length + 2);
    expect(h.transportModes.every(mode => mode === 'legacy')).toBe(true);
  });

  it('does not treat a private graph as a transient miss', async () => {
    vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
    vi.stubEnv('DKG_VM_RECOVERY_PREFETCH_ENABLED', '1');
    const h = await harness({ retryIntervalMs: 40 });
    h.authority.mockResolvedValue({ kind: 'private', onChainId: 1n } as never);
    await h.run();
    expect(h.authority).toHaveBeenCalledOnce();
    expect(h.transportModes.every(mode => mode === 'legacy')).toBe(true);
  });

  describe('hand-off of the answer to the pass\'s own exchange', () => {
    const nextPass = (h: Awaited<ReturnType<typeof harness>>) => h.internals.recoverVmReconcileBatch(
      cg, h.contextGraphId, h.targets.filter(item => !h.recovered.has(item.ordinal)), 100, () => true);

    it('hands each exchange its pass\'s fresh answer while it runs, and revokes it afterwards', async () => {
      vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
      vi.stubEnv('DKG_VM_RECOVERY_PREFETCH_ENABLED', '1');
      const h = await harness();
      h.authority.mockResolvedValue(available);
      await h.run();
      expect(h.handedOver.length).toBeGreaterThan(0);
      for (const { evidence, usableDuring } of h.handedOver) {
        expect(evidence).toBeDefined();
        expect(usableDuring).toBe(true);
      }
      // The pass is over: nothing it handed out can be relied on again.
      for (const { evidence } of h.handedOver) expect(evidence!.usableFor(cg)).toBe(false);
    });

    it('hands nothing when preparation is off', async () => {
      vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
      const h = await harness();
      h.authority.mockResolvedValue(available);
      await h.run();
      expect(h.handedOver.length).toBeGreaterThan(0);
      for (const { evidence } of h.handedOver) expect(evidence).toBeUndefined();
    });

    it('never makes an unavailable or private answer usable', async () => {
      vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
      vi.stubEnv('DKG_VM_RECOVERY_PREFETCH_ENABLED', '1');
      for (const answer of [unavailable, { kind: 'private', onChainId: 1n } as never]) {
        const h = await harness({ retryIntervalMs: 40 });
        h.authority.mockResolvedValue(answer);
        await h.run();
        expect(h.handedOver.length).toBeGreaterThan(0);
        for (const { usableDuring } of h.handedOver) expect(usableDuring).toBe(false);
      }
    });

    it('gives the next pass its own answer: one that no longer sees a public graph gets nothing usable', async () => {
      vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
      vi.stubEnv('DKG_VM_RECOVERY_PREFETCH_ENABLED', '1');
      const h = await harness({ retryIntervalMs: 40 });
      h.authority.mockResolvedValue(available);
      await h.run();
      expect(h.handedOver.every(({ usableDuring }) => usableDuring === true)).toBe(true);
      const firstPass = h.handedOver.length;
      h.authority.mockResolvedValue({ kind: 'private', onChainId: 1n } as never);
      await nextPass(h);
      const secondPass = h.handedOver.slice(firstPass);
      expect(secondPass.length).toBeGreaterThan(0);
      for (const { usableDuring } of secondPass) expect(usableDuring).toBe(false);
    });

    it('never carries an answer from one pass into a pass that reads nothing', async () => {
      vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
      vi.stubEnv('DKG_VM_RECOVERY_PREFETCH_ENABLED', '1');
      const h = await harness({ retryIntervalMs: 40 });
      h.authority.mockResolvedValue(available);
      await h.run();
      const firstPass = h.handedOver.length;
      // The stream experiment is switched off, so the next pass makes no authority read at all.
      vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '0');
      await nextPass(h);
      const secondPass = h.handedOver.slice(firstPass);
      expect(secondPass.length).toBeGreaterThan(0);
      for (const { usableDuring } of secondPass) expect(usableDuring).toBe(false);
    });
  });
});
