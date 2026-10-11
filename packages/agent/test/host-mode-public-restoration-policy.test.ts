import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { join } from 'node:path';
import { DKG_ONTOLOGY, encodeEncryptedWorkspacePayload, ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
  encodeGossipEnvelope, computeGossipSigningPayload, computeGossipSigningPayloadV2,
  GOSSIP_ENVELOPE_VERSION, GOSSIP_TYPE_WORKSPACE_PUBLISH, GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
  ciphertextChunkStoreGraph, CIPHERTEXT_CHUNK_PREDICATE } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { createHostModeTestFixture, hostEnvelope, type StripInternals } from './swm/host-mode.fixture.js';
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

  it('retries a strip-off persisted public classification after a temporary policy failure', async () => {
    const id = 'retry-public-restore-policy';
    const core = await makeCore(false, { hostPublic: true });
    const { g, hash, onChainId } = await publicBinding(core, id);
    await g.swmHostModeStore!.markHostModeSubscribed(id, { onChainId });
    const retained = new Uint8Array([12, 13]);
    await g.swmHostModeStore!.append(id, retained);
    const policy = vi.spyOn(g.chain, 'getContextGraphPublishPolicy').mockRejectedValueOnce(new Error('temporary policy failure'));
    await g.restoreSwmHostModeSubscriptions();
    await g.swmHostModeRestoration!.drained;
    expect(policy).toHaveBeenCalled();
    expect(g.swmHostModeCurated.get(hash)).toBe(true);
    const wallet = ethers.Wallet.createRandom();
    const request = async () => {
      const signed = await mintSignedCatchupRequest({ contextGraphId: id, sinceSeqno: 0,
        maxEntries: 32, maxBytes: 65536, requesterEoa: wallet.address, sign: digest => wallet.signMessage(digest) });
      return decodeSwmHostCatchupResponse(await g.handleSwmHostCatchup(encodeSwmHostCatchupRequest(signed), 'ordinary-reader'));
    };
    expect((await request()).denied).toBeDefined();
    await g.reconcileSwmHostModeSubscription(id);
    expect(g.swmHostModeCurated.get(hash)).toBe(false);
    const response = await request();
    expect(response.denied).toBeUndefined();
    expect(response.entries).toHaveLength(1);
    expect(Buffer.from(response.entries[0].envelopeB64, 'base64')).toEqual(Buffer.from(retained));
  });

  it.each([false, true])('fences automatic public dispatch after private rebinding (chunked=%s)', async chunked => {
    const core = await makeCore(true, { hostPublic: true });
    const id = 'automatic-public-binding-fence';
    const { g, hash } = await publicBinding(core, id);
    await g.reconcileSwmHostModeSubscription(id);
    const bytes = hostEnvelope(id, chunked);
    const persisted = new Uint8Array([31, 32]);
    const ingest = vi.spyOn(g, chunked ? 'ingestSwmCiphertextChunkEnvelope' : 'ingestSwmHostModeEnvelope')
      .mockImplementation(async () => { await g.swmHostModeStore!.append(id, persisted); });
    const handler = g.swmHostModeHandlers.get(hash)!;
    expect(handler).toBeDefined();
    handler('topic', bytes, 'authorized-publisher');
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    await ingest.mock.results[0].value;
    expect((await g.swmHostModeStore!.iterate(id, 0)).map(entry => entry.envelopeBytes)).toEqual([persisted]);
    const replacement = await g.chain.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 1,
      nameHash: ethers.keccak256(ethers.toUtf8Bytes('automatic-private-slot')).toLowerCase() });
    const privateId = String(replacement.contextGraphId);
    g.setContextGraphSubscription(id, { subscribed: false, synced: false, syncMode: 'always-on',
      onChainHash: hash, onChainId: privateId }, { persist: false });
    g.onChainAccessPolicyCache.set(privateId, 1);
    handler('topic', bytes, 'authorized-publisher');
    await Promise.resolve();
    expect(ingest).toHaveBeenCalledTimes(1);
    expect((await g.swmHostModeStore!.iterate(id, 0)).map(entry => entry.envelopeBytes)).toEqual([persisted]);
  });

  for (const chunked of [false, true]) for (const transition of ['unchanged', 'rebind', 'close'] as const) {
    it(`rechecks real signed custody after held authority (chunked=${chunked}, transition=${transition})`, async () => {
      const core = await makeCore(true, { hostPublic: true });
      // The close control starts the real lifecycle; stop on an unstarted
      // fixture would only close restoration and leave its gossip stub live.
      if (transition === 'close') await core.start();
      const id = 'held-real-host-envelope';
      const { g, hash } = await publicBinding(core, id);
      const wallet = ethers.Wallet.createRandom();
      await core.store.insert([{ subject: `did:dkg:context-graph:${id}`, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: `"${wallet.address}"`, graph: `did:dkg:context-graph:${id}/_meta` }]);
      await g.reconcileSwmHostModeSubscription(id);
      const payload = chunked ? new Uint8Array([...new Uint8Array(32).fill(19), 20, 21]) : encodeEncryptedWorkspacePayload({
        version: '1', type: ENCRYPTED_WORKSPACE_ENVELOPE_TYPE, contextGraphId: id, senderIdentity: wallet.address,
        operationId: 'held-real', shareOperationId: 'held-real', timestampMs: Date.now(), cipherAlgorithm: 'aes-256-gcm',
        nonce: new Uint8Array(12), ciphertext: new Uint8Array([20, 21]), recipients: [],
        keyAgreementAlgorithm: 'x25519', ephemeralPublicKey: new Uint8Array(32) });
      const type = chunked ? GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED : GOSSIP_TYPE_WORKSPACE_PUBLISH;
      const timestamp = new Date().toISOString();
      const digest = chunked ? computeGossipSigningPayloadV2(type, id, timestamp, payload, 0)
        : computeGossipSigningPayload(type, id, timestamp, payload);
      const bytes = encodeGossipEnvelope({ version: GOSSIP_ENVELOPE_VERSION, type, contextGraphId: id,
        agentAddress: wallet.address, timestamp, signature: ethers.getBytes(await wallet.signMessage(digest)), payload,
        ...(chunked ? { swmMessageIndex: 0 } : {}) });
      const verifier = core.getOrCreateSharedMemoryHandler();
      const verify = verifier.verifyHostModeEnvelopeAuthority.bind(verifier);
      const entered = deferred(), release = deferred();
      vi.spyOn(verifier, 'verifyHostModeEnvelopeAuthority').mockImplementation(async (...args) => {
        const verdict = await verify(...args);
        expect(verdict.accepted).toBe(true);
        entered.resolve(); await release.promise; return verdict;
      });
      // This spy only observes the actual async ingestion promise; it does not
      // replace authority, ingestion or either persistence implementation.
      const ingest = vi.spyOn(g, chunked ? 'ingestSwmCiphertextChunkEnvelope' : 'ingestSwmHostModeEnvelope');
      const handler = g.swmHostModeHandlers.get(hash)!;
      const writes = vi.spyOn(core.store, 'insert');
      handler('topic', bytes, 'real-signed-publisher');
      try {
        await Promise.race([entered.promise, ingest.mock.results[0].value.then(() => {
          throw new Error('ingest settled before real authority entered');
        })]);
        if (transition === 'rebind') {
          const replacement = await g.chain.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 1,
            nameHash: ethers.keccak256(ethers.toUtf8Bytes('held-real-private-slot')).toLowerCase() });
          const privateId = String(replacement.contextGraphId);
          g.setContextGraphSubscription(id, { subscribed: false, synced: false, syncMode: 'always-on',
            onChainHash: hash, onChainId: privateId }, { persist: false });
          g.onChainAccessPolicyCache.set(privateId, 1);
        } else if (transition === 'close') await core.stop();
        release.resolve();
        await ingest.mock.results[0].value;
        if (chunked) {
          const chunkWrites = writes.mock.calls.flatMap(([quads]) => quads).filter(quad =>
            quad.graph === ciphertextChunkStoreGraph(hash) && quad.predicate === CIPHERTEXT_CHUNK_PREDICATE);
          expect(chunkWrites).toHaveLength(transition === 'unchanged' ? 1 : 0);
          // stop closes the actual triple store. Reopen its persisted snapshot
          // for the post-shutdown assertion rather than querying a dead worker.
          const reopened = transition === 'close' ? new OxigraphStore(join(g.config.dataDir, 'store.nq')) : undefined;
          try {
            const result = await (reopened ?? core.store).query(`SELECT ?value WHERE { GRAPH <${ciphertextChunkStoreGraph(hash)}> {
              ?s <${CIPHERTEXT_CHUNK_PREDICATE}> ?value } }`);
            expect(result.type).toBe('bindings');
            if (result.type === 'bindings') expect(result.bindings).toHaveLength(transition === 'unchanged' ? 1 : 0);
          } finally { await reopened?.close(); }
        } else {
          const entries = (await g.swmHostModeStore!.stats()).perCg[id]?.entries ?? 0;
          expect(entries).toBe(transition === 'unchanged' ? 1 : 0);
        }
      } finally { release.resolve(); await ingest.mock.results[0]?.value; }
    });
  }

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
