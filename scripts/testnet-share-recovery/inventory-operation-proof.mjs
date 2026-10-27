import { indexAuthoritativeMetadata } from './authoritative-metadata.mjs';
import { parsePromoteOperationIntent } from '../../packages/publisher/dist/promote-operation-intent.js';
import { bindingTermIdentity } from './rdf-term-identity.mjs';
const DKG = 'http://dkg.io/ontology/';

/** Commitments establish row integrity; this separately establishes the original operation. */
export function verifyInventoryOperations(campaign, names, inventory, rdf, originals = []) {
  const errors = [], missing = [], operations = [];
  const index = indexAuthoritativeMetadata(rdf, `did:dkg:context-graph:${campaign.contextGraphId}/_meta`);
  const expected = new Set(names);
  if (expected.size !== names.length) errors.push('Duplicate expected assertion');
  for (const row of inventory) if (!expected.has(row.assertion_coordinate)) errors.push(`Unexpected inventory assertion: ${row.assertion_coordinate}`);
  for (const name of names) {
    try {
      const subject = `urn:dkg:assertion:${campaign.contextGraphId}:${campaign.author}:${name}`;
      const rows = index.get(subject) ?? [];
      const string = predicate => {
        const values = rows.filter(r => r.p.value === DKG + predicate);
        if (values.length !== 1) throw Error(`Missing or ambiguous ${predicate}`);
        const [kind, value, datatype, language] = bindingTermIdentity(values[0].o);
        if (kind !== 'literal' || datatype !== 'http://www.w3.org/2001/XMLSchema#string' || language) throw Error(`Invalid ${predicate}`);
        return value;
      };
      const operationId = string('shareOperationId');
      parsePromoteOperationIntent(string('promoteOperationIntent'), operationId);
      for (const original of originals.filter(o => o.name === name)) {
        if (original.valid !== true || !original.operationId || original.operationId !== operationId) throw Error('Original operation witness differs from lifecycle');
      }
      const present = inventory.filter(r => r.assertion_coordinate === name);
      if (present.length === 0) missing.push(name);
      else if (present.length !== 1 || present[0].share_operation_id !== operationId) throw Error('Inventory operation differs from original lifecycle');
      operations.push({ name, operationId, inventoryOccurrences: present.length });
    } catch (error) { errors.push({ name, message: error.message }); }
  }
  for (const original of originals) if (!expected.has(original.name)) errors.push('Unexpected original operation witness');
  return { consistent: errors.length === 0, exact: errors.length === 0 && missing.length === 0,
    expectedCount: names.length, inventoryCount: inventory.length, missing, errors, operations };
}

export function faultOperationWitnesses(campaign, proofs) {
  return campaign.faults.map(({ name }) => {
    const found = proofs.filter(p => p.name === name);
    return { name, operationId: found[0]?.originalOperationId,
      valid: found.length === 1 && found[0].captureComplete === true && found[0].originalSealOperationAndContentPreserved === true };
  });
}
