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
 *        - VM first  → publish (loose selection-publish, RETIRED #1087 → #1260)
 *        - SWM next  → promote via /api/knowledge-assets/:name/swm/share
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
const API_BASE = (args.api ?? process.env.DEVNET_API ?? 'http://localhost:9200').replace(/\/$/, '');
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
const cgId = await client.toCanonicalCgId(PROJECT_ID);

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
  const r = await client.query({ contextGraphId: cgId, sparql });
  return r?.result?.bindings ?? [];
}

// ── 1. Current totals per layer ─────────────────────────────────────────
async function countLayer(filterExpr) {
  const rows = await select(
    `SELECT (COUNT(*) AS ?n) WHERE {
       GRAPH ?g { ?s ?p ?o }
       FILTER(STRSTARTS(STR(?g), "did:dkg:context-graph:${cgId}") && ${filterExpr})
     }`,
  );
  return intOf(rows[0]?.n);
}
const wmNow  = await countLayer('CONTAINS(STR(?g), "/assertion/")');
const swmNow = await countLayer('STRENDS(STR(?g), "/_shared_memory")');
const vmNow  = await countLayer(
  '!CONTAINS(STR(?g), "/assertion/") && !CONTAINS(STR(?g), "_shared_memory") ' +
  '&& !CONTAINS(STR(?g), "_verifiable_memory") && !CONTAINS(STR(?g), "/_meta") ' +
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
          FILTER(STRSTARTS(STR(?g), "did:dkg:context-graph:${cgId}/${sg}/assertion/"))
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
      GRAPH <did:dkg:context-graph:${cgId}/${sg}/_shared_memory> {
        ?s ?p ?o . ?s a ?t .
      }
      FILTER NOT EXISTS {
        GRAPH <did:dkg:context-graph:${cgId}/${sg}> { ?s ?p2 ?o2 }
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
    contextGraphId: cgId,
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
// The retired loose selection-publish with `clearAfter: true` wiped the
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

// NEUTERED (#1087, pending #1260): the SWM→VM publish leg below is disabled
// (loose publish-by-selection was removed). The default mode promotes the
// VM-bound cohort into SWM expecting to drain it to VM — without that drain it
// would leave a mixed SWM partition (VM-bound + SWM-bound). So bail BEFORE any
// SWM mutation unless --skip-vm is set (promote-to-SWM-only, which is coherent).
if (!SKIP_VM) {
  console.error('\n[redist] SWM→VM publish leg is disabled pending the #1260 named-KA rework.');
  console.error('[redist] Without it, this default redistribution can only half-complete (VM-bound would sit in SWM).');
  console.error('[redist] Re-run with --skip-vm to only redistribute into SWM, or wait for #1260.');
  process.exit(1);
}

console.log('\n──── promote WM → SWM (VM-bound first) ────');
for (const sg of SUB_GRAPHS) {
  const vmPlan = vmBySg[sg] ?? [];
  if (vmPlan.length) await promoteBatches(sg, vmPlan, 'promote-vm');
}

// The default (VM) mode exits above, so we always reach here under --skip-vm:
// the VM-bound cohort has been promoted into SWM. The SWM→VM publish leg (loose
// publish-by-selection) was removed in #1087; the named-KA rework is tracked in
// #1260, so there is no on-chain publish or SWM-bound promote step here.
console.log('\n[redist] --skip-vm: VM-bound cohort redistributed into SWM. SWM→VM publish leg disabled pending #1260.');
process.exit(0);
