import { validatePromoteRecoveryBinding } from '../../packages/publisher/dist/promote-recovery-binding.js';
import { parsePromoteOperationIntent, serializePromoteOperationIntent } from '../../packages/publisher/dist/promote-operation-intent.js';
import { validateCapturedShareIdentity } from './captured-share-identity.mjs';
import { indexAuthoritativeMetadata } from './authoritative-metadata.mjs';
import { ASSERTION_SEAL_PREDICATES } from '../../packages/core/dist/index.js';
import { capturedTermIdentity, bindingTermIdentity, sameCapturedTerm, sameBindingQuads } from './rdf-term-identity.mjs';
const DKG = 'http://dkg.io/ontology/';
const identityPredicates = new Set([...Object.values(ASSERTION_SEAL_PREDICATES), DKG + 'shareOperationId', DKG + 'promoteOperationIntent']);
const canonical = values => JSON.stringify(values.sort());

/** Prove recovered identity and lifecycle in the original authoritative metadata graph. */
export function verifyRestartMetadata(fault, rows) {
  const graphs = new Set(fault.intendedMetadataInsert.map(q => q.graph));
  if (graphs.size !== 1 || ![...graphs][0]) throw Error('Missing unambiguous captured metadata graph');
  const metadataGraph = [...graphs][0];
  const metadata = rows.filter(r => r.g.type === 'uri' && r.g.value === metadataGraph);
  const { original, captureComplete } = validateCapturedShareIdentity(fault);
  const subjects = new Set(original.map(q => q.subject));
  const before = original.map(q => JSON.stringify([capturedTermIdentity(q.subject), capturedTermIdentity(q.predicate), capturedTermIdentity(q.object)]));
  const after = metadata.filter(r => subjects.has(r.s.value) && identityPredicates.has(r.p.value))
    .map(r => JSON.stringify([bindingTermIdentity(r.s), bindingTermIdentity(r.p), bindingTermIdentity(r.o)]));
  const originalSealAndIntent = captureComplete && before.length > 0 && canonical(before) === canonical(after);
  const lifecycle = fault.intendedMetadataInsert.find(q => q.predicate === DKG + 'state')?.subject;
  const root = original.find(q => q.predicate === DKG + 'assertionMerkleRoot')?.object;
  // The seal uses xsd:hexBinary; the lifecycle pointer stores its lexical root as xsd:string.
  const rootPointer = root === undefined ? undefined : JSON.stringify(capturedTermIdentity(root)[1]);
  const graph = fault.intendedMetadataInsert.find(q => q.predicate === DKG + 'assertionGraph')?.object;
  const one = (predicate, expected) => {
    const found = metadata.filter(r => r.s.type === 'uri' && r.s.value === lifecycle && r.p.type === 'uri' && r.p.value === DKG + predicate);
    return expected !== undefined && found.length === 1 && sameCapturedTerm(expected, found[0].o);
  };
  const lifecycleComplete = !!lifecycle && one('state', '"promoted"') && one('memoryLayer', '"SWM"')
    && one('swmShareComplete', '"true"') && one('swmCurrentAssertion', rootPointer) && one('assertionGraph', graph);
  return { metadataGraph, originalSealAndIntent, lifecycleComplete };
}

/** The additional crash trial cannot alter the already verified cohort. */
export function unchangedCohortMetadata(before, after, metadataGraph, subjects) {
  const predicates = new Set([...identityPredicates, ...['state', 'memoryLayer', 'assertionGraph', 'swmShareComplete',
    'swmCurrentAssertion', 'vmCurrentAssertion', 'wmCurrentAssertion'].map(p => DKG + p)]);
  const original = indexAuthoritativeMetadata(before, metadataGraph, predicates);
  const current = indexAuthoritativeMetadata(after, metadataGraph, predicates);
  return subjects.length > 0 && subjects.every(subject => sameBindingQuads(original.get(subject) ?? [], current.get(subject) ?? []));
}

/** Link the queue's execution authority to the captured original RDF operation. */
export function bindingMatchesCapturedOperation(fault, binding) {
  try {
    const { original, captureComplete } = validateCapturedShareIdentity(fault);
    if (!captureComplete) return false;
    const value = predicate => capturedTermIdentity(original.find(q => q.predicate === DKG + predicate).object)[1];
    const intent = parsePromoteOperationIntent(value('promoteOperationIntent'), value('shareOperationId'));
    return serializePromoteOperationIntent(validatePromoteRecoveryBinding(binding).intent)
      === serializePromoteOperationIntent(intent);
  } catch { return false; }
}
