import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadApiClientToken } from '../../packages/cli/dist/auth.js';
import { DkgHomeFiles } from '../../packages/cli/dist/config.js';
const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url));
const Database = require('better-sqlite3');
const arm = process.argv[2] ?? 'baseline', label = process.argv[3] ?? 'snapshot';
const home = process.env.DKG_HOME, cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json')));
const cg = `0x247b02c301b34e52e9021728f34c3457f81f2dfc/2963-${arm}-20261016`;
const dir = path.resolve('.tmp/2963/evidence', arm, label); fs.mkdirSync(dir, { recursive: true });
const save = (name, value) => fs.writeFileSync(path.join(dir, name + '.json'), JSON.stringify(value, null, 2));
const token = await loadApiClientToken(new DkgHomeFiles(home));
for (const route of ['/api/status', '/api/publisher/jobs?limit=1000', '/api/knowledge-assets/swm/share-jobs']) {
  const r = await fetch(`http://127.0.0.1:${cfg.apiPort}${route}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
  save(route.split('?')[0].replaceAll('/', '-'), { status: r.status, value: await r.json() });
}
const db = new Database(path.join(home, 'rfc64-sync/inventory-v1.sqlite3'), { readonly: true });
const hex = b => b.toString('hex');
const rows = db.transaction(() => {
  const heads = db.prepare('SELECT * FROM rfc64_swm_author_inventory_heads_v1').all();
  const h = heads.find(x => JSON.parse(x.signed_head_envelope.toString()).payload.contextGraphId === cg);
  const swm = h ? db.prepare('SELECT * FROM rfc64_swm_author_inventory_rows_v1 WHERE inventory_scope_digest=? AND author_address=? ORDER BY assertion_coordinate').all(h.inventory_scope_digest, h.author_address) : [];
  const applied = db.prepare('SELECT * FROM rfc64_applied_catalog_heads_v1').all();
  return { head: h, swm, applied };
})();
const encode = x => JSON.parse(JSON.stringify(x, (_key, v) => v?.type === 'Buffer' ? '0x' + Buffer.from(v.data).toString('hex') : v));
save('inventory', encode(rows));
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
save('catalogs', catalogs); db.close();
// sparql-scan-allow: R2 -- Offline full-evidence export of the isolated campaign namespace (436 eight-triple KAs plus one restart probe); only before/after timed traffic, never a daemon request.
const query = `SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "did:dkg:context-graph:${cg}/")) } ORDER BY ?g ?s ?p ?o`;
const r = await fetch(cfg.store.options.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' }, body: new URLSearchParams({ query }), signal: AbortSignal.timeout(120000) });
if (!r.ok) throw new Error('RDF snapshot failed: ' + r.status);
save('rdf', await r.json());
save('manifest', { arm, cg, label, observedAt: new Date().toISOString(), inventoryRows: rows.swm.length, catalogRows: catalogs.reduce((n, c) => n + c.rows.length, 0) });
console.log({ label, inventoryRows: rows.swm.length, catalogRows: catalogs.reduce((n, c) => n + c.rows.length, 0) });
