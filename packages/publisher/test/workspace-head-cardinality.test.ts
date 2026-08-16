import { describe, expect, it } from 'vitest';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  KnowledgeAssetWorkspaceHeadCorruptError,
  resolveKnowledgeAssetWorkspaceHead,
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from '../src/index.js';

// GH#2273: SWM catch-up union-inserts a peer's head `shareOperationId` row
// beside the local one (shared-memory-sync bulk insert holds no lock and
// performs no delete), leaving ONE head subject carrying TWO operation ids.
// `resolveKnowledgeAssetWorkspaceHead` was `LIMIT 1` over that state, so every
// consumer — gossip monotonicity, finalization, access decisions, and the
// async VM-publish preflight — received an ARBITRARY answer that could change
// between calls. These rows pin the corrected contract: head-id cardinality
// is measured as COUNT(DISTINCT shareOperationId) ON THE HEAD SUBJECT, and
// more than one distinct id fails closed as KA_WORKSPACE_HEAD_CORRUPT.
//
// The predicate is deliberately NOT `bindings.length` of the main resolver
// query: that query carries three OPTIONALs on the operation subject
// (privateMerkleRoot / publishedAt / accessPolicy), so binding count is a
// cross-product. Two `publishedAt` rows on ONE operation subject — reachable
// in production when two cores ACK the same content with different clocks and
// a third node unions both via sync — must keep resolving (see the
// duplicate-publishedAt row below, which kills a bindings.length
// implementation).

const CONTEXT_GRAPH = 'head-cardinality';
const UAL = 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/7';
// Format contract with workspace-resolution.ts (module-private helpers):
// head subject = `<ual>#dkg-swm-head`, operation subject =
// `urn:dkg:share:<contextGraphId>:<shareOperationId>`.
const HEAD_SUBJECT = `${UAL}#dkg-swm-head`;
const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const LOCAL_OP = 'op-a';
// The realistic foreign id shape: deterministic storage-ACK mint on a
// receiving core (storage-ack-handler.ts), served back to the author by the
// SWM responder after a restart.
const REMOTE_OP = 'storage-ack-2273b';

const CONTENT: Quad[] = [
  { subject: 'urn:entity:1', predicate: 'urn:predicate:value', object: '"one"', graph: '' },
  { subject: 'urn:entity:2', predicate: 'urn:predicate:value', object: '"two"', graph: '' },
];

interface Harness {
  store: OxigraphStore;
  graphManager: GraphManager;
  metaGraph: string;
}

function makeHarness(): Harness {
  const store = new OxigraphStore();
  const graphManager = new GraphManager(store);
  return { store, graphManager, metaGraph: graphManager.sharedMemoryMetaUri(CONTEXT_GRAPH) };
}

async function seedOperation(h: Harness, shareOperationId: string): Promise<void> {
  await storeKnowledgeAssetOperationPublicQuads({
    store: h.store,
    graphManager: h.graphManager,
    contextGraphId: CONTEXT_GRAPH,
    shareOperationId,
    kaUal: UAL,
    assertionVersion: 1,
    quads: CONTENT,
    publisherPeerId: 'peer-1',
    timestamp: new Date('2026-08-16T00:00:00.000Z'),
  });
}

async function seedHealthyHead(h: Harness): Promise<void> {
  await seedOperation(h, LOCAL_OP);
  await storeKnowledgeAssetWorkspaceHead({
    store: h.store,
    graphManager: h.graphManager,
    contextGraphId: CONTEXT_GRAPH,
    kaUal: UAL,
    assertionVersion: 1,
    shareOperationId: LOCAL_OP,
  });
}

/**
 * The corruption is fabricated with a RAW insert because that is exactly what
 * produces it in production: `storeKnowledgeAssetWorkspaceHead` is
 * delete-then-insert (cannot stack), while the sync bulk insert is a bare
 * set-union onto the same subject.
 */
async function unionInsertSecondHeadId(h: Harness): Promise<void> {
  await h.store.insert([{
    subject: HEAD_SUBJECT,
    predicate: `${DKG}shareOperationId`,
    object: JSON.stringify(REMOTE_OP),
    graph: h.metaGraph,
  }]);
}

