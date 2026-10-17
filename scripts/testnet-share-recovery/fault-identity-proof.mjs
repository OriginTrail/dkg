import { loadCampaign } from './campaign-manifest.mjs';
import { sameCapturedTerm, sameCapturedQuads } from './rdf-term-identity.mjs';
import fs from 'node:fs';
import { validateCapturedShareIdentity } from './captured-share-identity.mjs';
const [arm, label] = process.argv.slice(2);
const dir = `.tmp/2963/evidence/${arm}`;
const final = JSON.parse(fs.readFileSync(`${dir}/${label}/rdf.json`)).results.bindings;
const proofs = [];
for (const name of loadCampaign(arm).faults.map(f => f.name)) {
  const fault = JSON.parse(fs.readFileSync(`.tmp/2963/${arm}-home/2963-fault-${name}.json`));
  const { original: before, captureComplete, captureErrors } = validateCapturedShareIdentity(fault);
  const metadataGraph = fault.intendedMetadataInsert[0]?.graph;
  if (!metadataGraph) throw Error('Fault evidence lacks its exact metadata graph');
  const matches = before.map(q => {
    const rows = final.filter(r => r.g.type === 'uri' && r.g.value === metadataGraph && r.s.type === 'uri' && r.s.value === q.subject && r.p.type === 'uri' && r.p.value === q.predicate);
    return { subject: q.subject, predicate: q.predicate,
      matches: rows.length === 1 && sameCapturedTerm(q.object, rows[0].o) };
  });
  const graph = fault.intendedMetadataInsert.find(q => q.predicate === 'http://dkg.io/ontology/assertionGraph')?.object;
  if (!graph) throw Error('Fault evidence lacks its exact SWM graph');
  const payload = fault.contentAtFault.quads;
  const contentMatches = sameCapturedQuads(payload, final.filter(r => r.g.value === graph), graph);
  proofs.push({ name, comparison: 'full-rdf-term-v2', metadataGraph, captureComplete, captureErrors, firedAt: fault.firedAt, fields: matches, contentTriplesAtFault: payload.length,
    originalSealOperationAndContentPreserved: captureComplete && matches.every(m => m.matches) && contentMatches });
}
fs.writeFileSync(`${dir}/fault-identity-proof.json`, JSON.stringify(proofs, null, 2));
console.log(proofs.map(({name, originalSealOperationAndContentPreserved}) => ({name, originalSealOperationAndContentPreserved})));
