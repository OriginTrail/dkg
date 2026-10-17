import { collectInventoryScopes, encodeInventory, verifyInventoryScope } from './inventory-scope.mjs';
import { loadCampaign } from './campaign-manifest.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadApiClientToken } from '../../packages/cli/dist/auth.js';
import { DkgHomeFiles } from '../../packages/cli/dist/config.js';
const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url));
const Database = require('better-sqlite3');
const arm = process.argv[2] ?? 'baseline', label = process.argv[3] ?? 'snapshot';
const home = process.env.DKG_HOME, cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json')));
const campaign = loadCampaign(arm), cg = campaign.contextGraphId;
const dir = path.resolve('.tmp/2963/evidence', arm, label); fs.mkdirSync(dir, { recursive: true });
const save = (name, value) => fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(value, null, 2));
let status;
const token = await loadApiClientToken(new DkgHomeFiles(home));
for (const route of ['/api/status', '/api/publisher/jobs?limit=1000', '/api/knowledge-assets/swm/share-jobs']) {
  const r = await fetch(`http://127.0.0.1:${cfg.apiPort}${route}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
  const captured = { status: r.status, value: await r.json() };
  save(route.split('?')[0].replaceAll('/', '-'), captured);
  if (route === '/api/status') status = captured;
}
const db = new Database(path.join(home, 'rfc64-sync/inventory-v1.sqlite3'), { readonly: true });
const hex = b => b.toString('hex');
const rows = collectInventoryScopes(db, cg); db.close();
save('inventory', encodeInventory(rows));
const objectRoot = path.join(home, 'rfc64-sync/control-objects-v1/objects');
const readObject = digest => { const d = digest.replace(/^0x/, ''); return JSON.parse(fs.readFileSync(path.join(objectRoot, d.slice(0, 2), d + '.jcs'))); };
const catalogs = [];
for (const a of rows.applied) {
  const head = readObject(hex(a.current_catalog_head_digest)); if (head.payload.contextGraphId !== cg) continue;
  const objects = [head], catalogRows = [];
  function walk(digest) {
    const o = readObject(digest); objects.push(o);
    if (o.payload.rows) catalogRows.push(...o.payload.rows);
    for (const e of o.payload.entries ?? []) walk(e.bucketDigest ?? e.childDigest ?? e.nodeDigest);
  }
  walk(head.payload.directoryRootDigest);
  catalogs.push({ head, rows: catalogRows, objects });
}
save('catalogs', catalogs);
const inventory = encodeInventory(rows), selection = verifyInventoryScope(campaign, inventory, catalogs, status);
// Preserve every raw scope and the refusal reason, even when no scope can be certified.
save('inventory', { ...inventory, selection: { ...selection, rows: undefined, catalogRows: undefined }, swm: selection.rows });
// sparql-scan-allow: R2 -- Offline full-evidence export of the isolated campaign namespace (436 eight-triple KAs plus one restart probe); only before/after timed traffic, never a daemon request.
const query = `SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "did:dkg:context-graph:${cg}/")) } ORDER BY ?g ?s ?p ?o`;
const r = await fetch(cfg.store.options.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' }, body: new URLSearchParams({ query }), signal: AbortSignal.timeout(120000) });
if (!r.ok) throw new Error('RDF snapshot failed: ' + r.status);
save('rdf', await r.json());
save('manifest', { arm, cg, label, observedAt: new Date().toISOString(), inventoryRows: selection.rows.length, catalogRows: selection.catalogRows.length });
console.log({ label, inventoryRows: selection.rows.length, catalogRows: selection.catalogRows.length });

if (!selection.valid) { console.error(selection.errors); process.exitCode = 1; }
