/**
 * `handleGetCiphertextChunk` responder coverage — the
 * `/dkg/10.0.2/get-ciphertext-chunk` LU-11 / OT-RFC-39 sync verb that
 * lets late-joining hosting cores backfill missing
 * `(cgId, batchId, chunkIndex)` ciphertexts from any authorized peer.
 *
 * Lives in `packages/agent/src/dkg-agent.ts:10839-11067`.
 *
 * Two PRs shipped behaviour changes here without regression tests:
 *
 *   - **PR #717** added the responder itself, including the OT-RFC-39
 *     fifth authority (registered node operators are admitted because
 *     the bytes are AEAD-encrypted and the chain commitment is
 *     already public).
 *   - **PR #729 Bug 5** fixed the canonical-CG keying inside the
 *     lookup: pre-fix the responder unconditionally called
 *     `gossipWireIdFor(req.contextGraphId)`, which keccak-hashed a
 *     literal decimal string like "42" and missed every chunk
 *     persisted under the curator's nameHash. The fix routes through
 *     `canonicalChunkStoreCgIdOrNull` and widens to the wildcard
 *     `GRAPH ?g` scan when the canonicaliser can't safely resolve.
 *
 * This file pins both behaviours so a future refactor can't silently
 * re-introduce the decimal-string keccak miss or break the responder's
 * structured-denial contract.
 *
 * Scope is narrow on purpose: we exercise the canonical-CG keying
 * branches via the simplest authority path (`getIdentityIdForAddress`
 * returning a non-zero identityId) and the structured-deny shape on
 * unauthorized / malformed inputs. The full 5-layer auth surface
 * (chain participants, beacon curator, agent gate, allowedPeers) is
 * exercised indirectly via the "unauthorized requester" test — that
 * test pokes every layer and confirms they all answer "no" without
 * the test having to wire each one up explicitly.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
} from '@origintrail-official/dkg-chain';
import {
  ciphertextChunkStoreGraph,
  ciphertextChunkStoreSubject,
  CIPHERTEXT_CHUNK_PREDICATE,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import {
  CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION,
  mintSignedCiphertextChunkCatchupRequest,
  encodeCiphertextChunkCatchupRequest,
  decodeCiphertextChunkCatchupResponse,
} from '../src/swm/ciphertext-chunk-catchup.js';

/**
 * Boot an agent on the in-memory mock chain adapter and surface the
 * responder + a few internal hooks we'll monkey-patch per-test:
 *
 *   - `chain.getIdentityIdForAddress` — the OT-RFC-39 fifth authority
 *     hook. By default we wire this on the mock so a non-zero
 *     identityId admits the requester (mirrors a registered node
 *     operator on chain).
 *
 *   - `subscribedContextGraphs` — drives `canonicalChunkStoreCgIdOrNull`
 *     into the "subscribed cleartext name → wire hash" branch.
 *
 *   - `gossipWireIdFor` — keccak-on-string mapping that
 *     `canonicalChunkStoreCgIdOrNull` calls once it has a key it trusts.
 *
 *   - `store` — real TripleStore wired into the agent so we can write
 *     chunk quads and the responder's SPARQL `SELECT` lookups against
 *     them.
 */
interface ResponderInternals {
  handleGetCiphertextChunk(data: Uint8Array, fromPeerId: string): Promise<Uint8Array>;
  store: {
    insert(quads: { subject: string; predicate: string; object: string; graph: string }[]): Promise<void>;
  };
  chain: { getIdentityIdForAddress?: (address: string) => Promise<bigint> };
  subscribedContextGraphs: Map<string, unknown>;
  gossipWireIdFor(rawId: string): string;
  // Used by Codex-review-driven tests to (a) pin the
  // canonicalChunkStoreCgIdOrNull===null precondition explicitly
  // and (b) freeze the numeric-id lookup so future fixture
  // changes can't accidentally make Bug 5 coverage disappear.
  canonicalChunkStoreCgIdOrNull(rawId: string): string | null;
  resolveLocalCgIdByOnChainId(onChainId: bigint): string | null;
}

