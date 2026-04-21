#!/usr/bin/env node
/**
 * Redistribute a context graph's data across WM/SWM/VM to hit target ratios.
 *
 * Usage:
 *   node scripts/redistribute-memory.mjs                       # 20/30/50 default
 *   node scripts/redistribute-memory.mjs --wm=20 --swm=30 --vm=50
 *   node scripts/redistribute-memory.mjs --project=dkg-code-project
 *   node scripts/redistribute-memory.mjs --skip-vm              # only promote to SWM
 *
 * Strategy
 * ────────
 * 1. Enumerate every root entity (rdf:typed subject) currently in the
 *    project's per-sub-graph WM `/assertion/…` graphs and count the WM
 *    triples whose subject is that entity.
 * 2. Read the current triple totals per layer (WM / SWM / VM) and compute
 *    how many additional triples each target layer needs.
 * 3. Pick entities to move up using a deterministic lexicographic sort
 *    (so reruns bucket identically) and a greedy fill:
 *        - VM first  → publish via /api/shared-memory/publish
 *        - SWM next  → promote via /api/assertion/:name/promote
 *        - remainder stays WM
 * 4. Batch promotes/publishes (default 40 entities per call) so we stay
 *    comfortably under the 512 KB gossip envelope.
 *
 * Idempotent: re-running with the same ratios is a no-op; changing the
 * ratios only moves the delta.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient, parseArgs, resolveToken } from './lib/dkg-daemon.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const args = parseArgs();
const API_BASE = (args.api ?? process.env.DEVNET_API ?? 'http://localhost:9201').replace(/\/$/, '');
const PROJECT_ID = args.project ?? 'dkg-code-project';
const SKIP_VM = args['skip-vm'] === 'true';
const BATCH = Number(args.batch ?? 40);
const RATIOS = {
  wm: Number(args.wm ?? 20),
  swm: Number(args.swm ?? 30),
  vm: Number(args.vm ?? 50),
};
const totalPct = RATIOS.wm + RATIOS.swm + RATIOS.vm;
if (Math.abs(totalPct - 100) > 0.5) {
  console.error(`[redist] --wm + --swm + --vm must sum to 100 (got ${totalPct})`);
  process.exit(1);
}

const SUB_GRAPHS = ['code', 'github', 'decisions', 'tasks'];
const ASSERTION_BY_SG = {
  code: 'code-structure',
  github: 'github-activity',
  decisions: 'decision-log',
  tasks: 'task-board',
};

const token = resolveToken(REPO_ROOT);
const client = makeClient({ apiBase: API_BASE, token });

function bv(v) {
  if (v == null) return undefined;
  const raw = typeof v === 'string' ? v : (v.value ?? '');
  return raw.startsWith('"') ? raw.replace(/^"|"$/g, '') : raw;
}
function intOf(v) {
  const raw = typeof v === 'string' ? v : (v.value ?? '');
  const m = raw.match(/"(\d+)"/);
  return m ? Number(m[1]) : Number(raw);
}
async function select(sparql) {
  const r = await client.query({ contextGraphId: PROJECT_ID, sparql });
  return r?.result?.bindings ?? [];
}

// ── 1. Current totals per layer ─────────────────────────────────────────
async function countLayer(filterExpr) {
  const rows = await select(
    `SELECT (COUNT(*) AS ?n) WHERE {
       GRAPH ?g { ?s ?p ?o }
       FILTER(STRSTARTS(STR(?g), "did:dkg:context-graph:${PROJECT_ID}") && ${filterExpr})
     }`,
  );
  return intOf(rows[0]?.n);
}
const wmNow  = await countLayer('CONTAINS(STR(?g), "/assertion/")');
const swmNow = await countLayer('STRENDS(STR(?g), "/_shared_memory")');
const vmNow  = await countLayer(
  '!CONTAINS(STR(?g), "/assertion/") && !CONTAINS(STR(?g), "_shared_memory") ' +
  '&& !CONTAINS(STR(?g), "_verified_memory") && !CONTAINS(STR(?g), "/_meta") ' +
  '&& !CONTAINS(STR(?g), "/_private") && !CONTAINS(STR(?g), "/_rules")',
);
const total = wmNow + swmNow + vmNow;
const target = {
  wm: Math.round(total * RATIOS.wm / 100),
  swm: Math.round(total * RATIOS.swm / 100),
  vm: Math.round(total * RATIOS.vm / 100),
};
const need = {
  vm: Math.max(0, target.vm - vmNow),
  swm: Math.max(0, target.swm - swmNow),
};
console.log(`[redist] now    : WM=${wmNow}  SWM=${swmNow}  VM=${vmNow}  (total=${total})`);
console.log(`[redist] target : WM=${target.wm}  SWM=${target.swm}  VM=${target.vm}  (ratios ${RATIOS.wm}/${RATIOS.swm}/${RATIOS.vm})`);
console.log(`[redist] need to move up: +${need.vm} to VM, +${need.swm} to SWM`);

if (need.vm === 0 && need.swm === 0) {
  console.log('[redist] already within target, nothing to do.');
  process.exit(0);
}

// ── 2. Enumerate WM root entities per sub-graph with triple weights ─────
async function enumerateSubGraph(sg) {
  // Subjects + how many WM triples they own (subject-match only; we
  // deliberately don't count inverse edges because promote only moves
  // triples by subject+skolemized-child). `SELECT DISTINCT` within the
  // GROUP BY keeps multi-type entities from double-counting.
  const rows = await select(`
    SELECT ?s (COUNT(?p) AS ?n) WHERE {
      {
        SELECT DISTINCT ?s ?p ?o ?g WHERE {
          GRAPH ?g { ?s ?p ?o . ?s a ?t }
          FILTER(STRSTARTS(STR(?g), "did:dkg:context-graph:${PROJECT_ID}/${sg}/assertion/"))
        }
      }
    }
    GROUP BY ?s
  `);
  return rows
    .map(r => ({ uri: bv(r.s), weight: intOf(r.n), sg }))
    .filter(x => x.uri && x.weight > 0);
}

// Entities already in SWM but not yet in VM — re-runs of the script can
// promote these to VM without having to re-promote from WM.
async function enumerateSwmOnly(sg) {
  const rows = await select(`
    SELECT ?s (COUNT(?p) AS ?n) WHERE {
      GRAPH <did:dkg:context-graph:${PROJECT_ID}/${sg}/_shared_memory> {
        ?s ?p ?o . ?s a ?t .
      }
      FILTER NOT EXISTS {
        GRAPH <did:dkg:context-graph:${PROJECT_ID}/${sg}> { ?s ?p2 ?o2 }
      }
    }
    GROUP BY ?s
  `);
  return rows
    .map(r => ({ uri: bv(r.s), weight: intOf(r.n), sg, fromSwm: true }))
    .filter(x => x.uri && x.weight > 0);
}

const buckets = { vm: [], swm: [] };
const sgTotals = {};
const swmOnly = {};
for (const sg of SUB_GRAPHS) {
  const ents = await enumerateSubGraph(sg);
  const sum = ents.reduce((a, e) => a + e.weight, 0);
  sgTotals[sg] = { entities: ents, sum };
  const swmEnts = await enumerateSwmOnly(sg);
  swmOnly[sg] = swmEnts;
  const swmSum = swmEnts.reduce((a, e) => a + e.weight, 0);
  console.log(`[${sg}] WM: ${ents.length} roots / ${sum} triples · SWM-only: ${swmEnts.length} roots / ${swmSum} triples`);
}

// VM bucket is filled from two sources in priority order:
//   1. entities already in SWM that haven't been published (cheapest — no
//      promote round-trip needed, just publish).
//   2. entities still in WM (require a promote + publish).
// We sort each pool heaviest-first so we reach the target with the
// fewest possible on-chain calls.
const swmPool = Object.values(swmOnly).flat()
  .sort((a, b) => (b.weight - a.weight) || a.uri.localeCompare(b.uri));
const wmPool = Object.values(sgTotals).flatMap(x => x.entities)
  .sort((a, b) => (b.weight - a.weight) || a.uri.localeCompare(b.uri));

let vmAcc = 0;
let swmAcc = 0;
const vmFromSwm = [];
for (const e of swmPool) {
  if (vmAcc >= need.vm) break;
  vmFromSwm.push(e);
  vmAcc += e.weight;
}
for (const e of wmPool) {
  if (vmAcc < need.vm) {
    buckets.vm.push(e);
    vmAcc += e.weight;
  } else if (swmAcc < need.swm) {
    buckets.swm.push(e);
    swmAcc += e.weight;
  }
}
console.log(`[redist] planned: VM ${buckets.vm.length + vmFromSwm.length} ents (~${vmAcc}t, ${vmFromSwm.length} from SWM-only pool) · SWM ${buckets.swm.length} ents (~${swmAcc}t)`);

// Group plans by sub-graph for per-assertion promote/publish calls.
function group(list) {
  const by = {};
  for (const e of list) (by[e.sg] ??= []).push(e);
  return by;
}
const vmBySg = group(buckets.vm);
const swmBySg = group(buckets.swm);
const vmFromSwmBySg = group(vmFromSwm);

// ── 3. Promote everything (VM + SWM) into SWM first; VM-bound entities
//       also get published on-chain in the next step.
async function promoteOnce(sg, entities) {
  const r = await client.promote({
    contextGraphId: PROJECT_ID,
    assertionName: ASSERTION_BY_SG[sg],
    entities: entities.map(e => e.uri),
    subGraphName: sg,
  });
  return r?.promotedCount ?? 0;
}

// Promote a slice; on the 512 KB gossip error, bisect and retry so no
// entity gets stranded in WM just because its batch happened to straddle
// the size limit.
async function promoteAdaptive(sg, slice, label) {
  if (slice.length === 0) return 0;
  try {
    const n = await promoteOnce(sg, slice);
    console.log(`  · ${sg}/${label}: +${n} triples (${slice.length} ents)`);
    return n;
  } catch (err) {
    const msg = err.message ?? '';
    const tooLarge = msg.includes('too large for gossip') || msg.includes('Promote fewer entities');
    if (!tooLarge || slice.length === 1) {
      console.warn(`  ! ${sg}/${label} (${slice.length} ents) failed: ${msg.split('\n')[0]}`);
      return 0;
    }
    const mid = Math.ceil(slice.length / 2);
    const left = slice.slice(0, mid);
    const right = slice.slice(mid);
    const a = await promoteAdaptive(sg, left, `${label}a`);
    const b = await promoteAdaptive(sg, right, `${label}b`);
    return a + b;
  }
}

async function promoteBatches(sg, ents, tag) {
  if (ents.length === 0) return 0;
  let moved = 0;
  const totalBatches = Math.ceil(ents.length / BATCH);
  for (let i = 0; i < ents.length; i += BATCH) {
    const slice = ents.slice(i, i + BATCH);
    const batchN = Math.floor(i / BATCH) + 1;
    moved += await promoteAdaptive(sg, slice, `${tag} ${batchN}/${totalBatches}`);
  }
  return moved;
}

// IMPORTANT ordering for disjoint layers:
//
// `POST /api/shared-memory/publish` with `clearAfter: true` wipes the
// ENTIRE SWM partition for the sub-graph, not just the selected entities
// (see `publishFromSharedMemory` in packages/publisher/src/dkg-publisher.ts).
// That means we cannot interleave publishes with other things in SWM —
// any SWM-bound entity present at the moment of the clear is lost.
//
// So the run order per sub-graph is:
//   1. promote VM-bound entities to SWM
//   2. publish them in batches; `clearAfter: false` for all but the LAST
//      batch, which uses `clearAfter: true` to drain SWM.
//   3. promote SWM-bound entities to SWM (after the drain, so nothing
//      else is mixed in).
//
// Net result: VM holds VM-bound, SWM holds only SWM-bound, WM holds the
// rest — a clean WM/SWM/VM partition.

console.log('\n──── promote WM → SWM (VM-bound first) ────');
for (const sg of SUB_GRAPHS) {
  const vmPlan = vmBySg[sg] ?? [];
  if (vmPlan.length) await promoteBatches(sg, vmPlan, 'promote-vm');
}

if (SKIP_VM) {
  console.log('\n[redist] --skip-vm set; skipping publish + SWM promote.');
  process.exit(0);
}

// ── 4. Publish VM-bound entities on-chain. We issue per-sub-graph
//       batches of 40; each call triggers an anchor TX on the local
//       devnet chain, which is ~1–2 s per batch. `clearAfter` is only
//       true on the LAST batch of each sub-graph (see note above).
async function publishBatches(sg, ents) {
  if (ents.length === 0) return;
  const totalBatches = Math.ceil(ents.length / BATCH);
  for (let i = 0; i < ents.length; i += BATCH) {
    const slice = ents.slice(i, i + BATCH).map(e => e.uri);
    const batchN = Math.floor(i / BATCH) + 1;
    const isLast = batchN === totalBatches;
    try {
      const r = await client.request('POST', '/api/shared-memory/publish', {
        contextGraphId: PROJECT_ID,
        subGraphName: sg,
        selection: slice,
        clearAfter: isLast,
      });
      const drain = isLast ? ' [drain SWM]' : '';
      console.log(`  · ${sg} publish ${batchN}/${totalBatches}: kcId=${r?.kcId} tx=${r?.txHash?.slice(0, 10) ?? '—'}${drain}`);
    } catch (err) {
      console.warn(`  ! ${sg} publish ${batchN}/${totalBatches} failed: ${err.message.split('\n')[0]}`);
    }
  }
}

console.log('\n──── publish SWM → VM ────');
// Best-effort on-chain registration before publish (409 = already done).
try {
  await client.request('POST', '/api/context-graph/register', {
    id: PROJECT_ID,
    revealOnChain: true,
    accessPolicy: 0,
  });
  console.log('  + on-chain registration OK');
} catch (err) {
  if (err.status === 409) console.log('  · project already registered on-chain');
  else console.warn(`  ! register failed: ${err.message.split('\n')[0]}`);
}

for (const sg of SUB_GRAPHS) {
  // Publish anything targeted at VM — both freshly-promoted and already-
  // promoted SWM stragglers. The daemon is idempotent for repeat calls
  // since the publish flow just copies SWM quads into the VM graph.
  const ents = [...(vmBySg[sg] ?? []), ...(vmFromSwmBySg[sg] ?? [])];
  if (ents.length === 0) continue;
  console.log(`[${sg}] publishing ${ents.length} entities…`);
  await publishBatches(sg, ents);
}

console.log('\n──── promote WM → SWM (SWM-bound) ────');
// SWM is empty (drained by the last publish per sub-graph), so the
// remaining promotes land cleanly into SWM without mixing with VM-bound
// entities.
for (const sg of SUB_GRAPHS) {
  const swmPlan = swmBySg[sg] ?? [];
  if (swmPlan.length) await promoteBatches(sg, swmPlan, 'promote-swm');
}

// ── 5. Verify final distribution.
const wmAfter  = await countLayer('CONTAINS(STR(?g), "/assertion/")');
const swmAfter = await countLayer('STRENDS(STR(?g), "/_shared_memory")');
const vmAfter  = await countLayer(
  '!CONTAINS(STR(?g), "/assertion/") && !CONTAINS(STR(?g), "_shared_memory") ' +
  '&& !CONTAINS(STR(?g), "_verified_memory") && !CONTAINS(STR(?g), "/_meta") ' +
  '&& !CONTAINS(STR(?g), "/_private") && !CONTAINS(STR(?g), "/_rules")',
);
const totAfter = wmAfter + swmAfter + vmAfter;
const pct = (n) => totAfter ? ((n * 100) / totAfter).toFixed(1) + '%' : '—';
console.log('\n──── final distribution ────');
console.log(`[redist] WM  ${wmAfter}  (${pct(wmAfter)})`);
console.log(`[redist] SWM ${swmAfter} (${pct(swmAfter)})`);
console.log(`[redist] VM  ${vmAfter}  (${pct(vmAfter)})`);
console.log(`[redist] total ${totAfter}`);
