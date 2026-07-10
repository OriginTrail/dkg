/**
 * LU-11 chunk-catchup wiring coverage (PR #716 audit, cluster B.3).
 *
 * Two paired functions form the late-joining-host backfill contract:
 *
 *   1. `DKGAgent.fetchCiphertextChunkFromPeer`
 *      (`packages/agent/src/dkg-agent.ts:11085-11171`) — the initiator
 *      side. Mints + signs a `/dkg/10.0.2/get-ciphertext-chunk`
 *      request via the chain adapter, sends it through the messenger,
 *      decodes the response, and (when `persist=true`) writes the
 *      returned ciphertext into the local triple store under the
 *      canonical `ciphertextChunkStoreGraph(canonical(cgId))` URI.
 *
 *   2. `DKGAgent.ingestSwmCiphertextChunkEnvelope`
 *      (`packages/agent/src/dkg-agent.ts:10392-10490`) — the gossip
 *      ingester. Decodes an incoming chunked publish envelope from
 *      the workspace topic, runs the LU-6 host-mode authority check,
 *      and persists the `[batchId | ciphertext]` payload to the same
 *      chunk store URI shape that the initiator persist + responder
 *      lookup converge on.
 *
 * Existing test coverage:
 *   - `lu11-handle-get-ciphertext-chunk.test.ts` (PR #739) pins the
 *     responder side (`handleGetCiphertextChunk`) end-to-end with
 *     auth + canonical-CG keying.
 *   - The PR #716 audit found NEITHER of the two functions above had
 *     ANY direct adapter-level coverage. Both are wired into hot
 *     paths (random-sampling prover backfill, gossip subscription),
 *     so a regression here would silently break late-joining cores.
 *
 * This file pins:
 *   - Happy-path persist for `fetchCiphertextChunkFromPeer` under the
 *     canonical CG graph.
 *   - The `denied` ACK is RETURNED (not thrown) — the backfill loop
 *     (`buildCiphertextChunkBackfill`, dkg-agent.ts:11268-11272)
 *     branches on `resp.denied` to continue to the next peer.
 *   - Transport failures (`delivered=false`) DO throw, so the
 *     backfill loop's outer try/catch records them as failures.
 *   - The "no chain.signMessage" precondition trips an explicit
 *     error rather than silently sending an unsigned request.
 *   - The 32-byte `batchId` invariant fires loud.
 *   - Persist falls back to the raw `contextGraphId` graph URI when
 *     `canonicalChunkStoreCgIdOrNull` returns `null` — mirrors the
 *     same legacy fallback the responder uses (`#729 Bug 5`).
 *
 *   - `ingestSwmCiphertextChunkEnvelope` happy path: encoded chunked
 *     envelope with a matching subscription persists the inner
 *     ciphertext under `ciphertextChunkStoreGraph(canonical(cgId))`.
 *   - Truncated payload (`payload.length <= 32`) drops silently.
 *   - WireId mismatch (envelope vs subscription) drops silently.
 *   - LU-6 authority decline drops silently (nothing persists).
 *   - Wrong envelope type (V1 `share-write` instead of
 *     `share-write-chunked`) drops silently — chunked path must NOT
 *     pick up legacy V1 messages.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  ciphertextChunkStoreGraph,
  ciphertextChunkStoreSubject,
  CIPHERTEXT_CHUNK_PREDICATE,
  encodeGossipEnvelope,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import {
  CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
  encodeCiphertextChunkCatchupResponse,
  decodeCiphertextChunkCatchupRequest,
  verifySignedCiphertextChunkCatchupRequest,
} from '../src/swm/ciphertext-chunk-catchup.js';
import type { ReliableSendResult } from '../src/p2p/messenger.js';

/**
 * `'/dkg/10.0.2/get-ciphertext-chunk'` is the protocol id the
 * initiator hits. We don't hard-code it — the messenger stub
 * accepts whatever the production code sends — but we DO assert
 * the request bytes decode into a fresh signed catchup request, so
 * the initiator's signing path actually runs.
 */