async function bootResponderAgent(): Promise<{ agent: DKGAgent; internals: ResponderInternals }> {
  const agent = await DKGAgent.create({
    name: 'GetChunkResponderTest',
    chainAdapter: new MockChainAdapter(),
    // OT-RFC-49 WS-A defaults `stripCiphertext` ON, which retires host-mode
    // ciphertext-chunk custody (the handler declines "private-ciphertext strip
    // is on" before any lookup). These tests verify the chunk-SERVING handler's
    // canonical-CG keying / authority / replay logic, which is only reachable
    // when a node opts INTO custody — so disable the strip for this responder.
    swmHostMode: { stripCiphertext: false },
  });
  const internals = agent as unknown as ResponderInternals;
  return { agent, internals };
}

/**
 * Persist a chunk under the same shape `ingestSwmCiphertextChunkEnvelope`
 * (`dkg-agent.ts:10466-10475`) writes:
 *
 *   GRAPH <ciphertextChunkStoreGraph(canonicalCgId)> {
 *     <ciphertextChunkStoreSubject(batchId, i)>
 *       <CIPHERTEXT_CHUNK_PREDICATE>
 *       "<base64(ciphertext)>"
 *   }
 */
async function seedChunk(
  internals: ResponderInternals,
  opts: { canonicalCgId: string; batchId: Uint8Array; chunkIndex: number; ciphertext: Uint8Array },
): Promise<void> {
  await internals.store.insert([{
    subject: ciphertextChunkStoreSubject(opts.batchId, opts.chunkIndex),
    predicate: CIPHERTEXT_CHUNK_PREDICATE,
    object: `"${Buffer.from(opts.ciphertext).toString('base64')}"`,
    graph: ciphertextChunkStoreGraph(opts.canonicalCgId),
  }]);
}

/**
 * Authorise a wallet via the OT-RFC-39 node-operator path by patching
 * `chain.getIdentityIdForAddress` to return a non-zero identityId for
 * the wallet's lowercased EOA.
 *
 * Important: leaves the other four authority sources untouched so
 * that the responder still has to fall through to this fifth layer
 * (i.e. the test exercises the full auth chain, not just a shortcut).
 */
function authorizeAsNodeOperator(
  internals: ResponderInternals,
  wallet: ethers.Wallet,
  identityId: bigint = 42n,
): void {
  internals.chain.getIdentityIdForAddress = async (address: string) => {
    if (address.toLowerCase() === wallet.address.toLowerCase()) return identityId;
    return 0n;
  };
}

/**
 * Mint a wire-shaped, EIP-191-signed catchup request for the given
 * wallet. Mirrors what the requester side
 * (`fetchCiphertextChunkFromPeer`) does in production.
 */
async function mintRequest(
  wallet: ethers.Wallet,
  opts: { contextGraphId: string; batchId: Uint8Array; chunkIndex: number },
): Promise<Uint8Array> {
  const req = await mintSignedCiphertextChunkCatchupRequest({
    contextGraphId: opts.contextGraphId,
    batchId: opts.batchId,
    chunkIndex: opts.chunkIndex,
    requesterEoa: wallet.address.toLowerCase(),
    sign: async (digest: Uint8Array) => wallet.signMessage(digest),
  });
  expect(req.version).toBe(CIPHERTEXT_CHUNK_CATCHUP_WIRE_VERSION);
  return encodeCiphertextChunkCatchupRequest(req);
}

const FAKE_PEER_ID = '12D3KooWFakeResponderTestPeerId';

