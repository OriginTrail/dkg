import { describe, expect, it } from 'vitest';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  TypedEventBus,
  assertionLifecycleUri,
  buildAssertionSealQuads,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  createGraphKnowledgeAssetScope,
  generateEd25519Keypair,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/index.js';

const CG = 'graph-pull-from-test';
const AGENT = '0x00000000000000000000000000000000000000a1';
const NAME = 'rootless-public-update';
const DKG = 'http://dkg.io/ontology/';
const UAL = `did:dkg:evm:31337/${AGENT}/7`;

function q(subject: string, predicate: string, object: string, graph: string): Quad {
  return { subject, predicate, object, graph };
}

describe('graph-scoped KA pull-from', () => {
  it('reopens a rootless public KA from its exact VM graph', async () => {
    const store = new OxigraphStore();
    const publisher = new DKGPublisher({
      store,
      chain: new NoChainAdapter(),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const vmGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.VerifiableMemory, scope);
    const adjacentVmGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.VerifiableMemory,
      createGraphKnowledgeAssetScope(`did:dkg:evm:31337/${AGENT}/8`, 1),
    );
    const assertionUri = contextGraphAssertionUri(CG, AGENT, NAME);
    const lifecycle = assertionLifecycleUri(CG, AGENT, NAME);
    const metaGraph = contextGraphMetaUri(CG);
    const seal = buildAssertionSealQuads({
      assertionUri,
      metaGraph,
      merkleRoot: new Uint8Array(32).fill(9),
      authorAddress: AGENT,
      authorAttestationR: new Uint8Array(32).fill(1),
      authorAttestationVS: new Uint8Array(32).fill(2),
      authorSchemeVersion: 1,
      chainId: 31337n,
      kav10Address: AGENT,
      reservedKaId: (BigInt(AGENT) << 96n) | 7n,
      finalizedAtIso: '2026-01-01T00:00:00.000Z',
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: UAL,
      assertionVersion: 1,
      publicTripleCount: 2,
      privateTripleCount: 0,
    }) as Quad[];
    await store.insert([
      q('urn:entity:alice', 'http://schema.org/name', '"Alice v1"', vmGraph),
      q('urn:entity:bob', 'http://schema.org/name', '"Bob v1"', vmGraph),
      q('urn:entity:mallory', 'http://schema.org/name', '"Adjacent KA"', adjacentVmGraph),
      ...seal,
      q(lifecycle, `${DKG}kaId`, '"7"^^<http://www.w3.org/2001/XMLSchema#integer>', metaGraph),
      q(lifecycle, `${DKG}reservedUal`, `"${UAL}"`, metaGraph),
      q(lifecycle, `${DKG}contentScopeVersion`, `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<http://www.w3.org/2001/XMLSchema#integer>`, metaGraph),
    ]);

    const result = await publisher.assertionPullFrom(CG, NAME, AGENT, 'vm');

    expect(result).toMatchObject({ fromLayer: 'vm', entities: 0, seeded: 2 });
    expect(await publisher.assertionQuery(CG, NAME, AGENT)).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'urn:entity:alice', object: '"Alice v1"' }),
      expect.objectContaining({ subject: 'urn:entity:bob', object: '"Bob v1"' }),
    ]));
    expect(await publisher.assertionQuery(CG, NAME, AGENT)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'urn:entity:mallory' }),
    ]));
    const staleSeal = await store.query(
      `ASK { GRAPH <${metaGraph}> { <${assertionUri}> <${DKG}assertionMerkleRoot> ?root } }`,
    );
    expect(staleSeal).toMatchObject({ type: 'boolean', value: false });
  });
});
