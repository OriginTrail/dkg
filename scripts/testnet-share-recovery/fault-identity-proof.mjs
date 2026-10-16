import fs from 'node:fs';
import { ASSERTION_SEAL_PREDICATES } from '../../packages/core/dist/index.js';
const [arm, label] = process.argv.slice(2);
const dir = `.tmp/2963/evidence/${arm}`;
const final = JSON.parse(fs.readFileSync(`${dir}/${label}/rdf.json`)).results.bindings;
const predicates = new Set([...Object.values(ASSERTION_SEAL_PREDICATES),
  'http://dkg.io/ontology/shareOperationId', 'http://dkg.io/ontology/promoteOperationIntent']);
const literal = value => {
  if (!value.startsWith('"')) return value;
  const match = value.match(/^("(?:[^"\\]|\\.)*")(?:\^\^<[^>]+>|@[a-zA-Z-]+)?$/);
  if (!match) throw Error('Invalid fault literal');
  return JSON.parse(match[1]);
};
const proofs = [];
for (const name of ['catalog-140', 'catalog-141']) {
  const fault = JSON.parse(fs.readFileSync(`.tmp/2963/${arm}-home/2963-fault-${name}.json`));
  const before = fault.metadataAtFault.quads.filter(q => predicates.has(q.predicate));
  const matches = before.map(q => ({ subject: q.subject, predicate: q.predicate,
    matches: final.filter(r => r.s.value === q.subject && r.p.value === q.predicate).length === 1
      && final.some(r => r.s.value === q.subject && r.p.value === q.predicate && r.o.value === literal(q.object)) }));
  const graph = fault.intendedMetadataInsert.find(q => q.predicate === 'http://dkg.io/ontology/assertionGraph')?.object;
  if (!graph) throw Error('Fault evidence lacks its exact SWM graph');
  const term = value => value.type === 'uri' ? value.value : JSON.stringify(value.value)
    + (value.datatype ? `^^<${value.datatype}>` : value['xml:lang'] ? `@${value['xml:lang']}` : '');
  const payload = fault.contentAtFault.quads.map(q => JSON.stringify([q.subject, q.predicate, q.object])).sort();
  const afterPayload = final.filter(r => r.g.value === graph).map(r => JSON.stringify([r.s.value, r.p.value, term(r.o)])).sort();
  const contentMatches = payload.length > 0 && JSON.stringify(payload) === JSON.stringify(afterPayload);
  proofs.push({ name, firedAt: fault.firedAt, fields: matches, contentTriplesAtFault: payload.length,
    originalSealOperationAndContentPreserved: matches.every(m => m.matches) && contentMatches });
}
fs.writeFileSync(`${dir}/fault-identity-proof.json`, JSON.stringify(proofs, null, 2));
console.log(proofs.map(({name, originalSealOperationAndContentPreserved}) => ({name, originalSealOperationAndContentPreserved})));