interface WiringInternals {
  fetchCiphertextChunkFromPeer: DKGAgent['fetchCiphertextChunkFromPeer'];
  ingestSwmCiphertextChunkEnvelope(
    contextGraphId: string,
    data: Uint8Array,
    fromPeerId: string,
  ): Promise<void>;
  store: {
    insert(quads: { subject: string; predicate: string; object: string; graph: string }[]): Promise<void>;
    query(sparql: string): Promise<{ type: 'bindings'; bindings: Record<string, string>[] } | { type: string }>;
  };
  messenger?: { sendReliable: (peerId: string, protocol: string, payload: Uint8Array) => Promise<ReliableSendResult> };
  node?: { peerId: { toString(): string } };
  subscribedContextGraphs: Map<string, { onChainHash?: string; topic?: string }>;
  gossipWireIdFor(rawId: string): string;
  sharedMemoryHandler?: {
    verifyHostModeEnvelopeAuthority(
      data: Uint8Array,
      cgId: string,
      from: string,
    ): Promise<{ accepted: true } | { accepted: false; reason: string }>;
  };
  getOrCreateSharedMemoryHandler(): {
    verifyHostModeEnvelopeAuthority(
      data: Uint8Array,
      cgId: string,
      from: string,
    ): Promise<{ accepted: true } | { accepted: false; reason: string }>;
  };
}

interface SignerInternals {
  chain: MockChainAdapter & {
    setMockACKSigner?(wallet: ethers.Wallet): void;
    signMessage?(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }>;
  };
}

async function bootAgent(opts?: { withChainSigner?: boolean; stripCiphertext?: boolean }): Promise<{
  agent: DKGAgent;
  internals: WiringInternals & SignerInternals;
}> {
  const chain = new MockChainAdapter();
  if (opts?.withChainSigner !== false) {
    // `signMessage` exists on the mock adapter, but without an ACK
    // signer it returns 32 zero bytes — which fails the
    // `mintSignedCiphertextChunkCatchupRequest` self-consistency
    // recovery step. Wire a deterministic Wallet so the closure
    // inside `fetchCiphertextChunkFromPeer` produces a recoverable
    // signature.
    chain.setMockACKSigner(ethers.Wallet.createRandom());
  }
  const agent = await DKGAgent.create({
    name: 'CatchupWiringTest',
    chainAdapter: chain,
    // Omit stripCiphertext unless a test explicitly overrides it so the suite
    // continues to exercise the production default (strip ON).
    swmHostMode: {
      enabled: true,
      ...(opts?.stripCiphertext !== undefined ? { stripCiphertext: opts.stripCiphertext } : {}),
    },
  });
  const internals = agent as unknown as WiringInternals & SignerInternals;
  return { agent, internals };
}

/**
 * Replace messenger so we can intercept `sendReliable` without
 * spinning the libp2p stack. Pattern mirrored from
 * `swm-sender-key-parallel-fanout.test.ts`.
 */
function installStubMessenger(
  internals: WiringInternals,
  sendReliable: (peerId: string, protocol: string, payload: Uint8Array) => Promise<ReliableSendResult>,
): void {
  internals.messenger = { sendReliable };
  if (!internals.node) {
    internals.node = {
      peerId: { toString: () => '12D3KooWStubLocalPeerForCatchupTest' },
    };
  }
}

/**
 * Stub the LU-6 host-mode authority gate so individual ingest
 * tests can pick `accept` vs `decline` without spinning the full
 * agent-gate chain plumbing — which has its own dedicated tests
 * in `workspace-handler-host-mode-authority.test.ts`.
 */
function stubAuthority(
  internals: WiringInternals,
  verdict: { accepted: true } | { accepted: false; reason: string },
): void {
  const handler = {
    verifyHostModeEnvelopeAuthority: async () => verdict,
  };
  internals.sharedMemoryHandler = handler;
  // The agent caches it lazily — make sure
  // `getOrCreateSharedMemoryHandler()` returns our stub by setting
  // the cached field directly. (The accessor returns the field
  // when present, only constructing a real one when null.)
}

async function chunkPersistedAt(
  internals: WiringInternals,
  opts: { canonicalCgId: string; batchId: Uint8Array; chunkIndex: number },
): Promise<string | null> {
  const subject = ciphertextChunkStoreSubject(opts.batchId, opts.chunkIndex);
  const graph = ciphertextChunkStoreGraph(opts.canonicalCgId);
  const sparql = `
    SELECT ?obj WHERE {
      GRAPH <${graph}> {
        <${subject}> <${CIPHERTEXT_CHUNK_PREDICATE}> ?obj
      }
    } LIMIT 1
  `;
  const res = await internals.store.query(sparql);
  if (res.type !== 'bindings') return null;
  const bindings = (res as { bindings: Record<string, string>[] }).bindings;
  if (!bindings || bindings.length === 0) return null;
  return bindings[0]['obj'] ?? null;
}

