import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { initializeRfc64LegacySwmBoundaryV1 } from '../src/rfc64/legacy-swm-boundary-v1.js';
import { resolveRfc64PersistenceRootV1 } from '../src/rfc64/persistence-layout-v1.js';
import { DKG_ONTOLOGY, encodeEncryptedWorkspacePayload, ENCRYPTED_WORKSPACE_ENVELOPE_TYPE,
  encodeGossipEnvelope, computeGossipSigningPayload, computeGossipSigningPayloadV2,
  GOSSIP_ENVELOPE_VERSION, GOSSIP_TYPE_WORKSPACE_PUBLISH, GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
  ciphertextChunkStoreGraph, CIPHERTEXT_CHUNK_PREDICATE, encodeWorkspacePublishRequest, GRAPH_KA_CONTENT_SCOPE_VERSION, sharedMemoryReadBothFilter } from '@origintrail-official/dkg-core';
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

async function signedPublicEnvelope(id: string, index: number) {
  const wallet = ethers.Wallet.createRandom();
  const peer = 'signed-plain-public-publisher';
  const timestamp = new Date().toISOString();
  const agentAddress = wallet.address.toLowerCase();
  const payload = encodeWorkspacePublishRequest({ contextGraphId: id,
    nquads: new TextEncoder().encode(`<urn:public-proof:${index}> <http://schema.org/name> "Public" <did:dkg:context-graph:${id}> .`),
    manifest: [], publisherPeerId: peer, shareOperationId: `public-proof-${index}`, timestampMs: Date.now(),
    agentAddress, kaNumber: '1', contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: `did:dkg:otp:20430/${agentAddress}/1`, assertionVersion: '1',
    publicTripleCount: 1, privateTripleCount: 0, accessPolicy: 'public', allowedPeers: [] });
  return { peer, bytes: encodeGossipEnvelope({ version: GOSSIP_ENVELOPE_VERSION,
    type: GOSSIP_TYPE_WORKSPACE_PUBLISH, contextGraphId: id, agentAddress: wallet.address, timestamp,
    signature: ethers.getBytes(await wallet.signMessage(computeGossipSigningPayload(
      GOSSIP_TYPE_WORKSPACE_PUBLISH, id, timestamp, payload))), payload }) };
}

