import { verifyInventoryOperations, faultOperationWitnesses } from './inventory-operation-proof.mjs';
import { loadCampaign } from './campaign-manifest.mjs';
import { verifyInventoryScope } from './inventory-scope.mjs';
import fs from 'node:fs';
import { verifyIdentityTuples } from './identity-tuples.mjs';
const [arm,label] = process.argv.slice(2), root = `.tmp/2963/evidence/${arm}`;
const read = file => JSON.parse(fs.readFileSync(`${root}/${file}`));
const campaign = loadCampaign(arm);
const catalogs = read(`${label}/catalogs.json`);
const inventoryScope = verifyInventoryScope(campaign, read(`${label}/inventory.json`), catalogs, read(`${label}/-api-status.json`));
const seals = read('seal-proof.json');
const operations = verifyInventoryOperations(campaign, seals.map(s => s.name), inventoryScope.rows, read(`${label}/rdf.json`).results.bindings,
  faultOperationWitnesses(campaign, read('fault-identity-proof.json')));
const result = { ...verifyIdentityTuples(seals, inventoryScope.catalogRows, inventoryScope.rows), operations,
  inventoryScope: { ...inventoryScope, rows: undefined, catalogRows: undefined } };
result.identityErrors.push(...operations.errors.map(error => ({ inventoryOperation: error.name ?? null, reason: error.message ?? error })));
result.exactInventoryIdentity &&= inventoryScope.valid && operations.exact;
// Baselines intentionally retain missing operations. Export false exact-set flags;
// never repair or silently drop them to make this read-only evidence step pass.
fs.writeFileSync(`${root}/identity-proof.json`, JSON.stringify(result,null,2));
console.log(result);

if (!inventoryScope.valid || !operations.consistent) process.exitCode = 1;