const REMOTE_PEER = '12D3KooWFakeRemotePeerCatchupTest';

describe('DKGAgent.fetchCiphertextChunkFromPeer — initiator wiring (LU-11)', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
  });

  it('happy path: mints a signed request, persists returned ciphertext under canonical CG graph', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const cleartextCgId = 'cg-cleartext-fetch-happy';
    internals.subscribedContextGraphs.set(cleartextCgId, { topic: cleartextCgId });
    const canonical = internals.gossipWireIdFor(cleartextCgId);

    const batchId = ethers.getBytes(ethers.id('fetch-happy-batch'));
    const expectedCiphertext = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
    const expectedCiphertextB64 = Buffer.from(expectedCiphertext).toString('base64');

    let sentRequestBytes: Uint8Array | undefined;
    let sentProtocol: string | undefined;
    installStubMessenger(internals, async (_peer, protocol, payload): Promise<ReliableSendResult> => {
      sentProtocol = protocol;
      sentRequestBytes = payload;
      return {
        delivered: true,
        response: encodeCiphertextChunkCatchupResponse({
          version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
          contextGraphId: cleartextCgId,
          batchIdHex: ethers.hexlify(batchId),
          chunkIndex: 0,
          ciphertextB64: expectedCiphertextB64,
        }),
        attempts: 1,
        messageId: 'm-fetch-happy',
      };
    });

    const resp = await agent.fetchCiphertextChunkFromPeer(REMOTE_PEER, cleartextCgId, batchId, 0, {
      persist: true,
    });

    expect(resp.denied).toBeUndefined();
    expect(resp.ciphertextB64).toBe(expectedCiphertextB64);
    expect(resp.chunkIndex).toBe(0);

    // Initiator MUST send to the LU-11 protocol id.
    expect(sentProtocol).toBe('/dkg/10.0.2/get-ciphertext-chunk');

    // The bytes on the wire MUST decode as a fresh signed catchup
    // request — pins the mint/sign step actually runs and the
    // request shape stays compatible with the responder decoder.
    expect(sentRequestBytes).toBeDefined();
    const decoded = decodeCiphertextChunkCatchupRequest(sentRequestBytes!);
    expect(decoded.contextGraphId).toBe(cleartextCgId);
    expect(decoded.chunkIndex).toBe(0);
    expect(decoded.batchId).toEqual(batchId);
    expect(decoded.sig).toMatch(/^0x[0-9a-fA-F]{130}$/);
    expect(decoded.requesterEoa).toMatch(/^0x[0-9a-f]{40}$/);
    // Codex review feedback: the shape check above only proves the
    // sig field is hex-shaped — a regression in the `{r, vs}` →
    // 65-byte serialization (the bridge between `chain.signMessage`
    // and ethers-recoverable bytes) would pass the regex but FAIL
    // on the responder side. Round-trip through the real verifier
    // so the test pins the actual signing contract (digest binds
    // the wire fields + sig recovers to the claimed EOA + freshness
    // window).
    const verification = verifySignedCiphertextChunkCatchupRequest(decoded, Date.now());
    expect(verification.ok).toBe(true);
    expect(verification.recoveredSigner).toBe(decoded.requesterEoa);

    // Persist landed under the CANONICAL graph (wire hash), which
    // matches the responder lookup site. Pre-#729 Bug 5 the persist
    // site could end up under the raw `contextGraphId` graph and
    // the responder lookup under the canonical graph — a write/read
    // address mismatch that silently dropped backfilled chunks.
    const persistedB64 = await chunkPersistedAt(internals, {
      canonicalCgId: canonical,
      batchId,
      chunkIndex: 0,
    });
    expect(persistedB64).toBe(`"${expectedCiphertextB64}"`);
  });

  it('canonicalChunkStoreCgIdOrNull returns null (unknown numeric CG id): persist falls back to ciphertextChunkStoreGraph(rawContextGraphId) — #729 Bug 5 mirror', async () => {
    // Codex review feedback: the file header docstring claims this
    // fallback is pinned, but no test actually exercises the
    // `persistCanonical ?? contextGraphId` branch
    // (`dkg-agent.ts:11150-11151`). The branch is the persist-side
    // mirror of the responder's #729 Bug 5 fix — without it, the
    // initiator could end up persisting under the canonical graph
    // while the responder reads from the raw graph (or vice versa),
    // causing a write/read address mismatch that silently drops
    // backfilled chunks.
    //
    // To force canonicalization to return null we use a numeric
    // `contextGraphId` ("42") with no entry in
    // `subscribedContextGraphs` and no `onChainId` match — this
    // hits `resolveLocalCgIdByOnChainId(42n) → null` and
    // `canonicalChunkStoreCgIdOrNull` returns null via the `\d+`
    // branch at `dkg-agent.ts:17048-17055`. The persist site then
    // falls back to the raw `"42"` graph.
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const numericCgId = '42';
    // Important: do NOT register "42" in subscribedContextGraphs —
    // that's what makes canonicalChunkStoreCgIdOrNull return null.
    // The closest analogue in production: a chain-event race window
    // where the prover ticks before the local CG mapping arrives.
    expect(internals.subscribedContextGraphs.has(numericCgId)).toBe(false);

    const batchId = ethers.getBytes(ethers.id('canon-null-batch'));
    const expectedCiphertext = new Uint8Array([0xC0, 0xDE]);
    const expectedCiphertextB64 = Buffer.from(expectedCiphertext).toString('base64');

    installStubMessenger(internals, async (): Promise<ReliableSendResult> => ({
      delivered: true,
      response: encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: numericCgId,
        batchIdHex: ethers.hexlify(batchId),
        chunkIndex: 0,
        ciphertextB64: expectedCiphertextB64,
      }),
      attempts: 1,
      messageId: 'm-canon-null',
    }));

    const resp = await agent.fetchCiphertextChunkFromPeer(REMOTE_PEER, numericCgId, batchId, 0, {
      persist: true,
    });
    expect(resp.ciphertextB64).toBe(expectedCiphertextB64);

    // Pin the fallback: persist landed under the RAW "42" graph
    // (because the canonical resolver returned null), NOT under a
    // synthesised `keccak("42")` graph (which is the pre-#729 bug
    // shape — fabricating a keccak-of-decimal-string was the
    // exact failure mode that dropped backfilled chunks).
    const persistedAtRaw = await chunkPersistedAt(internals, {
      canonicalCgId: numericCgId,
      batchId,
      chunkIndex: 0,
    });
    expect(persistedAtRaw).toBe(`"${expectedCiphertextB64}"`);

    // And: nothing landed at `keccak("42")` (the misleading
    // canonical-looking graph). Without this assertion the test
    // would silently pass if the fallback were inverted.
    const wrongGraph = internals.gossipWireIdFor(numericCgId);
    const persistedAtWrongGraph = await chunkPersistedAt(internals, {
      canonicalCgId: wrongGraph,
      batchId,
      chunkIndex: 0,
    });
    expect(persistedAtWrongGraph).toBeNull();
  });

  it('persist=false: no write to the store (random sampling prover path that wants in-memory bytes only)', async () => {
    // The prover-side backfill always passes `persist: true`, but
    // there are query paths (e.g. one-shot retrieve for a public CG)
    // that might want the response without polluting local storage.
    // The function honours that contract today; pin it.
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const cgId = 'cg-no-persist';
    internals.subscribedContextGraphs.set(cgId, { topic: cgId });
    const canonical = internals.gossipWireIdFor(cgId);
    const batchId = ethers.getBytes(ethers.id('no-persist-batch'));
    const ciphertextB64 = Buffer.from('whatever').toString('base64');

    installStubMessenger(internals, async (): Promise<ReliableSendResult> => ({
      delivered: true,
      response: encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: cgId,
        batchIdHex: ethers.hexlify(batchId),
        chunkIndex: 5,
        ciphertextB64,
      }),
      attempts: 1,
      messageId: 'm-no-persist',
    }));

    const resp = await agent.fetchCiphertextChunkFromPeer(REMOTE_PEER, cgId, batchId, 5, {
      persist: false,
    });
    expect(resp.ciphertextB64).toBe(ciphertextB64);

    const persisted = await chunkPersistedAt(internals, { canonicalCgId: canonical, batchId, chunkIndex: 5 });
    expect(persisted).toBeNull();
  });

  it('responder returns denied: the ACK is RETURNED (not thrown) so the backfill loop can fall through to the next peer', async () => {
    // Pinned by the explicit `if (resp.denied) { ...; continue; }`
    // branch in `buildCiphertextChunkBackfill`. If a refactor made
    // this throw, every denied peer would also kill the loop's
    // try-block and we'd skip the remaining peers — defeating the
    // 5-layer authority's "ask the next peer" graceful-degradation.
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const cgId = 'cg-denied-test';
    internals.subscribedContextGraphs.set(cgId, { topic: cgId });
    const batchId = ethers.getBytes(ethers.id('denied-batch'));

    installStubMessenger(internals, async (): Promise<ReliableSendResult> => ({
      delivered: true,
      response: encodeCiphertextChunkCatchupResponse({
        version: CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
        contextGraphId: cgId,
        batchIdHex: ethers.hexlify(batchId),
        chunkIndex: 0,
        denied: 'unauthorized requester (not on agent allowlist)',
      }),
      attempts: 1,
      messageId: 'm-denied',
    }));

    const resp = await agent.fetchCiphertextChunkFromPeer(REMOTE_PEER, cgId, batchId, 0, {
      persist: true,
    });

    expect(resp.denied).toBe('unauthorized requester (not on agent allowlist)');
    expect(resp.ciphertextB64).toBeUndefined();

    // Codex review (round 2) feedback: also pin that a denied
    // response SKIPS persistence even when the caller set
    // `persist: true`. Without this assertion, a refactor that
    // wrote to the chunk store BEFORE checking `resp.denied`
    // would pass the test silently while writing untrusted
    // (potentially attacker-controlled) bytes to local storage.
    const canonical = internals.gossipWireIdFor(cgId);
    const persistedDespiteDenied = await chunkPersistedAt(internals, {
      canonicalCgId: canonical,
      batchId,
      chunkIndex: 0,
    });
    expect(persistedDespiteDenied).toBeNull();
  });

  it('transport failure (delivered=false): throws with the messenger error in the message — backfill loop records as a failure', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const cgId = 'cg-transport-fail';
    internals.subscribedContextGraphs.set(cgId, { topic: cgId });
    const batchId = ethers.getBytes(ethers.id('transport-fail-batch'));

    // Codex review feedback: `delivered: false` only admits two
    // variants on `ReliableSendResult` — `{queued: true, ...,
    // nextAttemptAtMs}` (durable retry, the realistic transport-
    // failure shape) or `{queued: false, inFlight: true, attempts: 0}`
    // (sender-side dedup). Use the durable-retry shape so the test
    // pins the real production contract.
    installStubMessenger(internals, async (): Promise<ReliableSendResult> => ({
      delivered: false,
      queued: true,
      attempts: 1,
      messageId: 'm-fail',
      error: 'peer-not-reachable',
      nextAttemptAtMs: Date.now() + 60_000,
    }));

    await expect(
      agent.fetchCiphertextChunkFromPeer(REMOTE_PEER, cgId, batchId, 0),
    ).rejects.toThrow(/LU-11 chunk-catchup transport failed: peer-not-reachable/);
  });

  it('missing chain.signMessage: throws an honest precondition error (not a silent unsigned send)', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    // Strip the chain signer. The closure inside the function
    // reaches for `chain.signMessage` directly — make it
    // undefined to trip the early-return guard.
    (internals.chain as { signMessage?: unknown }).signMessage = undefined;

    const cgId = 'cg-no-signer';
    const batchId = ethers.getBytes(ethers.id('no-signer-batch'));

    await expect(
      agent.fetchCiphertextChunkFromPeer(REMOTE_PEER, cgId, batchId, 0),
    ).rejects.toThrow(/chain adapter does not expose signMessage/);
  });

  it('rejects a non-32-byte batchId with a precise error (catches caller bugs at the API boundary)', async () => {
    const boot = await bootAgent();
    agent = boot.agent;

    const shortBatchId = new Uint8Array(16);
    await expect(
      agent.fetchCiphertextChunkFromPeer(REMOTE_PEER, 'cg-bad-batch', shortBatchId, 0),
    ).rejects.toThrow(/requires a 32-byte batchId; got 16/);

    const tooLongBatchId = new Uint8Array(33);
    await expect(
      agent.fetchCiphertextChunkFromPeer(REMOTE_PEER, 'cg-bad-batch', tooLongBatchId, 0),
    ).rejects.toThrow(/requires a 32-byte batchId; got 33/);
  });

  it('rejects a negative chunkIndex with a precise error (catches caller bugs at the API boundary)', async () => {
    const boot = await bootAgent();
    agent = boot.agent;

    const batchId = new Uint8Array(32);
    await expect(
      agent.fetchCiphertextChunkFromPeer(REMOTE_PEER, 'cg-bad-idx', batchId, -1),
    ).rejects.toThrow(/requires a non-negative chunkIndex; got -1/);
  });
});

