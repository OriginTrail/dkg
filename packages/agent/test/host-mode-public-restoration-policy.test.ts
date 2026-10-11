import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { createHostModeTestFixture, type StripInternals } from './swm/host-mode.fixture.js';
import { mintSignedCatchupRequest } from '../src/swm/host-catchup-sign.js';
import { decodeSwmHostCatchupResponse, encodeSwmHostCatchupRequest } from '../src/swm/host-catchup-wire.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function publicBinding(core: DKGAgent, id: string) {
  const g = core as unknown as StripInternals;
  const hash = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
  const result = await g.chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: hash });
  const onChainId = String(result.contextGraphId);
  g.setContextGraphSubscription(id, { subscribed: false, synced: false, syncMode: 'always-on', onChainHash: hash, onChainId }, { persist: false });
  g.onChainAccessPolicyCache.set(onChainId, 0);
  return { g, hash, onChainId };
}

describe('public host restoration policy fences', () => {
  const { makeCore } = createHostModeTestFixture();

  it('strip-off cold restart retains public SWM for an ordinary signed reader', async () => {
    const id = 'cold-restart-public-reader';
    const chain = new MockChainAdapter();
    const first = await makeCore(false, { chain, hostPublic: true });
    const { g, hash, onChainId } = await publicBinding(first, id);
    await g.reconcileSwmHostModeSubscription(id);
    await g.awaitHostModePersistence(id);
    const retained = new Uint8Array([7, 9, 11]);
    await g.swmHostModeStore!.append(id, retained);
    const dataDir = g.config.dataDir;
    await first.stop();
    await first.store.close();
    const restarted = await makeCore(false, { chain, hostPublic: true, dataDir });
    const restored = restarted as unknown as StripInternals;
    await restored.restoreSwmHostModeSubscriptions();
    await restored.swmHostModeRestoration!.drained;
    await restored.reconcileSwmHostModeSubscription(id);
    const wallet = ethers.Wallet.createRandom();
    expect(await chain.getIdentityIdForAddress(wallet.address)).toBe(0n);
    const request = await mintSignedCatchupRequest({ contextGraphId: id, sinceSeqno: 0,
      maxEntries: 32, maxBytes: 65536, requesterEoa: wallet.address, sign: digest => wallet.signMessage(digest) });
    const response = decodeSwmHostCatchupResponse(await restored.handleSwmHostCatchup(encodeSwmHostCatchupRequest(request), 'ordinary-reader'));
    expect(response.denied).toBeUndefined();
    expect(response.entries).toHaveLength(1);
    expect(Buffer.from(response.entries[0].envelopeB64, 'base64')).toEqual(Buffer.from(retained));
    expect(restored.swmHostModeCurated.get(hash)).toBe(false);
    expect(restored.subscribedContextGraphs.get(id)?.onChainId).toBe(onChainId);
  });

  for (const reverse of [false, true]) it(`held public proof cannot admit a replacement private ${reverse ? 'reverse' : 'authoritative'} binding`, async () => {
    const core = await makeCore(true, { hostPublic: true });
    const id = 'held-public-to-private';
    const { g, hash, onChainId } = await publicBinding(core, id);
    const requestId = reverse ? hash : id;
    if (reverse) {
      g.setContextGraphSubscription(id, { subscribed: false, synced: false, syncMode: 'always-on', onChainHash: hash }, { persist: false });
      g.stageOnChainContextGraphBindingFromNameHash(hash, onChainId);
    }
    const entered = deferred(), release = deferred();
    const getPublishPolicy = g.chain.getContextGraphPublishPolicy.bind(g.chain);
    vi.spyOn(g.chain, 'getContextGraphPublishPolicy').mockImplementation(async chainId => {
      expect(chainId).toBe(BigInt(onChainId));
      entered.resolve(); await release.promise;
      return getPublishPolicy(chainId);
    });
    const wired = vi.spyOn(g, 'wireSwmHostModeHandler');
    const reconciling = g.reconcileSwmHostModeSubscription(requestId);
    try {
      await entered.promise;
      const privateGraph = await g.chain.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 1,
        nameHash: ethers.keccak256(ethers.toUtf8Bytes('replacement-private')).toLowerCase() });
      const privateId = String(privateGraph.contextGraphId);
      g.setContextGraphSubscription(id, { subscribed: false, synced: false, syncMode: 'always-on', onChainHash: hash, onChainId: privateId }, { persist: false });
      g.onChainAccessPolicyCache.set(privateId, 1);
      release.resolve(); await reconciling;
      expect(wired).not.toHaveBeenCalled();
      expect(g.swmHostModeHandlers.has(hash)).toBe(false);
      expect(g.swmHostModeSubscribed.has(hash)).toBe(false);
      expect(await g.swmHostModeStore!.listHostModeSubscriptions()).toEqual([]);
    } finally { release.resolve(); await reconciling; }
  });

  it('stop drains the actual strip-on public-policy await without wiring or persisting hosting', async () => {
    const core = await makeCore(true, { hostPublic: true });
    const id = 'held-public-restoration-stop';
    const { g, hash, onChainId } = await publicBinding(core, id);
    await g.swmHostModeStore!.markHostModeSubscribed(id, { onChainId });
    const entered = deferred(), release = deferred();
    const getPublishPolicy = g.chain.getContextGraphPublishPolicy.bind(g.chain);
    vi.spyOn(g.chain, 'getContextGraphPublishPolicy').mockImplementation(async chainId => {
      entered.resolve(); await release.promise; return getPublishPolicy(chainId);
    });
    const wire = vi.spyOn(g, 'wireSwmHostModeHandler');
    const persist = vi.spyOn(g.swmHostModeStore!, 'markHostModeSubscribed');
    const restoring = g.restoreSwmHostModeSubscriptions();
    try {
      await entered.promise;
      let stopped = false;
      const stopping = core.stop().then(() => { stopped = true; });
      await vi.waitFor(() => expect(g.swmHostModeRestoration!.closed).toBe(true));
      expect(stopped).toBe(false);
      // This direct restore never starts the node; stop must rely on its
      // owned restoration callback, not a retired gossip session alone.
      expect((core as unknown as { gossipSession: { active: boolean } }).gossipSession.active).toBe(true);
      release.resolve(); await Promise.all([restoring, stopping]);
      expect(stopped).toBe(true);
      expect(wire).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(g.swmHostModeHandlers.has(hash)).toBe(false);
    } finally { release.resolve(); await restoring; }
  });
});
