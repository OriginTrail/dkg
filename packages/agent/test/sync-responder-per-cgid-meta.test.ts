import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { registerSyncHandler } from '../src/sync/responder/sync-handler.js';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';
import type { OperationContext } from '@origintrail-official/dkg-core';

/**
 * Regression test for the per-cgId meta sync gap.
 *
 * The publisher (commit 3801df33, "data + meta promotion pattern") writes
 * confirmed V10 KCs into FOUR places on the publisher node:
 *   - canonical data graph         did:dkg:context-graph:<cg>
 *   - canonical meta graph         did:dkg:context-graph:<cg>/_meta
 *   - per-cgId data graph          did:dkg:context-graph:<cg>/context/<cgId>
 *   - per-cgId meta graph          did:dkg:context-graph:<cg>/context/<cgId>/_meta
 *
 * The RS prover's `kc-extractor.ts` reads chunk metadata (merkleRoot, batchId,
 * tokenId, partOf, publication, …) from the per-cgId meta graph specifically.
 *
 * The sync responder previously excluded `?g` if `STRENDS(?g, "/_meta")`,
 * which dropped both the canonical meta (handled by the 'meta' phase, OK) and
 * the per-cgId meta (intended target of this test, NOT handled anywhere).
 *
 * Symptom on the live devnet: non-publisher peers got confirmed canonical data
 * via sync, ran the RS prover loop, but emitted `kc-not-synced` for every
 * challenge against any KC they hadn't published themselves — because their
 * per-cgId `/context/<cgId>/_meta` was empty.
 *
 * This test asserts the data-phase responder includes per-cgId meta quads
 * while still excluding the canonical top-level meta (covered by the meta
 * phase) and `/_private` graphs.
 */

const CG_ID = 'devnet-test';
const CG_PREFIX = `did:dkg:context-graph:${CG_ID}`;
const CG_DATA = CG_PREFIX;
const CG_META = `${CG_PREFIX}/_meta`;
const PER_CG_DATA = `${CG_PREFIX}/context/1`;
const PER_CG_META = `${CG_PREFIX}/context/1/_meta`;
const PRIVATE_GRAPH = `${CG_PREFIX}/_private/secret`;

const KC_URI = 'did:dkg:evm:31337/0x1234567890123456789012345678901234567890';
const DKG_NS = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const REMOTE_PEER_ID = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

const noopLog = (_ctx: OperationContext, _msg: string) => {};

// Captures the handler that registerSyncHandler installs so the test can drive
// it directly without a real libp2p stack.
function captureHandler(): {
  router: { register: (proto: string, h: (data: Uint8Array, peerId: { toString(): string }) => Promise<Uint8Array>) => void };
  invoke: (envelope: SyncRequestEnvelope) => Promise<string>;
} {
  let captured: ((data: Uint8Array, peerId: { toString(): string }) => Promise<Uint8Array>) | null = null;
  return {
    router: {
      register: (_proto, h) => {
        captured = h;
      },
    },
    invoke: async (envelope) => {
      if (!captured) throw new Error('handler not registered');
      const bytes = new TextEncoder().encode(JSON.stringify(envelope));
      const out = await captured(bytes, { toString: () => REMOTE_PEER_ID });
      return new TextDecoder().decode(out);
    },
  };
}

function lineGraphsFromNquads(text: string): Set<string> {
  // Each line: `<s> <p> "o-or-uri" <graph> .`
  // The graph URI is the last `<...>` before the trailing dot.
  const graphs = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // Match <graph> immediately before " ."
    const m = line.match(/<([^<>]+)>\s*\.\s*$/);
    if (m) graphs.add(m[1]);
  }
  return graphs;
}