function resolveHead(h: Harness) {
  return resolveKnowledgeAssetWorkspaceHead({
    store: h.store,
    graphManager: h.graphManager,
    contextGraphId: CONTEXT_GRAPH,
    kaUal: UAL,
  });
}

describe('graph-scoped SWM head shareOperationId cardinality', () => {
  it('resolves a healthy single-operation head (guard polarity control)', async () => {
    const h = makeHarness();
    await seedHealthyHead(h);
    const head = await resolveHead(h);
    expect(head?.shareOperationId).toBe(LOCAL_OP);
    expect(head?.assertionVersion).toBe('1');
  });

  it('fails closed when the head carries two operation ids and both operation subjects exist', async () => {
    const h = makeHarness();
    await seedHealthyHead(h);
    await seedOperation(h, REMOTE_OP);
    await unionInsertSecondHeadId(h);
    // Pre-fix: LIMIT 1 resolved to whichever of the two full solutions the
    // store returned first — an answer that could differ between calls on the
    // same state. The queued VM-publish preflight compared that arbitrary id
    // against its admission-time id and terminally failed the job as
    // publish_intent_stale (GH#2273's reported death).
    await expect(resolveHead(h)).rejects.toThrow(KnowledgeAssetWorkspaceHeadCorruptError);
    await expect(resolveHead(h)).rejects.toThrow(/shareOperationId/);
  });

  it('fails closed when the head carries two operation ids even if the second operation subject is absent', async () => {
    const h = makeHarness();
    await seedHealthyHead(h);
    await unionInsertSecondHeadId(h);
    // Pre-fix this state silently resolved to the SURVIVING operation: the
    // main query joins head→operation on the id, so the danging second id
    // contributed no binding and LIMIT 1 saw exactly one solution. The head
    // row set is corrupt all the same — a later arrival of the second
    // operation subject would flip the resolver's answer — so cardinality
    // must be measured on the HEAD ROWS, not on the join result.
    await expect(resolveHead(h)).rejects.toThrow(KnowledgeAssetWorkspaceHeadCorruptError);
  });

  it('fails closed when the head carries two assertionVersion values (same corruption class)', async () => {
    const h = makeHarness();
    await seedHealthyHead(h);
    // Union residue can stack a second VERSION row just as it stacks a second
    // operation id (the materializer's needsRepair flags versions > 1 for the
    // same reason). Pre-refactor the joined LIMIT-1 read picked one version
    // arbitrarily — the overwrite-with-older hazard for the gossip
    // monotonicity gate. The phased resolver requires exactly one distinct
    // value per REQUIRED head predicate, so this is the same corrupt outcome.
    await h.store.insert([{
      subject: HEAD_SUBJECT,
      predicate: `${DKG}assertionVersion`,
      object: `"2"^^<${XSD}integer>`,
      graph: h.metaGraph,
    }]);
    await expect(resolveHead(h)).rejects.toThrow(KnowledgeAssetWorkspaceHeadCorruptError);
    await expect(resolveHead(h)).rejects.toThrow(/assertionVersion/);
  });

  it('still resolves when one operation subject carries duplicate optional rows (kills a bindings-length guard)', async () => {
    const h = makeHarness();
    await seedHealthyHead(h);
    // Two cores ACKing the same content mint the SAME deterministic operation
    // subject but stamp their own clocks; a node that unions both peers' meta
    // ends with two publishedAt rows on ONE operation. The resolver's main
    // query then yields TWO bindings for a head with exactly ONE operation
    // id. A guard on bindings.length would fail this healthy head closed;
    // the cardinality guard must not.
    const operationSubject = `urn:dkg:share:${CONTEXT_GRAPH}:${LOCAL_OP}`;
    await h.store.insert([{
      subject: operationSubject,
      predicate: `${DKG}publishedAt`,
      object: `"2026-08-16T00:00:05.000Z"^^<${XSD}dateTime>`,
      graph: h.metaGraph,
    }]);
    const head = await resolveHead(h);
    expect(head?.shareOperationId).toBe(LOCAL_OP);
  });
});
