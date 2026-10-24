import { verifyInventoryProjections } from './inventory-projection-proof.mjs';
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
const projections = verifyInventoryProjections(campaign, seals, inventoryScope.rows, inventoryScope.catalogRows, read(`${label}/rdf.json`).results.bindings);
const result = { ...verifyIdentityTuples(seals, inventoryScope.catalogRows, inventoryScope.rows), operations, projections,
  inventoryScope: { ...inventoryScope, rows: undefined, catalogRows: undefined } };
result.identityErrors.push(...operations.errors.map(error => ({ inventoryOperation: error.name ?? null, reason: error.message ?? error })));
result.identityErrors.push(...projections.errors.map(error => ({ projection: error.name, reason: error.message })));
result.exactCatalogIdentity &&= projections.exactCatalog;
result.exactInventoryIdentity &&= inventoryScope.valid && operations.exact && projections.exactInventory;
// Baselines intentionally retain missing operations. Export false exact-set flags;
// never repair or silently drop them to make this read-only evidence step pass.
fs.writeFileSync(`${root}/identity-proof.json`, JSON.stringify(result,null,2));
console.log(result);

if (!inventoryScope.valid || !operations.consistent || !projections.consistent) process.exitCode = 1;
