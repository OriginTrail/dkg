import { ASSERTION_SEAL_PREDICATES } from '../../packages/core/dist/index.js';
import { capturedTermIdentity, bindingTermIdentity, sameCapturedTerm } from './rdf-term-identity.mjs';
const DKG = 'http://dkg.io/ontology/';
const identityPredicates = new Set([...Object.values(ASSERTION_SEAL_PREDICATES), DKG + 'shareOperationId', DKG + 'promoteOperationIntent']);
const canonical = values => JSON.stringify(values.sort());

/** Prove recovered identity and lifecycle in the original authoritative metadata graph. */
export function verifyRestartMetadata(fault, rows) {
  const graphs = new Set(fault.intendedMetadataInsert.map(q => q.graph));
  if (graphs.size !== 1 || ![...graphs][0]) throw Error('Missing unambiguous captured metadata graph');
  const metadataGraph = [...graphs][0];
  const metadata = rows.filter(r => r.g.value === metadataGraph);
  const original = fault.metadataAtFault.quads.filter(q => identityPredicates.has(q.predicate));
  const subjects = new Set(original.map(q => q.subject));
  const before = original.map(q => JSON.stringify([capturedTermIdentity(q.subject), capturedTermIdentity(q.predicate), capturedTermIdentity(q.object)]));
  const after = metadata.filter(r => subjects.has(r.s.value) && identityPredicates.has(r.p.value))
    .map(r => JSON.stringify([bindingTermIdentity(r.s), bindingTermIdentity(r.p), bindingTermIdentity(r.o)]));
  const originalSealAndIntent = before.length > 0 && canonical(before) === canonical(after);
  const lifecycle = fault.intendedMetadataInsert.find(q => q.predicate === DKG + 'state')?.subject;
  const root = original.find(q => q.predicate === DKG + 'assertionMerkleRoot')?.object;
  // The seal uses xsd:hexBinary; the lifecycle pointer stores its lexical root as xsd:string.
  const rootPointer = root === undefined ? undefined : JSON.stringify(capturedTermIdentity(root)[1]);
  const graph = fault.intendedMetadataInsert.find(q => q.predicate === DKG + 'assertionGraph')?.object;
  const one = (predicate, expected) => {
    const found = metadata.filter(r => r.s.value === lifecycle && r.p.value === DKG + predicate);
    return expected !== undefined && found.length === 1 && sameCapturedTerm(expected, found[0].o);
  };
  const lifecycleComplete = !!lifecycle && one('state', '"promoted"') && one('memoryLayer', '"SWM"')
    && one('swmShareComplete', '"true"') && one('swmCurrentAssertion', rootPointer) && one('assertionGraph', graph);
  return { metadataGraph, originalSealAndIntent, lifecycleComplete };
}
