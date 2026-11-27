import { ASSERTION_SEAL_PREDICATES as P, parseAssertionSealQuads,
  canonicalGraphScopedAuthorSealFromAssertionSealV1 } from '../../packages/core/dist/index.js';
import { parsePromoteOperationIntent } from '../../packages/publisher/dist/promote-operation-intent.js';
import { capturedTermIdentity } from './rdf-term-identity.mjs';
const DKG = 'http://dkg.io/ontology/';
export const shareIdentityPredicates = new Set([...Object.values(P), DKG + 'shareOperationId', DKG + 'promoteOperationIntent']);

/** Captured values cannot prove preservation unless the original authority is complete. */
export function validateCapturedShareIdentity(fault) {
  const errors = [];
  const quads = fault.metadataAtFault?.quads ?? [];
  const original = quads.filter(q => shareIdentityPredicates.has(q.predicate));
  try {
    const graphs = new Set(fault.intendedMetadataInsert.map(q => q.graph));
    if (graphs.size !== 1 || ![...graphs][0]) throw Error('Missing unambiguous original metadata graph');
    if (original.some(q => q.graph && q.graph !== [...graphs][0])) throw Error('Original identity outside its metadata graph');
    const roots = original.filter(q => q.predicate === P.ASSERTION_MERKLE_ROOT);
    if (roots.length !== 1) throw Error('Capture requires exactly one original seal');
    const sealRows = original.filter(q => q.subject === roots[0].subject);
    for (const predicate of new Set(sealRows.map(q => q.predicate))) {
      if (![P.ASSERTION_ROOT_ENTITY, P.ASSERTION_ENTITY].includes(predicate)
        && sealRows.filter(q => q.predicate === predicate).length !== 1) throw Error('Conflicting original seal fields');
    }
    const seal = parseAssertionSealQuads(sealRows, roots[0].subject);
    if (!seal) throw Error('Missing original seal');
    canonicalGraphScopedAuthorSealFromAssertionSealV1(seal);
    const lifecycles = new Set(fault.intendedMetadataInsert.filter(q => q.predicate === DKG + 'state').map(q => q.subject));
    if (lifecycles.size !== 1) throw Error('Missing unambiguous original lifecycle');
    const lifecycle = [...lifecycles][0];
    const stringField = predicate => {
      const fields = original.filter(q => q.predicate === DKG + predicate);
      if (fields.length !== 1 || fields[0].subject !== lifecycle) throw Error(`Missing or conflicting original ${predicate}`);
      const [kind, value, datatype, language] = capturedTermIdentity(fields[0].object);
      if (kind !== 'literal' || datatype !== 'http://www.w3.org/2001/XMLSchema#string' || language) throw Error(`Invalid original ${predicate}`);
      return value;
    };
    const operationId = stringField('shareOperationId');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(operationId)) throw Error('Invalid original operation ID');
    parsePromoteOperationIntent(stringField('promoteOperationIntent'), operationId);
  } catch (error) { errors.push(error.message); }
  return { original, captureComplete: errors.length === 0, captureErrors: errors };
}