describe('sync responder data phase — per-cgId meta inclusion', () => {
  let store: OxigraphStore;
  let cap: ReturnType<typeof captureHandler>;

  beforeEach(async () => {
    store = new OxigraphStore();
    await store.insert([
      // Canonical data: a context-graph entity descriptor.
      { graph: CG_DATA, subject: CG_DATA, predicate: RDF_TYPE, object: `${DKG_NS}ContextGraph` },
      // Canonical meta: lifecycle subject (cgEntity) — handled by 'meta' phase only.
      { graph: CG_META, subject: CG_DATA, predicate: `${DKG_NS}createdAt`, object: '"2026-05-10T00:00:00Z"' },
      // Per-cgId data: a published assertion sitting under context/1.
      { graph: PER_CG_DATA, subject: 'urn:bootstrap:c1:k0', predicate: `${DKG_NS}label`, object: '"hello-world"' },
      // Per-cgId meta: KC metadata kc-extractor.ts needs (THE TARGET OF THIS FIX).
      { graph: PER_CG_META, subject: KC_URI, predicate: RDF_TYPE, object: `${DKG_NS}KnowledgeCollection` },
      { graph: PER_CG_META, subject: KC_URI, predicate: `${DKG_NS}merkleRoot`, object: '"deadbeef00000000000000000000000000000000000000000000000000000000"' },
      { graph: PER_CG_META, subject: KC_URI, predicate: `${DKG_NS}kaCount`, object: '"1"' },
      { graph: PER_CG_META, subject: KC_URI, predicate: `${DKG_NS}batchId`, object: '"3"' },
      { graph: PER_CG_META, subject: KC_URI, predicate: `${DKG_NS}tokenId`, object: '"1"' },
      // Private subgraph — must remain excluded.
      { graph: PRIVATE_GRAPH, subject: 'urn:secret:x', predicate: `${DKG_NS}redacted`, object: '"shh"' },
    ]);

    cap = captureHandler();
    registerSyncHandler({
      router: cap.router,
      protocolSync: '/origintrail/dkg/sync/1.0.0',
      syncDeniedResponse: 'sync-denied',
      syncPageSize: 5000,
      sharedMemoryTtlMs: 0,
      store,
      peerId: 'self-peer',
      parseSyncRequest: (data) => JSON.parse(new TextDecoder().decode(data)) as SyncRequestEnvelope,
      authorizeSyncRequest: async () => true,
      logWarn: noopLog,
      logDebug: noopLog,
    });
  });

  it('includes per-cgId /context/<id>/_meta quads in the data-phase response', async () => {
    const out = await cap.invoke({
      contextGraphId: CG_ID,
      offset: 0,
      limit: 5000,
      includeSharedMemory: false,
      phase: 'data',
    });

    const graphs = lineGraphsFromNquads(out);
    expect(graphs.has(PER_CG_META)).toBe(true);
    // Spot-check the merkleRoot landed too — that's the field RS reads first.
    expect(out).toContain(`${DKG_NS}merkleRoot`);
    expect(out).toContain(KC_URI);
  });

  it('still includes per-cgId data and canonical data graphs in the data phase', async () => {
    const out = await cap.invoke({
      contextGraphId: CG_ID,
      offset: 0,
      limit: 5000,
      includeSharedMemory: false,
      phase: 'data',
    });

    const graphs = lineGraphsFromNquads(out);
    expect(graphs.has(PER_CG_DATA)).toBe(true);
    expect(graphs.has(CG_DATA)).toBe(true);
  });

  it('still excludes the canonical top-level /_meta from the data phase (handled by meta phase)', async () => {
    const out = await cap.invoke({
      contextGraphId: CG_ID,
      offset: 0,
      limit: 5000,
      includeSharedMemory: false,
      phase: 'data',
    });

    const graphs = lineGraphsFromNquads(out);
    expect(graphs.has(CG_META)).toBe(false);
  });

  it('still excludes /_private subgraphs from the data phase', async () => {
    const out = await cap.invoke({
      contextGraphId: CG_ID,
      offset: 0,
      limit: 5000,
      includeSharedMemory: false,
      phase: 'data',
    });

    const graphs = lineGraphsFromNquads(out);
    expect(graphs.has(PRIVATE_GRAPH)).toBe(false);
    expect(out).not.toContain('"shh"');
  });

  it('does NOT regress the meta phase — top-level _meta still flows through it', async () => {
    const out = await cap.invoke({
      contextGraphId: CG_ID,
      offset: 0,
      limit: 5000,
      includeSharedMemory: false,
      phase: 'meta',
    });

    const graphs = lineGraphsFromNquads(out);
    // The meta-phase filter requires the subject to match cgEntity (or a few
    // other lifecycle subjects). Our canonical-meta seed uses `subject = CG_DATA`
    // (which is the cgEntity URI), so it should be returned.
    expect(graphs.has(CG_META)).toBe(true);
  });
});
