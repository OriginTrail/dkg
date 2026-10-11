import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { GraphManager } from '@origintrail-official/dkg-storage';
import { computeGossipSigningPayload, computeGossipSigningPayloadV2, encodeEncryptedWorkspacePayload,
  encodeGossipEnvelope, ENCRYPTED_WORKSPACE_ENVELOPE_TYPE, GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH, GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
  CIPHERTEXT_CHUNK_PREDICATE, ciphertextChunkStoreGraph, SUBSCRIPTION_SOURCES } from '@origintrail-official/dkg-core';
import type { GossipSession } from '../src/gossip-session.js';
import { createHostModeTestFixture, hostEnvelope, type StripInternals } from './swm/host-mode.fixture.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
type Host = StripInternals & { gossipSession: GossipSession; sharedMemoryGossipRegistered: Set<string>;
  contextGraphSubscriptionDormancyById: Map<string, unknown> };

describe('host admission and captured custody', () => {
  const { makeCore } = createHostModeTestFixture();

  for (const chunked of [false, true]) for (const ownSigner of [false, true]) it(
    `cold numeric-looking identity keeps slot10 authority (chunked=${chunked}, ownSigner=${ownSigner})`, async () => {
      const id = '42', hash = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
      const owner = ethers.Wallet.createRandom(), foreign = ethers.Wallet.createRandom();
      const chain = new MockChainAdapter('mock:31337', undefined, { initialContextGraphId: 10n });
      expect((await chain.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 1,
        nameHash: hash, participantAgents: [owner.address] })).contextGraphId).toBe(10n);
      for (let slot = 11; slot < 42; slot++) await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1 });
      expect((await chain.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 1,
        nameHash: ethers.keccak256(ethers.toUtf8Bytes('unrelated-private')), participantAgents: [foreign.address] })).contextGraphId).toBe(42n);
      const core = await makeCore(false, { chain }), g = core as unknown as Host;
      await g.swmHostModeStore!.markHostModeSubscribed(hash, { onChainId: '10' });
      await g.restoreSwmHostModeSubscriptions(); await g.swmHostModeRestoration!.drained;
      expect(g.subscribedContextGraphs.get(hash)?.onChainId).toBe('10');
      expect(g.subscribedContextGraphs.has(id)).toBe(false);
      const signer = ownSigner ? owner : foreign;
      const payload = chunked ? new Uint8Array([...new Uint8Array(32).fill(7), 8, 9]) : encodeEncryptedWorkspacePayload({
        version: '1', type: ENCRYPTED_WORKSPACE_ENVELOPE_TYPE, contextGraphId: id,
        senderIdentity: signer.address, operationId: 'numeric-cold', shareOperationId: 'numeric-cold', timestampMs: Date.now(),
        cipherAlgorithm: 'aes-256-gcm', nonce: new Uint8Array(12), ciphertext: new Uint8Array([8, 9]), recipients: [],
        keyAgreementAlgorithm: 'x25519', ephemeralPublicKey: new Uint8Array(32) });
      const type = chunked ? GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED : GOSSIP_TYPE_WORKSPACE_PUBLISH;
      const timestamp = new Date().toISOString();
      const digest = chunked ? computeGossipSigningPayloadV2(type, id, timestamp, payload, 0)
        : computeGossipSigningPayload(type, id, timestamp, payload);
      const bytes = encodeGossipEnvelope({ version: GOSSIP_ENVELOPE_VERSION, type, contextGraphId: id,
        agentAddress: signer.address, timestamp, signature: ethers.getBytes(await signer.signMessage(digest)), payload,
        ...(chunked ? { swmMessageIndex: 0 } : {}) });
      const roster = vi.spyOn(chain, 'getContextGraphParticipantAgents');
      const ingest = vi.spyOn(g, chunked ? 'ingestSwmCiphertextChunkEnvelope' : 'ingestSwmHostModeEnvelope');
      g.swmHostModeHandlers.get(hash)!('topic', bytes, 'actual-signed-sender');
      await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
      await ingest.mock.results[0].value;
      if (chunked) {
        const result = await core.store.query(`SELECT ?value WHERE { GRAPH <${ciphertextChunkStoreGraph(id)}> {
          ?s <${CIPHERTEXT_CHUNK_PREDICATE}> ?value } }`);
        expect(result.type).toBe('bindings');
        if (result.type === 'bindings') expect(result.bindings).toHaveLength(ownSigner ? 1 : 0);
      } else expect(await g.swmHostModeStore!.iterate(id, 0)).toHaveLength(ownSigner ? 1 : 0);
      expect(roster).toHaveBeenCalledWith(10n);
      expect(roster).not.toHaveBeenCalledWith(42n);
    });

  it('bounded periodic reconciliation retries a cold hash-only marker after policy RPC recovery', async () => {
    const core = await makeCore(true, { hostPublic: true, reconcileBatchSize: 1 }), g = core as unknown as Host;
    const hash = ethers.keccak256(ethers.toUtf8Bytes('cold-no-data-public')).toLowerCase();
    const created = await g.chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: hash });
    await g.swmHostModeStore!.markHostModeSubscribed(hash, { onChainId: String(created.contextGraphId) });
    const policy = vi.spyOn(g.chain, 'getContextGraphPublishPolicy').mockRejectedValueOnce(new Error('temporarily unavailable'));
    await g.restoreSwmHostModeSubscriptions(); await g.swmHostModeRestoration!.drained;
    expect(policy).toHaveBeenCalledTimes(1);
    expect(g.swmHostModeHandlers.has(hash)).toBe(false);
    expect(await new GraphManager(core.store).listContextGraphs()).not.toContain(hash);
    await core.reconcileHostModeSubscriptions();
    expect(g.swmHostModeHandlers.has(hash)).toBe(true);
    expect(await g.swmHostModeStore!.listHostModeSubscriptions()).toContainEqual({
      contextGraphId: hash, onChainId: String(created.contextGraphId) });
  });

  it.each([false, true])('member takeover during actual target admission reaches the final wire refusal (wire=%s)', async wire => {
    const core = await makeCore(true, { hostPublic: true }), g = core as unknown as Host;
    const id = 'held-member-admission', hash = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
    const created = await g.chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: hash });
    const target = wire ? hash : id;
    await g.swmHostModeStore!.markHostModeSubscribed(target, { onChainId: String(created.contextGraphId) });
    const entered = deferred(), release = deferred();
    const getPolicy = g.chain.getContextGraphPublishPolicy.bind(g.chain);
    vi.spyOn(g.chain, 'getContextGraphPublishPolicy').mockImplementation(async slot => {
      entered.resolve(); await release.promise; return getPolicy(slot);
    });
    const wiring = vi.spyOn(g, 'wireSwmHostModeHandler');
    const onMessage = vi.spyOn(g.gossip, 'onMessage');
    const restoring = g.restoreSwmHostModeSubscriptions();
    try {
      await entered.promise;
      const binding = g.subscribedContextGraphs.get(target);
      const generation = g.contextGraphBindingState.capture(target);
      g.sharedMemoryGossipRegistered.add(target);
      release.resolve(); await restoring; await g.swmHostModeRestoration!.drained;
      expect(g.subscribedContextGraphs.get(target)).toBe(binding);
      expect(g.contextGraphBindingState.capture(target)).toBe(generation);
      expect(wiring).toHaveBeenCalledTimes(1);
      expect(wiring.mock.results[0].value).toBe(false);
      expect(onMessage).not.toHaveBeenCalled();
      expect(g.swmHostModeHandlers.has(hash)).toBe(false);
      expect(await g.swmHostModeStore!.listHostModeSubscriptions()).toContainEqual({
        contextGraphId: target, onChainId: String(created.contextGraphId) });
    } finally { release.resolve(); await restoring; }
  });

  it('stored custody probes are pure and explicit dormant reconciliation retires its own listener', async () => {
    const core = await makeCore(true, { hostPublic: true }), g = core as unknown as Host;
    const id = 'pure-dormant-proof', hash = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
    const created = await g.chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: hash });
    g.setContextGraphSubscription(id, { subscribed: false, synced: false, syncMode: 'always-on',
      onChainHash: hash, onChainId: String(created.contextGraphId) }, { persist: false });
    await g.reconcileSwmHostModeSubscription(id); await g.awaitHostModePersistence(id);
    const registered = g.gossipSession.hostModeRegistrations.get(hash)!;
    expect(registered.custody.kind).toBe('automatic-public');
    g.contextGraphSubscriptionDormancyById.set(id, { reason: 'disabled' });
    const off = vi.spyOn(g.gossip, 'offMessage'), unmark = vi.spyOn(g.swmHostModeStore!, 'markHostModeUnsubscribed');
    if (registered.custody.kind === 'automatic-public') for (let i = 0; i < 3; i++) expect(registered.custody.current()).toBe(false);
    await g.awaitHostModePersistence(id);
    expect(g.gossipSession.hostModeRegistrations.get(hash)).toBe(registered);
    expect(off).not.toHaveBeenCalled(); expect(unmark).not.toHaveBeenCalled();
    await g.reconcileSwmHostModeSubscription(id); await g.awaitHostModePersistence(id);
    expect(g.swmHostModeHandlers.has(hash)).toBe(false);
    expect(off).toHaveBeenCalledTimes(1); expect(unmark).toHaveBeenCalledTimes(1);
  });

  it('rotates a bounded union of local graphs and cold durable markers', async () => {
    const core = await makeCore(true, { hostPublic: true, reconcileBatchSize: 2 }), g = core as unknown as Host;
    const localIds = ['aaa-local', 'zzz-local'];
    const manager = new GraphManager(core.store);
    for (const id of localIds) {
      await manager.ensureContextGraph(id);
      await core.store.insert([{ subject: 'urn:local', predicate: 'urn:payload', object: '"present"',
        graph: manager.dataGraphUri(id) }]);
    }
    const hashes: string[] = [];
    for (const name of ['cold-one', 'cold-two', 'cold-three']) {
      const hash = ethers.keccak256(ethers.toUtf8Bytes(name)).toLowerCase(); hashes.push(hash);
      const created = await g.chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: hash });
      await g.swmHostModeStore!.markHostModeSubscribed(hash, { onChainId: String(created.contextGraphId) });
    }
    const policy = vi.spyOn(g.chain, 'getContextGraphPublishPolicy').mockRejectedValue(new Error('unavailable'));
    await g.restoreSwmHostModeSubscriptions(); await g.swmHostModeRestoration!.drained;
    policy.mockRestore();
    const selected = vi.spyOn(g, 'reconcileSwmHostModeSubscription');
    const allIds = new Set([...await manager.listContextGraphs(), ...hashes]);
    for (let tick = 0; tick < Math.ceil(allIds.size / 2); tick++) {
      const before = selected.mock.calls.length;
      await core.reconcileHostModeSubscriptions();
      expect(selected.mock.calls.length - before).toBe(2);
    }
    expect(new Set(selected.mock.calls.map(([id]) => id))).toEqual(allIds);
    for (const hash of hashes) expect(g.swmHostModeHandlers.has(hash)).toBe(true);
  });

  it('stop fences and joins the existing held retry without installing late custody', async () => {
    const core = await makeCore(true, { hostPublic: true }), g = core as unknown as Host;
    const hash = ethers.keccak256(ethers.toUtf8Bytes('held-retry')).toLowerCase();
    const created = await g.chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: hash });
    await g.swmHostModeStore!.markHostModeSubscribed(hash, { onChainId: String(created.contextGraphId) });
    const policy = vi.spyOn(g.chain, 'getContextGraphPublishPolicy').mockRejectedValueOnce(new Error('unavailable'));
    await g.restoreSwmHostModeSubscriptions(); await g.swmHostModeRestoration!.drained;
    const entered = deferred(), release = deferred();
    policy.mockRestore();
    const getPolicy = g.chain.getContextGraphPublishPolicy.bind(g.chain);
    vi.spyOn(g.chain, 'getContextGraphPublishPolicy').mockImplementation(async slot => {
      entered.resolve(); await release.promise; return getPolicy(slot);
    });
    const retry = core.reconcileHostModeSubscriptions();
    let stopped = false;
    try {
      await entered.promise;
      const stop = core.stop().then(() => { stopped = true; });
      await new Promise(resolve => setImmediate(resolve));
      expect(g.swmHostModeRestoration!.closed).toBe(true);
      expect(stopped).toBe(false);
      release.resolve(); await Promise.all([retry, stop]);
      expect(g.swmHostModeHandlers.has(hash)).toBe(false);
      expect(await g.swmHostModeStore!.listHostModeSubscriptions()).toContainEqual({ contextGraphId: hash,
        onChainId: String(created.contextGraphId) });
    } finally { release.resolve(); await retry; }
  });

  it.each([false, true])('pending admission keeps its original listener snapshot (refresh=%s)', async refresh => {
    const core = await makeCore(true, { hostPublic: true }), g = core as unknown as Host;
    const id = 'held-listener-replacement', hash = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
    const created = await g.chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: hash });
    g.setContextGraphSubscription(id, { subscribed: false, synced: false, syncMode: 'always-on',
      onChainHash: hash, onChainId: String(created.contextGraphId) }, { persist: false });
    if (refresh) expect(g.wireSwmHostModeHandler(id, SUBSCRIPTION_SOURCES.CHAIN_EVENT, { kind: 'curated' })).toBe(true);
    const prior = g.gossipSession.hostModeRegistrations.get(hash);
    const entered = deferred(), release = deferred();
    const getPolicy = g.chain.getContextGraphPublishPolicy.bind(g.chain);
    vi.spyOn(g.chain, 'getContextGraphPublishPolicy').mockImplementation(async slot => {
      entered.resolve(); await release.promise; return getPolicy(slot);
    });
    const pending = g.reconcileSwmHostModeSubscription(id);
    try {
      await entered.promise;
      core.unwireSwmHostModeHandler(id);
      expect(g.wireSwmHostModeHandler(id, SUBSCRIPTION_SOURCES.MANUAL, { kind: 'curated' })).toBe(true);
      const replacement = g.gossipSession.hostModeRegistrations.get(hash)!;
      expect(replacement.handler).not.toBe(prior?.handler);
      release.resolve(); await pending;
      expect(g.gossipSession.hostModeRegistrations.get(hash)).toBe(replacement);
      expect(replacement.custody.kind).toBe('curated');
      expect(replacement.source).toBe(SUBSCRIPTION_SOURCES.MANUAL);
    } finally { release.resolve(); await pending; }
  });

  it.each([false, true])('registration owns captured public dispatch and retired refusal (chunked=%s)', async chunked => {
    const core = await makeCore(true, { hostPublic: true }), g = core as unknown as Host;
    const id = 'installed-public-dispatch', hash = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
    const created = await g.chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: hash });
    g.setContextGraphSubscription(id, { subscribed: false, synced: false, syncMode: 'always-on',
      onChainHash: hash, onChainId: String(created.contextGraphId) }, { persist: false });
    const ingest = vi.spyOn(g, chunked ? 'ingestSwmCiphertextChunkEnvelope' : 'ingestSwmHostModeEnvelope').mockResolvedValue();
    const bytes = hostEnvelope(id, chunked);
    expect(g.wireSwmHostModeHandler(id, SUBSCRIPTION_SOURCES.MANUAL, { kind: 'curated' })).toBe(true);
    const curated = g.gossipSession.hostModeRegistrations.get(hash)!;
    curated.handler('topic', bytes, 'peer');
    await new Promise(resolve => setImmediate(resolve));
    expect(ingest).not.toHaveBeenCalled();
    core.unwireSwmHostModeHandler(id);
    await g.reconcileSwmHostModeSubscription(id);
    const first = g.gossipSession.hostModeRegistrations.get(hash)!;
    expect(first.custody.kind).toBe('automatic-public');
    if (first.custody.kind === 'automatic-public') expect(first.custody.current()).toBe(true);
    first.handler('topic', bytes, 'peer');
    expect(ingest).toHaveBeenCalledTimes(1);
    const captured = ingest.mock.calls[0][3];
    expect(captured?.()).toBe(true);
    await g.reconcileSwmHostModeSubscription(id);
    expect(g.gossipSession.hostModeRegistrations.get(hash)!.handler).toBe(first.handler);
    core.unwireSwmHostModeHandler(id);
    first.handler('topic', bytes, 'peer');
    expect(captured?.()).toBe(false);
    if (first.custody.kind === 'automatic-public') expect(first.custody.current()).toBe(false);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('refreshes typed custody while retaining first source and the original listener', async () => {
    const core = await makeCore(false), g = core as unknown as Host;
    const id = 'one-registration-transition', key = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
    const onMessage = vi.spyOn(g.gossip, 'onMessage');
    expect(g.wireSwmHostModeHandler(id, SUBSCRIPTION_SOURCES.CHAIN_EVENT, { kind: 'curated' })).toBe(true);
    const original = g.gossipSession.hostModeRegistrations.get(key)!;
    const current = () => false;
    expect(g.wireSwmHostModeHandler(id, SUBSCRIPTION_SOURCES.RECONCILER,
      { kind: 'automatic-public', current })).toBe(true);
    const refreshed = g.gossipSession.hostModeRegistrations.get(key)!;
    expect(refreshed.handler).toBe(original.handler);
    expect(refreshed.source).toBe(SUBSCRIPTION_SOURCES.CHAIN_EVENT);
    expect(refreshed.custody.kind).toBe('automatic-public');
    if (refreshed.custody.kind === 'automatic-public') expect(refreshed.custody.current()).toBe(false);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

});
