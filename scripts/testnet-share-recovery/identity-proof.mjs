import fs from 'node:fs';
import { verifyIdentityTuples } from './identity-tuples.mjs';
const [arm,label] = process.argv.slice(2), root = `.tmp/2963/evidence/${arm}`;
const read = file => JSON.parse(fs.readFileSync(`${root}/${file}`));
const result = verifyIdentityTuples(read('seal-proof.json'), read(`${label}/catalogs.json`).flatMap(c => c.rows), read(`${label}/inventory.json`).swm);
// Baselines intentionally retain missing operations. Export false exact-set flags;
// never repair or silently drop them to make this read-only evidence step pass.
fs.writeFileSync(`${root}/identity-proof.json`, JSON.stringify(result,null,2));
console.log(result);
