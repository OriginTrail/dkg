import fs from 'node:fs';
import { parseAssertionSealQuads, canonicalGraphScopedAuthorSealFromAssertionSealV1, computeCanonicalGraphScopedAuthorSealDigestV1 } from '../../packages/core/dist/index.js';
const arm = process.argv[2], dir = `.tmp/2963/evidence/${arm}`;
const rdf = JSON.parse(fs.readFileSync(`${dir}/pre-workload/rdf.json`)).results.bindings;
const groups = new Map();
const term = t => t.type === 'uri' ? t.value : JSON.stringify(t.value) + (t.datatype ? `^^<${t.datatype}>` : t['xml:lang'] ? '@' + t['xml:lang'] : '');
for (const r of rdf) {
  if (!r.s.value.includes('/assertion/')) continue;
  if (!groups.has(r.s.value)) groups.set(r.s.value, []);
  groups.get(r.s.value).push({subject:r.s.value,predicate:r.p.value,object:term(r.o),graph:r.g.value});
}
const seals = new Map();
for (const [subject, quads] of groups) {
  const parsed = parseAssertionSealQuads(quads, subject); if (!parsed) continue;
  const seal = canonicalGraphScopedAuthorSealFromAssertionSealV1(parsed);
  seals.set(subject.split('/').at(-1), {seal,digest:computeCanonicalGraphScopedAuthorSealDigestV1(seal)});
}
const names = ['readiness-smoke', ...Array.from({length:179},(_,i)=>`initial-${String(i+1).padStart(3,'0')}`)];
const inventory = JSON.parse(fs.readFileSync(`${dir}/pre-workload/inventory.json`)).swm;
const catalog = JSON.parse(fs.readFileSync(`${dir}/pre-workload/catalogs.json`)).flatMap(c=>c.rows);
const equalSet = (a,b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
if (seals.size !== 436 || !equalSet(inventory.map(r=>r.assertion_coordinate),names) || !equalSet(catalog.map(r=>r.assertionCoordinate),names)) throw Error('Starting identity set mismatch');
for (const r of inventory) {const s=seals.get(r.assertion_coordinate);if(r.ka_ual!==s.seal.kaUal||BigInt(r.assertion_version_u64be).toString()!==s.seal.assertionVersion||r.seal_digest!==s.digest)throw Error('Inventory identity mismatch');}
for (const r of catalog) {const s=seals.get(r.assertionCoordinate);if(r.kaId!==s.seal.reservedKaId||r.assertionVersion!==s.seal.assertionVersion||r.sealDigest!==s.digest)throw Error('Catalog identity mismatch');}
fs.writeFileSync(`${dir}/starting-set-proof.json`,JSON.stringify({inventoryExactIdentities:180,catalogExactIdentities:180,allSealDigestsAndVersionsMatch:true,preparedSeals:436},null,2));
console.log('Exact starting identity, seal and version sets verified.');
