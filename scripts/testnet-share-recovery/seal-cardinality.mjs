import { ASSERTION_SEAL_PREDICATES } from '../../packages/core/dist/index.js';
import { bindingTermIdentity } from './rdf-term-identity.mjs';

const singleValued = new Set(Object.values(ASSERTION_SEAL_PREDICATES));
singleValued.delete(ASSERTION_SEAL_PREDICATES.ASSERTION_ROOT_ENTITY);
singleValued.delete(ASSERTION_SEAL_PREDICATES.ASSERTION_ENTITY);

/** Check captured RDF before the compatibility parser can select a last value. */
export function assertUnambiguousSealFields(rows) {
  const values = new Map();
  for (const row of rows) {
    if (row.p.type !== 'uri' || !singleValued.has(row.p.value)) continue;
    const value = JSON.stringify(bindingTermIdentity(row.o));
    const previous = values.get(row.p.value);
    if (previous !== undefined && previous !== value) {
      throw Error(`Conflicting seal field: ${row.p.value}`);
    }
    values.set(row.p.value, value);
  }
}
