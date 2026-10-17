import { loadCampaign, campaignCounts } from './campaign-manifest.mjs';
import { verifyIdentityTuples } from './identity-tuples.mjs';
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
const campaign = loadCampaign(arm), counts = campaignCounts(campaign), names = campaign.cohorts.initial;
const inventory = JSON.parse(fs.readFileSync(`${dir}/pre-workload/inventory.json`)).swm;
const catalog = JSON.parse(fs.readFileSync(`${dir}/pre-workload/catalogs.json`)).flatMap(c=>c.rows);
const expected = names.map(name => {
  const entry = seals.get(name);
  if (!entry) throw Error(`Missing prepared seal: ${name}`);
  return {name, seal: entry.seal, sealDigest: entry.digest};
});
const identities = verifyIdentityTuples(expected, catalog, inventory);
if (seals.size !== counts.main || !identities.exactInventoryIdentity || !identities.exactCatalogIdentity) throw Error('Starting identity set mismatch');
fs.writeFileSync(`${dir}/starting-set-proof.json`,JSON.stringify({inventoryExactIdentities:counts.initial,catalogExactIdentities:counts.initial,allSealDigestsAndVersionsMatch:true,preparedSeals:counts.main},null,2));
console.log('Exact starting identity, seal and version sets verified.');
