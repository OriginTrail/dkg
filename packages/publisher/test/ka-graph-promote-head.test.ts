/**
 * PR #1715 review — the originator does not receive its own GossipSub
 * finalization, so `assertionPromote` must persist the same monotonic
 * graph-scoped workspace head the receiver path writes. Without it a delayed
 * older peer replay can look like the first version locally and replace the
 * freshly promoted graph. Receiver-side tests stage heads manually, so this
 * covers the originator-only write.
 */
import { describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  TypedEventBus,
  generateEd25519Keypair,
  buildAssertionSealQuads,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  assertionLifecycleUri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  MemoryLayer,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
} from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  DKGPublisher,
  computeFlatKCRootV10,
  resolveKnowledgeAssetWorkspaceHead,
  resolveKnowledgeAssetOperationPublicQuads,
} from '../src/index.js';

const CG = 'promote-head-cg';
const AGENT = '0x00000000000000000000000000000000000000a1';
const NAME = 'promote-head-asset';
const KA_UAL = `did:dkg:31337/${AGENT}/9`;
const DKG = 'http://dkg.io/ontology/';

describe('assertionPromote graph-scoped workspace head (originator replay fence)', () => {
  it('persists the monotonic KA head alongside the immutable operation snapshot', async () => {
    const store = new OxigraphStore();
    const publisher = new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
    const graphManager = new GraphManager(store);
    const scope = createGraphKnowledgeAssetScope(KA_UAL, 1);
    const wmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.WorkingMemory, scope);
    const swmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope);
    const publicQuads: Quad[] = [
      { subject: 'urn:e:head-one', predicate: 'http://schema.org/name', object: '"One"', graph: '' },
      { subject: 'urn:e:head-two', predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
    ];
    const merkleRoot = computeFlatKCRootV10(publicQuads, []);

    await store.insert(publicQuads.map((quad) => ({ ...quad, graph: wmGraph })));
    await store.insert(buildAssertionSealQuads({
      assertionUri: contextGraphAssertionUri(CG, AGENT, NAME),
      metaGraph: contextGraphMetaUri(CG),
      merkleRoot,
      authorAddress: AGENT,
      authorAttestationR: new Uint8Array(32).fill(1),
      authorAttestationVS: new Uint8Array(32).fill(2),
      authorSchemeVersion: 1,
      chainId: 31337n,
      kav10Address: AGENT,
      reservedKaId: (BigInt(AGENT) << 96n) | 9n,
      finalizedAtIso: '2026-01-01T00:00:00.000Z',
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: KA_UAL,
      assertionVersion: 1,
      publicTripleCount: publicQuads.length,
      privateTripleCount: 0,
    }) as Quad[]);
    // The graph-scoped write gate reads the lifecycle URN's scope marker.
    await store.insert([{
      subject: assertionLifecycleUri(CG, AGENT, NAME),
      predicate: `${DKG}contentScopeVersion`,
      object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
      graph: contextGraphMetaUri(CG),
    }]);

    const promoted = await publisher.assertionPromote(CG, NAME, AGENT);
    expect(promoted.promotedCount).toBe(2);
    expect(promoted.shareOperationId).toBeTruthy();

    // The durable head is the receiver-parity replay fence: it must exist,
    // name this exact assertion, and point at the promoted operation.
    const head = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG,
      kaUal: KA_UAL,
    });
    expect(head).toBeDefined();
    expect(head).toMatchObject({
      kaUal: KA_UAL,
      assertionVersion: '1',
      assertionGraph: swmGraph,
      publicTripleCount: 2,
      privateTripleCount: 0,
      shareOperationId: promoted.shareOperationId,
    });

    // The head's operation snapshot resolves back to the exact promoted quads,
    // so a stale replay can be detected against real content, not just a row.
    const snapshot = await resolveKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CG,
      shareOperationId: promoted.shareOperationId!,
      kaUal: KA_UAL,
      assertionVersion: 1,
    });
    expect(snapshot.quads).toHaveLength(2);
    expect(new Set(snapshot.quads.map((quad) => quad.subject))).toEqual(
      new Set(['urn:e:head-one', 'urn:e:head-two']),
    );
  });
});