describe('DKGAgent.handleGetCiphertextChunk — canonical CG keying (#729 Bug 5 regression)', () => {
  let agent: DKGAgent | null = null;
  afterEach(async () => {
    if (agent) {
      await agent.stop().catch(() => undefined);
      agent = null;
    }
  });

  it('serves the ciphertext when the chunk is persisted under a recognized canonical graph (subscribed cleartext CG → keccak wire hash → scoped lookup)', async () => {
    const boot = await bootResponderAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const requester = ethers.Wallet.createRandom();
    authorizeAsNodeOperator(internals, requester);

    // Subscribe to a cleartext CG so `canonicalChunkStoreCgIdOrNull`
    // resolves it via `gossipWireIdFor` (the subscribed-cleartext
    // branch — see `dkg-agent.ts:17047`).
    const cleartextCgId = 'cg-cleartext-responder-test';
    internals.subscribedContextGraphs.set(cleartextCgId, { topic: cleartextCgId });
    const canonical = internals.gossipWireIdFor(cleartextCgId);

    const batchId = ethers.getBytes(ethers.id('responder-batch-A'));
    const ciphertext = new Uint8Array([0xCA, 0xFE, 0xBA, 0xBE]);
    await seedChunk(internals, { canonicalCgId: canonical, batchId, chunkIndex: 0, ciphertext });

    const requestBytes = await mintRequest(requester, {
      contextGraphId: cleartextCgId,
      batchId,
      chunkIndex: 0,
    });

    const responseBytes = await internals.handleGetCiphertextChunk(requestBytes, FAKE_PEER_ID);
    const response = decodeCiphertextChunkCatchupResponse(responseBytes);

    expect(response.denied).toBeUndefined();
    expect(response.contextGraphId).toBe(cleartextCgId);
    expect(response.chunkIndex).toBe(0);
    expect(response.ciphertextB64).toBeTypeOf('string');
    expect(Buffer.from(response.ciphertextB64!, 'base64').equals(Buffer.from(ciphertext))).toBe(true);
  });

  it('#729 Bug 5 regression: serves the chunk when requester addresses CG by numeric on-chain id with no local mapping — handler widens to GRAPH ?g, not keccak("42")', async () => {
    // Pre-#729 the responder called `gossipWireIdFor(req.contextGraphId)`
    // unconditionally. For a request with `contextGraphId = "42"` that
    // produced `keccak("42")` and a scoped lookup against
    // `ciphertextChunkStoreGraph(keccak("42"))` — a graph URI nothing
    // would ever be persisted to. Every late-joining core's backfill
    // dropped to "chunk not found" even though the bytes were on
    // disk under the curator's real nameHash graph.
    //
    // The fix routes through `canonicalChunkStoreCgIdOrNull` which
    // returns `null` for an unknown numeric (no entry in
    // `subscribedContextGraphs` / `resolveLocalCgIdByOnChainId`), and
    // the responder widens to `GRAPH ?g`. The chunk is then found
    // under whatever graph it was persisted to.
    const boot = await bootResponderAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const requester = ethers.Wallet.createRandom();
    authorizeAsNodeOperator(internals, requester);

    // Codex review feedback: this regression test only exercises
    // the `GRAPH ?g` fallback if `canonicalChunkStoreCgIdOrNull("42")`
    // returns null. That precondition was implicit — if
    // `bootResponderAgent()` ever started with a local mapping for
    // on-chain id 42 the test would still pass while no longer
    // covering Bug 5. Make the precondition explicit AND defend it
    // against future helper changes:
    //   1) Assert directly that the responder's canonicalization
    //      returns null for "42" right now (pins the runtime state).
    //   2) Stub `resolveLocalCgIdByOnChainId(42n)` to forever return
    //      null, so even if a future fixture seeds a mapping for
    //      "42" the canonicalization branch still hits the null
    //      path that Bug 5 lived on.
    const originalResolve = internals.resolveLocalCgIdByOnChainId.bind(internals);
    internals.resolveLocalCgIdByOnChainId = (onChainId: bigint) =>
      onChainId === 42n ? null : originalResolve(onChainId);
    expect(internals.canonicalChunkStoreCgIdOrNull('42')).toBeNull();

    // Persist the chunk under an ARBITRARY canonical graph that the
    // responder can't reconstruct from `contextGraphId = "42"` alone
    // (no local CG mapping for the numeric id). With Bug 5 unfixed
    // this would have been searched at `keccak("42")` and missed; with
    // the fix the wildcard `GRAPH ?g` scan picks it up.
    const persistedCanonical = '0x' + ethers.keccak256(ethers.toUtf8Bytes('curator-nameHash-for-cg-42')).slice(2);
    const batchId = ethers.getBytes(ethers.id('responder-bug5-batch'));
    const ciphertext = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
    await seedChunk(internals, { canonicalCgId: persistedCanonical, batchId, chunkIndex: 3, ciphertext });

    const requestBytes = await mintRequest(requester, {
      contextGraphId: '42',
      batchId,
      chunkIndex: 3,
    });

    const response = decodeCiphertextChunkCatchupResponse(
      await internals.handleGetCiphertextChunk(requestBytes, FAKE_PEER_ID),
    );

    expect(response.denied).toBeUndefined();
    expect(response.contextGraphId).toBe('42');
    expect(response.chunkIndex).toBe(3);
    expect(response.ciphertextB64).toBeTypeOf('string');
    expect(Buffer.from(response.ciphertextB64!, 'base64').equals(Buffer.from(ciphertext))).toBe(true);
  });

  it('returns "chunk not found" when the responder cannot locate the (cgId, batchId, chunkIndex) under any graph', async () => {
    const boot = await bootResponderAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const requester = ethers.Wallet.createRandom();
    authorizeAsNodeOperator(internals, requester);

    // Subscribe so canonicalization works, but DON'T seed the chunk.
    const cleartextCgId = 'cg-missing-chunk-test';
    internals.subscribedContextGraphs.set(cleartextCgId, { topic: cleartextCgId });

    const batchId = ethers.getBytes(ethers.id('responder-not-found-batch'));
    const requestBytes = await mintRequest(requester, {
      contextGraphId: cleartextCgId,
      batchId,
      chunkIndex: 7,
    });

    const response = decodeCiphertextChunkCatchupResponse(
      await internals.handleGetCiphertextChunk(requestBytes, FAKE_PEER_ID),
    );

    expect(response.ciphertextB64).toBeUndefined();
    expect(response.denied).toBe('chunk not found');
    // Echoed back so the requester can correlate the deny with its
    // outstanding request — this is part of the wire contract, not
    // an implementation detail.
    expect(response.contextGraphId).toBe(cleartextCgId);
    expect(response.chunkIndex).toBe(7);
    expect(response.batchIdHex).toBe(ethers.hexlify(batchId));
  });

  it('denies the request when the requester has no authority on the CG (no chain participant, no beacon curator, no agent gate, no allowedPeers, getIdentityIdForAddress=0)', async () => {
    // Exercises the full 5-layer auth fall-through: each of the five
    // authorities answers "no", so the handler returns the structured
    // not-authorized deny.
    const boot = await bootResponderAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const requester = ethers.Wallet.createRandom();
    // Codex review feedback: the test name says
    // "getIdentityIdForAddress=0" but prior to this change the
    // method was actually `undefined` on MockChainAdapter, which
    // makes `dkg-agent.ts:10963` SKIP the fifth-authority probe
    // entirely (`typeof !== 'function'`). A regression that
    // incorrectly authorized `identityId === 0n` would slip
    // through silently. Patch the chain stub to return 0n
    // explicitly so the negative path of layer 5 is genuinely
    // exercised — i.e. the `if (reqIdentityId > 0n)` guard is the
    // only thing preventing authorization.
    internals.chain.getIdentityIdForAddress = async (address: string) => {
      // Sanity: this is the requester we mint below; assert via
      // toLowerCase to mirror production casing.
      expect(address.toLowerCase()).toBe(requester.address.toLowerCase());
      return 0n;
    };
    expect(typeof internals.chain.getIdentityIdForAddress).toBe('function');

    const cleartextCgId = 'cg-unauthorized-test';
    internals.subscribedContextGraphs.set(cleartextCgId, { topic: cleartextCgId });

    const batchId = ethers.getBytes(ethers.id('responder-unauthz-batch'));
    const requestBytes = await mintRequest(requester, {
      contextGraphId: cleartextCgId,
      batchId,
      chunkIndex: 0,
    });

    const response = decodeCiphertextChunkCatchupResponse(
      await internals.handleGetCiphertextChunk(requestBytes, FAKE_PEER_ID),
    );

    expect(response.ciphertextB64).toBeUndefined();
    expect(response.denied).toBeTypeOf('string');
    // The handler distinguishes between "no authority source available"
    // (none of the probes returned anything) and "requester not in any
    // of the authorities" (probes returned, but the requester wasn't
    // in any of them). MockChainAdapter returns `null` from most of
    // the probes, so we accept either shape.
    expect(response.denied).toMatch(/not in any of|no authority source/);
  });

  it('denies the request with a structured reason when the wire payload is malformed', async () => {
    const boot = await bootResponderAgent();
    agent = boot.agent;
    const internals = boot.internals;

    // Send a totally invalid JSON byte buffer. The decoder will throw,
    // the handler maps the throw to a `denied: 'malformed request: ...'`
    // wire response (`dkg-agent.ts:10844-10852`).
    const garbage = new TextEncoder().encode('not-a-json-object{');

    const response = decodeCiphertextChunkCatchupResponse(
      await internals.handleGetCiphertextChunk(garbage, FAKE_PEER_ID),
    );

    expect(response.ciphertextB64).toBeUndefined();
    expect(response.denied).toBeTypeOf('string');
    expect(response.denied!.startsWith('malformed request:')).toBe(true);
    // Malformed-path defensive defaults — the handler MUST NOT echo
    // attacker-controlled fields back when it couldn't even decode
    // the payload.
    expect(response.contextGraphId).toBe('');
    expect(response.batchIdHex).toBe('');
    expect(response.chunkIndex).toBe(-1);
  });

  it('denies the same request twice via the replay guard — second attempt with identical (eoa, nonce, issuedAtMs) is rejected', async () => {
    // Defensive boundary the responder relies on:
    // `ciphertextChunkCatchupReplayGuard.recordIfFresh(...)` — without
    // it a replayed signed envelope would be honoured indefinitely.
    const boot = await bootResponderAgent();
    agent = boot.agent;
    const internals = boot.internals;

    const requester = ethers.Wallet.createRandom();
    authorizeAsNodeOperator(internals, requester);

    const cleartextCgId = 'cg-replay-test';
    internals.subscribedContextGraphs.set(cleartextCgId, { topic: cleartextCgId });
    const canonical = internals.gossipWireIdFor(cleartextCgId);
    const batchId = ethers.getBytes(ethers.id('responder-replay-batch'));
    await seedChunk(internals, {
      canonicalCgId: canonical,
      batchId,
      chunkIndex: 0,
      ciphertext: new Uint8Array([0x11, 0x22]),
    });

    // Same wire bytes both times — same nonce, same issuedAtMs,
    // same signature.
    const requestBytes = await mintRequest(requester, {
      contextGraphId: cleartextCgId,
      batchId,
      chunkIndex: 0,
    });

    const first = decodeCiphertextChunkCatchupResponse(
      await internals.handleGetCiphertextChunk(requestBytes, FAKE_PEER_ID),
    );
    expect(first.denied).toBeUndefined();
    expect(first.ciphertextB64).toBeTypeOf('string');

    const second = decodeCiphertextChunkCatchupResponse(
      await internals.handleGetCiphertextChunk(requestBytes, FAKE_PEER_ID),
    );
    expect(second.ciphertextB64).toBeUndefined();
    expect(second.denied).toBe('replayed chunk-catchup nonce');
  });
});
