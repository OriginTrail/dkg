import { buildAssertionSealQuads } from '../../packages/core/dist/index.js';
import { capturedTermIdentity } from './rdf-term-identity.mjs';

export function faultEvidenceFixture() {
  const graph = 'urn:original-meta', subject = 'urn:asset', sealSubject = 'urn:seal';
  const q = (p, object) => ({ subject, predicate: 'http://dkg.io/ontology/' + p, object, graph });
  const seal = buildAssertionSealQuads({ assertionUri: sealSubject, metaGraph: graph,
    merkleRoot: new Uint8Array(32).fill(0xab), authorAddress: '0x1111111111111111111111111111111111111111',
    authorAttestationR: new Uint8Array(32).fill(0x11), authorAttestationVS: new Uint8Array(32).fill(0x22),
    authorSchemeVersion: 1, chainId: 84532n, kav10Address: '0x666D0c3da3dBc946D5128D06115bb4eed4595580',
    reservedKaId: (BigInt('0x1111111111111111111111111111111111111111') << 96n) | 1n,
    finalizedAtIso: '2026-10-16T00:00:00.000Z', contentScopeVersion: 2,
    kaUal: 'did:dkg:base:84532/0x1111111111111111111111111111111111111111/1', assertionVersion: '1',
    publicTripleCount: 1, privateTripleCount: 0 }).map(row => ({ ...row,
      object: row.object.startsWith('<') ? row.object.slice(1, -1) : row.object }));
  const intent = { version: 1, operationId: 'original', timestampMs: 1, confirmationRequired: false,
    accessPolicy: 'public', allowedPeers: [] };
  const original = [...seal, q('shareOperationId', '"original"'), q('promoteOperationIntent', JSON.stringify(JSON.stringify(intent)))];
  const root = 'ab'.repeat(32);
  const lifecycle = [q('state', '"promoted"'), q('memoryLayer', '"SWM"'), q('swmShareComplete', '"true"'),
    q('swmCurrentAssertion', JSON.stringify(root)), q('assertionGraph', 'urn:swm')];
  const payload = [{ subject: 'urn:payload', predicate: 'urn:value', object: '"original"', graph: 'urn:swm' }];
  const term = text => { const [type, value, datatype, language] = capturedTermIdentity(text);
    return { type, value, ...(datatype ? { datatype } : {}), ...(language ? { 'xml:lang': language } : {}) }; };
  const rows = [...original, ...lifecycle, ...payload].map(row => ({ g: term(row.graph), s: term(row.subject), p: term(row.predicate), o: term(row.object) }));
  return { graph, subject, rows, fault: { firedAt: '2026-10-16T00:00:00.000Z', metadataAtFault: { quads: original },
    contentAtFault: { quads: payload }, intendedMetadataInsert: lifecycle } };
}
