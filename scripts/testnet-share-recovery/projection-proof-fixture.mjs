import { buildAssertionSealQuads, parseAssertionSealQuads, canonicalGraphScopedAuthorSealFromAssertionSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer } from '../../packages/core/dist/index.js';
import { computeFlatKCRootV10 } from '../../packages/publisher/dist/index.js';
import { inventoryScopeFixture, operationRowsFixture } from './inventory-scope-fixture.mjs';
import { projectionCommitments } from './inventory-projection-proof.mjs';
import { capturedTermIdentity } from './rdf-term-identity.mjs';
export function projectionProofFixture(campaign, name = 'asset', operation = 'operation-A', mutate = () => {}) {
  const author = campaign.author.toLowerCase(), kaUal = `did:dkg:base:84532/${author}/1`;
  const payload = [{ subject: `urn:fixture:${name}`, predicate: 'urn:value', object: '"original"', graph: '' }];
  const subject = `did:dkg:context-graph:${campaign.contextGraphId}/assertion/${campaign.author}/${name}`;
  const graph = `did:dkg:context-graph:${campaign.contextGraphId}/_meta`;
  const sealQuads = buildAssertionSealQuads({ assertionUri: subject, metaGraph: graph, merkleRoot: computeFlatKCRootV10(payload, []),
    authorAddress: author, authorAttestationR: new Uint8Array(32).fill(0x11), authorAttestationVS: new Uint8Array(32).fill(0x22),
    authorSchemeVersion: 1, chainId: 84532n, kav10Address: '0x666D0c3da3dBc946D5128D06115bb4eed4595580',
    reservedKaId: (BigInt(author) << 96n) | 1n, finalizedAtIso: '2026-10-16T00:00:00.000Z', contentScopeVersion: 2,
    kaUal, assertionVersion: '1', publicTripleCount: 1, privateTripleCount: 0 });
  const seal = canonicalGraphScopedAuthorSealFromAssertionSealV1(parseAssertionSealQuads(sealQuads, subject));
  const sealDigest = computeCanonicalGraphScopedAuthorSealDigestV1(seal), commitment = projectionCommitments(seal, payload);
  const inventory = { assertion_coordinate: name, ka_ual: kaUal, share_operation_id: operation, seal_digest: sealDigest,
    public_triple_count_u64be: '0x0000000000000001', projection_digest: commitment.projectionDigest };
  const catalog = { assertionCoordinate: name, kaId: seal.reservedKaId, sealDigest, projectionDigest: commitment.projectionDigest, transfer: commitment.transfer };
  mutate(inventory, catalog);
  const f = inventoryScopeFixture(campaign, [inventory], [catalog]);
  const term = raw => { const [type, value, datatype, language] = capturedTermIdentity(raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw);
    return { type, value, ...(type === 'literal' && datatype !== 'http://www.w3.org/2001/XMLSchema#string' ? { datatype } : {}), ...(language ? { 'xml:lang': language } : {}) }; };
  const swm = knowledgeAssetLayerGraphUri(campaign.contextGraphId, MemoryLayer.SharedWorkingMemory, createGraphKnowledgeAssetScope(kaUal, '1'));
  const rdf = [...sealQuads, ...payload.map(q => ({ ...q, graph: swm }))].map(q => ({ s: term(q.subject), p: term(q.predicate), o: term(q.object), g: term(q.graph) }));
  return { ...f, expected: [{ name, seal, sealDigest }], sealQuads, rdf: [...rdf, ...operationRowsFixture(campaign, name, operation)] };
}
