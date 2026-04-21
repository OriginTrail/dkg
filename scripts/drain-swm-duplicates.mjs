#!/usr/bin/env node
/**
 * Move triples that are in BOTH SWM and VM out of SWM, so the UI's layer
 * counts are disjoint (WM / SWM-only / VM). Re-publishes each already-
 * verified entity with `clearAfter: true`, which tells the daemon to
 * evict the source quads from `_shared_memory` once they're anchored.
 *
 * Safe to re-run; a no-op for SWM-only or WM-only entities.
 *
 * Usage:
 *   node scripts/drain-swm-duplicates.mjs --project=dkg-code-project
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient, parseArgs, resolveToken } from './lib/dkg-daemon.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const args = parseArgs();
const API_BASE = (args.api ?? process.env.DEVNET_API ?? 'http://localhost:9201').replace(/\/$/, '');
const PROJECT_ID = args.project ?? 'dkg-code-project';
const BATCH = Number(args.batch ?? 40);
const SUB_GRAPHS = ['code', 'github', 'decisions', 'tasks'];

const token = resolveToken(REPO_ROOT);
const client = makeClient({ apiBase: API_BASE, token });

function bv(v) {
  if (v == null) return undefined;
  const raw = typeof v === 'string' ? v : (v.value ?? '');
  return raw.startsWith('"') ? raw.replace(/^"|"$/g, '') : raw;
}
async function select(sparql) {
  const r = await client.query({ contextGraphId: PROJECT_ID, sparql });
  return r?.result?.bindings ?? [];
}

// Entities whose subject appears in BOTH the per-sub-graph SWM partition
// AND the VM data graph. These are duplicates created by prior publish
// calls that used `clearAfter: false`.
async function enumerateDuplicates(sg) {
  const rows = await select(`
    SELECT DISTINCT ?s WHERE {
      GRAPH <did:dkg:context-graph:${PROJECT_ID}/${sg}/_shared_memory> { ?s ?p1 ?o1 }
      GRAPH <did:dkg:context-graph:${PROJECT_ID}/${sg}>                 { ?s ?p2 ?o2 }
    }
  `);
  return rows.map(r => bv(r.s)).filter(Boolean);
}

for (const sg of SUB_GRAPHS) {
  const dupes = await enumerateDuplicates(sg);
  if (dupes.length === 0) {
    console.log(`[${sg}] no SWM/VM duplicates`);
    continue;
  }
  console.log(`[${sg}] draining ${dupes.length} duplicated entities from SWM…`);
  const totalBatches = Math.ceil(dupes.length / BATCH);
  for (let i = 0; i < dupes.length; i += BATCH) {
    const slice = dupes.slice(i, i + BATCH);
    const batchN = Math.floor(i / BATCH) + 1;
    try {
      const r = await client.request('POST', '/api/shared-memory/publish', {
        contextGraphId: PROJECT_ID,
        subGraphName: sg,
        selection: slice,
        clearAfter: true,
      });
      console.log(`  · ${sg} drain ${batchN}/${totalBatches}: kcId=${r?.kcId}`);
    } catch (err) {
      console.warn(`  ! ${sg} drain ${batchN}/${totalBatches} failed: ${err.message.split('\n')[0]}`);
    }
  }
}

async function countLayer(filterExpr) {
  const rows = await select(
    `SELECT (COUNT(*) AS ?n) WHERE {
       GRAPH ?g { ?s ?p ?o }
       FILTER(STRSTARTS(STR(?g), "did:dkg:context-graph:${PROJECT_ID}") && ${filterExpr})
     }`,
  );
  const raw = typeof rows[0]?.n === 'string' ? rows[0].n : (rows[0]?.n?.value ?? '0');
  const m = raw.match(/"(\d+)"/);
  return m ? Number(m[1]) : Number(raw);
}
const wm = await countLayer('CONTAINS(STR(?g), "/assertion/")');
const swm = await countLayer('STRENDS(STR(?g), "/_shared_memory")');
const vm = await countLayer(
  '!CONTAINS(STR(?g), "/assertion/") && !CONTAINS(STR(?g), "_shared_memory") ' +
  '&& !CONTAINS(STR(?g), "_verified_memory") && !CONTAINS(STR(?g), "/_meta") ' +
  '&& !CONTAINS(STR(?g), "/_private") && !CONTAINS(STR(?g), "/_rules")',
);
const tot = wm + swm + vm;
const pct = (n) => tot ? ((n * 100) / tot).toFixed(1) + '%' : '—';
console.log('\n──── final distribution ────');
console.log(`  WM  ${wm}  (${pct(wm)})`);
console.log(`  SWM ${swm} (${pct(swm)})`);
console.log(`  VM  ${vm}  (${pct(vm)})`);
console.log(`  total ${tot}`);