describe('public host restoration policy fences', () => {
  const { makeCore } = createHostModeTestFixture();


  it('routine Core custody recording preserves consecutive signed public hosting', async () => {
    const core = await makeCore(true, { hostPublic: true });
    const id = 'routine-core-hosting-record';
    const { g, hash, onChainId } = await publicBinding(core, id);
    await g.reconcileSwmHostModeSubscription(id);
    const listener = g.swmHostModeHandlers.get(hash)!;
    const ingest = vi.spyOn(g, 'ingestSwmHostModeEnvelope');
    const first = await signedPublicEnvelope(id, 0);
    listener('topic', first.bytes, first.peer);
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    await ingest.mock.results[0].value;
    expect((await g.swmHostModeStore!.iterate(id, 0))).toHaveLength(1);
    const before = g.subscribedContextGraphs.get(id)!;
    const generation = g.contextGraphBindingState.capture(id);
    g.setContextGraphSubscription(id, { ...before, coreHosted: true }, { persist: false });
    expect(g.subscribedContextGraphs.get(id)).not.toBe(before);
    expect(g.subscribedContextGraphs.get(id)?.onChainId).toBe(onChainId);
    expect(g.contextGraphBindingState.capture(id)).toBe(generation);
    const second = await signedPublicEnvelope(id, 1);
    listener('topic', second.bytes, second.peer);
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(2));
    await ingest.mock.results[1].value;
    expect((await g.swmHostModeStore!.iterate(id, 0)).map(row => Buffer.from(row.envelopeBytes)))
      .toEqual([first.bytes, second.bytes].map(bytes => Buffer.from(bytes)));
    expect(g.swmHostModeHandlers.get(hash)).toBe(listener);
  });

  it('restores legacy Core custody without member wiring or a new public opt-in', async () => {
    const core = await makeCore(false);
    const id = 'legacy-core-without-member-handler';
    const { g, hash, onChainId } = await publicBinding(core, id);
    g.setContextGraphSubscription(id, { ...g.subscribedContextGraphs.get(id)!,
      coreHosted: true, subscribed: false }, { persist: false });
    const generation = g.contextGraphBindingState.capture(id);
    await g.swmHostModeStore!.markHostModeSubscribed(id, { onChainId: '999' });
    expect(g.swmHostModeHandlers.has(hash)).toBe(false);
    await g.restoreSwmHostModeSubscriptions();
    await g.swmHostModeRestoration!.drained;
    expect(g.swmHostModeHandlers.has(hash)).toBe(true);
    expect(g.subscribedContextGraphs.get(id)?.onChainId).toBe(onChainId);
    expect(g.contextGraphBindingState.capture(id)).toBe(generation);
    const signed = await signedPublicEnvelope(id, 2);
    const ingest = vi.spyOn(g, 'ingestSwmHostModeEnvelope');
    g.swmHostModeHandlers.get(hash)!('topic', signed.bytes, signed.peer);
    await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
    await ingest.mock.results[0].value;
    expect((await g.swmHostModeStore!.iterate(id, 0)).map(row => Buffer.from(row.envelopeBytes)))
      .toEqual([Buffer.from(signed.bytes)]);
  });

  for (const transition of ['unchanged', 'rebind'] as const) it(
    `rechecks real signed plaintext after held append (${transition})`, async () => {
      const core = await makeCore(true, { hostPublic: true });
      const id = 'held-plaintext-append';
      const { g, hash } = await publicBinding(core, id);
      // Real start establishes the persisted boundary before public apply.
      // This direct-ingress fixture keeps networking off and supplies that same prerequisite.
      const persistenceRoot = resolveRfc64PersistenceRootV1(g.config.dataDir);
      await mkdir(persistenceRoot, { recursive: true, mode: 0o700 });
      await initializeRfc64LegacySwmBoundaryV1(core, persistenceRoot, core.store);
      await g.reconcileSwmHostModeSubscription(id);
      const signed = await signedPublicEnvelope(id, 3);
      const store = g.swmHostModeStore!;
      const append = store.append.bind(store);
      const entered = deferred(), release = deferred();
      vi.spyOn(store, 'append').mockImplementation(async (...args) => {
        const result = await append(...args); entered.resolve(); await release.promise; return result;
      });
      const shared = core.getOrCreateSharedMemoryHandler();
      const apply = vi.spyOn(shared, 'handle');
      const verify = vi.spyOn(shared, 'verifyHostModeEnvelopeAuthority');
      const ingest = vi.spyOn(g, 'ingestSwmHostModeEnvelope');
      g.swmHostModeHandlers.get(hash)!('topic', signed.bytes, signed.peer);
      await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1));
      const running = ingest.mock.results[0].value;
      try {
        await Promise.race([entered.promise, running.then(() => { throw new Error('ingest did not enter append'); })]);
        expect(await verify.mock.results[0].value).toMatchObject({ accepted: true });
        expect(apply).not.toHaveBeenCalled();
        if (transition === 'rebind') {
          const replacement = await g.chain.createOnChainContextGraph({ accessPolicy: 1, publishPolicy: 1,
            nameHash: ethers.keccak256(ethers.toUtf8Bytes('held-plain-private')).toLowerCase() });
          const privateId = String(replacement.contextGraphId);
          g.setContextGraphSubscription(id, { subscribed: false, synced: false, syncMode: 'always-on',
            onChainHash: hash, onChainId: privateId }, { persist: false });
          g.onChainAccessPolicyCache.set(privateId, 1);
        }
        release.resolve(); await running;
        const retainedLog = await readFile(join(g.config.dataDir, 'swm-host', `${createHash('sha256').update(id).digest('base64url')}.log`));
        expect(retainedLog.includes(Buffer.from(signed.bytes))).toBe(true);
        expect((await store.iterate(id, 0)).map(row => Buffer.from(row.envelopeBytes)))
          .toEqual(transition === 'unchanged' ? [Buffer.from(signed.bytes)] : []);
        expect(apply).toHaveBeenCalledTimes(transition === 'unchanged' ? 1 : 0);
        if (transition === 'unchanged') expect(await apply.mock.results[0].value).toMatchObject({ applied: true });
        const quads = await core.store.query(`SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } ${sharedMemoryReadBothFilter(`did:dkg:context-graph:${id}/_shared_memory`, '?g')} }`);
        expect(quads.type).toBe('bindings');
        if (quads.type === 'bindings') expect(quads.bindings.length > 0).toBe(transition === 'unchanged');
      } finally { release.resolve(); await running; }
    });

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
    expect(await g.swmHostModeStore!.iterate(id, 0)).toEqual([]);
    const retainedLog = await readFile(join(g.config.dataDir, 'swm-host', `${createHash('sha256').update(id).digest('base64url')}.log`));
    expect(retainedLog.includes(Buffer.from(persisted))).toBe(true);
    expect((await g.swmHostModeStore!.stats()).perCg[id].entries).toBe(1);
  });

  it.each([false, true])('retains consecutive signed public envelopes through wire adoption (alreadyAdopted=%s)', async alreadyAdopted => {
    const core = await makeCore(true, { hostPublic: true });
    const id = 'wire-public-retention';
    const hash = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
    const g = core as unknown as StripInternals;
    const registration = await g.chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: hash });
    const onChainId = String(registration.contextGraphId);
    expect(g.stageOnChainContextGraphBindingFromNameHash(hash, onChainId)).toBe(hash);
    await g.reconcileSwmHostModeSubscription(hash);
    expect(g.subscribedContextGraphs.has(id)).toBe(false);
    const listener = g.swmHostModeHandlers.get(hash)!;
    const ingest = vi.spyOn(g, 'ingestSwmHostModeEnvelope');
    const wallet = ethers.Wallet.createRandom();
    const peer = 'signed-wire-publisher';
    const retained: Uint8Array[] = [];
    if (alreadyAdopted) g.setContextGraphSubscription(id, {
      subscribed: false, synced: false, syncMode: 'always-on', onChainHash: hash,
    }, { persist: false });
    for (let index = 0; index < 2; index++) {
      const timestamp = new Date().toISOString();
      const agentAddress = wallet.address.toLowerCase();
      const payload = encodeWorkspacePublishRequest({ contextGraphId: id,
        nquads: new TextEncoder().encode(`<urn:wire-public:${index}> <http://schema.org/name> "Public" <did:dkg:context-graph:${id}> .`),
        manifest: [], publisherPeerId: peer, shareOperationId: `wire-public-${index}`, timestampMs: Date.now(),
        agentAddress, kaNumber: '1', contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: `did:dkg:otp:20430/${agentAddress}/1`, assertionVersion: String(index + 1),
        publicTripleCount: 1, privateTripleCount: 0, accessPolicy: 'public', allowedPeers: [] });
      const bytes = encodeGossipEnvelope({ version: GOSSIP_ENVELOPE_VERSION,
        type: GOSSIP_TYPE_WORKSPACE_PUBLISH, contextGraphId: id, agentAddress: wallet.address,
        timestamp, signature: ethers.getBytes(await wallet.signMessage(computeGossipSigningPayload(
          GOSSIP_TYPE_WORKSPACE_PUBLISH, id, timestamp, payload))), payload });
      retained.push(bytes);
      listener('topic', bytes, peer);
      await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(index + 1));
      await ingest.mock.results[index].value;
      expect((await g.swmHostModeStore!.iterate(id, 0)).map(entry => Buffer.from(entry.envelopeBytes)))
        .toEqual(retained.map(bytes => Buffer.from(bytes)));
      expect(g.subscribedContextGraphs.get(id)?.onChainId).toBe(onChainId);
      expect(g.subscribedContextGraphs.has(hash)).toBe(false);
    }
  });

  it.each(['private', 'wrong-alias'] as const)('refuses signed wire handoff to a %s binding', async transition => {
    const core = await makeCore(true, { hostPublic: true });
    const id = 'wire-public-handoff-denial';
    const hash = ethers.keccak256(ethers.toUtf8Bytes(id)).toLowerCase();
    const g = core as unknown as StripInternals;
    const registration = await g.chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1, nameHash: hash });
    const onChainId = String(registration.contextGraphId);
    g.stageOnChainContextGraphBindingFromNameHash(hash, onChainId);
    await g.reconcileSwmHostModeSubscription(hash);
    const listener = g.swmHostModeHandlers.get(hash)!;
    const wallet = ethers.Wallet.createRandom();
    const peer = 'signed-wire-publisher';
    const payload = encodeWorkspacePublishRequest({ contextGraphId: id,
      nquads: new TextEncoder().encode(`<urn:wire-denied> <http://schema.org/name> "Public" <did:dkg:context-graph:${id}> .`),
      manifest: [], publisherPeerId: peer, shareOperationId: 'wire-denied', timestampMs: Date.now(),
      agentAddress: wallet.address.toLowerCase(), kaNumber: '1', contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: `did:dkg:otp:20430/${wallet.address.toLowerCase()}/1`, assertionVersion: '1',
      publicTripleCount: 1, privateTripleCount: 0, accessPolicy: 'public', allowedPeers: [] });
    const timestamp = new Date().toISOString();
    const bytes = encodeGossipEnvelope({ version: GOSSIP_ENVELOPE_VERSION,
      type: GOSSIP_TYPE_WORKSPACE_PUBLISH, contextGraphId: id, agentAddress: wallet.address, timestamp,
      signature: ethers.getBytes(await wallet.signMessage(computeGossipSigningPayload(
        GOSSIP_TYPE_WORKSPACE_PUBLISH, id, timestamp, payload))), payload });
    const replacementId = transition === 'private' ? String((await g.chain.createOnChainContextGraph({
      accessPolicy: 1, publishPolicy: 1, nameHash: hash,
    })).contextGraphId) : onChainId;
    g.setContextGraphSubscription(transition === 'private' ? id : 'different-uncommitted-name', {
      subscribed: false, synced: false, syncMode: 'always-on', onChainHash: hash, onChainId: replacementId,
    }, { persist: false });
    if (transition === 'private') g.onChainAccessPolicyCache.set(replacementId, 1);
    const ingest = vi.spyOn(g, 'ingestSwmHostModeEnvelope');
    const append = vi.spyOn(g.swmHostModeStore!, 'append');
    listener('topic', bytes, peer);
    // Drain the callback's ready refresh microtasks; there is no admitted
    // verifier/RPC await on either rejected canonical handoff.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(ingest).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(await g.swmHostModeStore!.iterate(id, 0)).toEqual([]);
    expect(g.subscribedContextGraphs.get(transition === 'private' ? id : 'different-uncommitted-name')?.onChainId)
      .toBe(replacementId);
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
