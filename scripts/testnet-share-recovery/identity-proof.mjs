import { loadCampaign } from './campaign-manifest.mjs';
import { verifyInventoryScope } from './inventory-scope.mjs';
import fs from 'node:fs';
import { verifyIdentityTuples } from './identity-tuples.mjs';
const [arm,label] = process.argv.slice(2), root = `.tmp/2963/evidence/${arm}`;
const read = file => JSON.parse(fs.readFileSync(`${root}/${file}`));
const catalogs = read(`${label}/catalogs.json`);
const inventoryScope = verifyInventoryScope(loadCampaign(arm), read(`${label}/inventory.json`), catalogs, read(`${label}/-api-status.json`));
const result = { ...verifyIdentityTuples(read('seal-proof.json'), inventoryScope.catalogRows, inventoryScope.rows),
  inventoryScope: { ...inventoryScope, rows: undefined, catalogRows: undefined } };
result.exactInventoryIdentity &&= inventoryScope.valid;
// Baselines intentionally retain missing operations. Export false exact-set flags;
// never repair or silently drop them to make this read-only evidence step pass.
fs.writeFileSync(`${root}/identity-proof.json`, JSON.stringify(result,null,2));
console.log(result);

if (!inventoryScope.valid) process.exitCode = 1;