describe('DKGAgent.ingestSwmCiphertextChunkEnvelope — gossip ingester wiring (LU-11)', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
  });

  function buildChunkedEnvelopeBytes(opts: {
    contextGraphId: string;
    swmMessageIndex: number;
    payload: Uint8Array;
    type?: string;
  }): Uint8Array {
    return encodeGossipEnvelope({
      version: GOSSIP_ENVELOPE_VERSION,
      type: opts.type ?? GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
      contextGraphId: opts.contextGraphId,
      agentAddress: '0x0000000000000000000000000000000000000001',
      timestamp: String(Date.now()),
      // We don't bother signing — auth is stubbed at the
      // `verifyHostModeEnvelopeAuthority` layer in these tests.
      signature: new Uint8Array(65),
      payload: opts.payload,
      swmMessageIndex: opts.swmMessageIndex,
    });
  }

  it('happy path: persists ciphertext under canonical CG graph (matches initiator persist + responder lookup keying)', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    stubAuthority(internals, { accepted: true });

    const cgId = 'cg-ingest-happy';
    internals.subscribedContextGraphs.set(cgId, { topic: cgId });
    const canonical = internals.gossipWireIdFor(cgId);

    const batchId = ethers.getBytes(ethers.id('ingest-happy-batch'));
    const ciphertext = new Uint8Array([0xAA, 0xBB, 0xCC]);
    const payload = new Uint8Array(batchId.length + ciphertext.length);
    payload.set(batchId, 0);
    payload.set(ciphertext, batchId.length);

    const envelopeBytes = buildChunkedEnvelopeBytes({
      contextGraphId: cgId,
      swmMessageIndex: 7,
      payload,
    });

    await internals.ingestSwmCiphertextChunkEnvelope(cgId, envelopeBytes, REMOTE_PEER);

    const persisted = await chunkPersistedAt(internals, {
      canonicalCgId: canonical,
      batchId,
      chunkIndex: 7,
    });
    expect(persisted).toBe(`"${Buffer.from(ciphertext).toString('base64')}"`);
  });

  it('truncated payload (≤ 32 bytes — no room for ciphertext after batchId): silently drops, nothing persists', async () => {
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    stubAuthority(internals, { accepted: true });

    const cgId = 'cg-ingest-truncated';
    internals.subscribedContextGraphs.set(cgId, { topic: cgId });

    const truncatedPayload = new Uint8Array(32); // exactly batchId, zero ciphertext
    const envelopeBytes = buildChunkedEnvelopeBytes({
      contextGraphId: cgId,
      swmMessageIndex: 0,
      payload: truncatedPayload,
    });

    // Must not throw, must not persist anything.
    await expect(
      internals.ingestSwmCiphertextChunkEnvelope(cgId, envelopeBytes, REMOTE_PEER),
    ).resolves.toBeUndefined();

    const canonical = internals.gossipWireIdFor(cgId);
    const persisted = await chunkPersistedAt(internals, {
      canonicalCgId: canonical,
      batchId: truncatedPayload,
      chunkIndex: 0,
    });
    expect(persisted).toBeNull();
  });

  it('wireId mismatch (envelope.contextGraphId ≠ subscription cgId in wire form): silently drops, nothing persists', async () => {
    // Defense against an attacker (or buggy peer) sending a chunk
    // for a DIFFERENT CG over the local subscription's topic — the
    // wire-id comparison MUST short-circuit before the persist.
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    stubAuthority(internals, { accepted: true });

    const subscriptionCgId = 'cg-subscription-id';
    const envelopeCgId = 'cg-totally-different-id';
    internals.subscribedContextGraphs.set(subscriptionCgId, { topic: subscriptionCgId });
    const canonicalEnvelope = internals.gossipWireIdFor(envelopeCgId);

    const batchId = ethers.getBytes(ethers.id('wireid-mismatch-batch'));
    const ciphertext = new Uint8Array([0xFF]);
    const payload = new Uint8Array(batchId.length + ciphertext.length);
    payload.set(batchId, 0);
    payload.set(ciphertext, batchId.length);

    const envelopeBytes = buildChunkedEnvelopeBytes({
      contextGraphId: envelopeCgId,
      swmMessageIndex: 0,
      payload,
    });

    await internals.ingestSwmCiphertextChunkEnvelope(subscriptionCgId, envelopeBytes, REMOTE_PEER);

    // Codex review (round 2) feedback: assert NOTHING persisted
    // under EITHER cg's canonical graph. Previously only the
    // envelope CG was checked, which means a regression that
    // persisted under the SUBSCRIPTION cg's graph (e.g. by trusting
    // the topic-CG and ignoring the envelope-CG) would pass
    // silently. Both must be null for the drop semantics to hold.
    const canonicalSubscription = internals.gossipWireIdFor(subscriptionCgId);
    expect(await chunkPersistedAt(internals, {
      canonicalCgId: canonicalEnvelope,
      batchId,
      chunkIndex: 0,
    })).toBeNull();
    expect(await chunkPersistedAt(internals, {
      canonicalCgId: canonicalSubscription,
      batchId,
      chunkIndex: 0,
    })).toBeNull();
  });

  it('LU-6 authority declines: silently drops, nothing persists (security gate honoured)', async () => {
    // Critical security path: if the authority gate rejects an
    // envelope (e.g. signature doesn't recover to anyone on the
    // agent allowlist, peer not on allowedPeers, etc.) the ingest
    // MUST drop without persisting. Otherwise any topic-reachable
    // peer could plant arbitrary ciphertext under a victim's
    // `(cgId, batchId)` keys.
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    stubAuthority(internals, { accepted: false, reason: 'signature does not recover to allowlist' });

    const cgId = 'cg-authority-decline';
    internals.subscribedContextGraphs.set(cgId, { topic: cgId });
    const canonical = internals.gossipWireIdFor(cgId);

    const batchId = ethers.getBytes(ethers.id('authority-decline-batch'));
    const ciphertext = new Uint8Array([0xDE, 0xAD]);
    const payload = new Uint8Array(batchId.length + ciphertext.length);
    payload.set(batchId, 0);
    payload.set(ciphertext, batchId.length);
    const envelopeBytes = buildChunkedEnvelopeBytes({
      contextGraphId: cgId,
      swmMessageIndex: 1,
      payload,
    });

    await internals.ingestSwmCiphertextChunkEnvelope(cgId, envelopeBytes, REMOTE_PEER);

    expect(await chunkPersistedAt(internals, { canonicalCgId: canonical, batchId, chunkIndex: 1 })).toBeNull();
  });

  it('wrong envelope type (V1 share-write instead of share-write-chunked): silently drops — chunked ingester MUST NOT pick up legacy V1', async () => {
    // The handler discriminator pins
    // `type === GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED`; sending the
    // legacy `share-write` type over the chunked subscription must
    // be ignored. Otherwise a V1 substrate publish would be
    // accidentally indexed under `(cgId, batchId, chunkIndex)` with
    // a meaningless 0 chunkIndex and corrupt the chunk store.
    const boot = await bootAgent();
    agent = boot.agent;
    const internals = boot.internals;
    stubAuthority(internals, { accepted: true });

    const cgId = 'cg-wrong-envelope-type';
    internals.subscribedContextGraphs.set(cgId, { topic: cgId });
    const canonical = internals.gossipWireIdFor(cgId);

    const batchId = ethers.getBytes(ethers.id('wrong-type-batch'));
    const ciphertext = new Uint8Array([0x42]);
    const payload = new Uint8Array(batchId.length + ciphertext.length);
    payload.set(batchId, 0);
    payload.set(ciphertext, batchId.length);

    const envelopeBytes = buildChunkedEnvelopeBytes({
      contextGraphId: cgId,
      swmMessageIndex: 0,
      payload,
      type: GOSSIP_TYPE_WORKSPACE_PUBLISH, // V1, not chunked
    });

    await internals.ingestSwmCiphertextChunkEnvelope(cgId, envelopeBytes, REMOTE_PEER);

    expect(await chunkPersistedAt(internals, { canonicalCgId: canonical, batchId, chunkIndex: 0 })).toBeNull();
  });
});
