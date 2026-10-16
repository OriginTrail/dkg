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
  const payload = fault.contentAtFault.quads.map(q => [q.subject, q.predicate, literal(q.object)]);
  const contentMatches = payload.every(([s,p,o]) => final.some(r => r.s.value === s && r.p.value === p && r.o.value === o));
  proofs.push({ name, firedAt: fault.firedAt, fields: matches, contentTriplesAtFault: payload.length,
    originalSealOperationAndContentPreserved: matches.every(m => m.matches) && contentMatches });
}
fs.writeFileSync(`${dir}/fault-identity-proof.json`, JSON.stringify(proofs, null, 2));
console.log(proofs.map(({name, originalSealOperationAndContentPreserved}) => ({name, originalSealOperationAndContentPreserved})));
