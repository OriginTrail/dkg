#!/usr/bin/env node
/**
 * Orchestrate the full dkg-code-project seed.
 *
 * Steps:
 *   1. Create context graph `dkg-code-project` with sub-graphs
 *        meta / code / github / decisions / tasks
 *   2. Run each importer in order, writing into its sub-graph.
 *   3. Promote a curated subset of each data sub-graph from WM -> SWM.
 *   4. (Best-effort) publish the SWM subset up to VM so the Verified
 *      layer is non-empty on devnet. If the chain isn't configured,
 *      warn and continue.
 *
 * Usage:
 *   node scripts/seed-dkg-code-project.mjs
 *   node scripts/seed-dkg-code-project.mjs --skip-vm
 *   node scripts/seed-dkg-code-project.mjs --only=profile,code
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient, parseArgs, resolveToken } from './lib/dkg-daemon.mjs';
import { Code, Decisions, Tasks, Github } from './lib/ontology.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const args = parseArgs();
const API_BASE = (args.api ?? process.env.DEVNET_API ?? 'http://localhost:9201').replace(/\/$/, '');
const PROJECT_ID = args.project ?? 'dkg-code-project';
const PROJECT_NAME = args.name ?? 'DKG Code memory';
const PROJECT_DESC =
  args.desc ??
  'Shared context graph for the dkg-v9 monorepo itself — code, github, decisions, tasks + profile.';
const SKIP_VM = args['skip-vm'] === 'true';
const SKIP_IMPORTS = args['skip-imports'] === 'true';
const SKIP_CHAIN = args['skip-chain'] === 'true';
const ONLY = args.only ? String(args.only).split(',') : null;

function shouldRun(step) {
  return !ONLY || ONLY.includes(step);
}

function runScript(file, extraArgs = []) {
  console.log(`\n──── ${file} ${extraArgs.join(' ')} ────`);
  const r = spawnSync('node', [path.join(__dirname, file), ...extraArgs], {
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
  if (r.status !== 0) {
    throw new Error(`${file} exited with code ${r.status}`);
  }
}

const token = resolveToken(REPO_ROOT);
const client = makeClient({ apiBase: API_BASE, token });

// 1. Project + all sub-graphs (idempotent)
console.log(`[seed] Ensuring project ${PROJECT_ID}…`);
await client.ensureProject({ id: PROJECT_ID, name: PROJECT_NAME, description: PROJECT_DESC });
for (const sg of ['meta', 'code', 'github', 'decisions', 'tasks']) {
  await client.ensureSubGraph(PROJECT_ID, sg);
}

const pass = [`--project=${PROJECT_ID}`, `--api=${API_BASE}`];

// 2. Imports (skip with --skip-imports once WM is already populated)
if (!SKIP_IMPORTS) {
  if (shouldRun('profile')) runScript('import-profile.mjs', pass);
  if (shouldRun('code')) runScript('import-code-graph.mjs', pass);
  if (shouldRun('github')) runScript('import-github.mjs', pass);
  if (shouldRun('decisions')) runScript('import-decisions.mjs', pass);
  if (shouldRun('tasks')) runScript('import-tasks.mjs', pass);
} else {
  console.log('[seed] --skip-imports set; assuming WM is already populated.');
}

if (SKIP_VM) {
  console.log('\n[seed] --skip-vm set; done after imports.');
  process.exit(0);
}

// ──────────────────────────────────────────────────────────────────────────
// 3. WM -> SWM: promote curated subsets of each sub-graph.
//
//    Strategy (aligned with how a real project would move knowledge up):
//      • decisions / tasks: small sub-graphs — promote ALL so SWM shows
//        the whole team-agreed board. VM will filter this down.
//      • code: promote every package entity (~17 roots). Packages are
//        the stable long-lived anchors in the code graph; individual
//        files/functions churn every commit and belong in WM only.
//        Root-entity promotion carries only triples whose subject is
//        the root URI, so package-level metadata (package name, path,
//        file counts) moves up; the AST interior stays private.
//      • github: promote the 20 newest closed PRs (the ones most likely
//        to have been reviewed). Open PRs stay WM — they're still in
//        flight.
//
//    The 512 KB gossip cap in publisher.assertionPromote means we keep
//    each call per-assertion and filtered by root-entity URI.
// ──────────────────────────────────────────────────────────────────────────
console.log('\n──── VM seed: WM -> SWM (promote) ────');

// SPARQL binding values come back either as raw IRIs ("urn:…") or as
// JSON-encoded literals ('"closed"' / '"42"^^<xsd:integer>'). For URIs
// we want the bare string, so we strip surrounding quotes if present.
function bareIri(v) {
  if (v == null) return undefined;
  if (typeof v !== 'string') return String(v);
  return v.startsWith('"') ? v.replace(/^"|"$/g, '') : v;
}

async function selectBindings(sparql) {
  const r = await client.query({ contextGraphId: PROJECT_ID, sparql });
  return r?.result?.bindings ?? [];
}

const githubPromotions = await (async () => {
  try {
    // Order PRs by `mergedAt` (falls back to `closedAt`) so we actually
    // get the 20 most recently closed, not a lexicographic slice —
    // `ORDER BY DESC(?pr)` on the URI sorts `.../99` after `.../100`
    // once PR numbers have different digit lengths.
    const rows = await selectBindings(`
      SELECT ?pr ?when WHERE {
        GRAPH ?g {
          ?pr a <http://dkg.io/ontology/github/PullRequest> ;
              <http://dkg.io/ontology/github/state> "closed" .
          OPTIONAL { ?pr <http://dkg.io/ontology/github/mergedAt> ?mergedAt }
          OPTIONAL { ?pr <http://dkg.io/ontology/github/closedAt> ?closedAt }
          BIND(COALESCE(?mergedAt, ?closedAt) AS ?when)
        }
        FILTER(strstarts(str(?g), "did:dkg:context-graph:${PROJECT_ID}/github/"))
      } ORDER BY DESC(?when) LIMIT 20
    `);
    return rows.map((r) => bareIri(r.pr)).filter(Boolean);
  } catch (err) {
    console.warn(`[seed]   ! could not enumerate github PRs: ${err.message.split('\n')[0]}`);
    return [];
  }
})();

const codePromotions = await (async () => {
  try {
    const rows = await selectBindings(`
      SELECT ?pkg WHERE {
        GRAPH ?g { ?pkg a <http://dkg.io/ontology/code/Package> }
        FILTER(strstarts(str(?g), "did:dkg:context-graph:${PROJECT_ID}/code/"))
      }
    `);
    return rows.map((r) => bareIri(r.pkg)).filter(Boolean);
  } catch (err) {
    console.warn(`[seed]   ! could not enumerate code packages: ${err.message.split('\n')[0]}`);
    return [];
  }
})();

async function promote(assertionName, subGraphName, entities, label) {
  try {
    const r = await client.promote({
      contextGraphId: PROJECT_ID,
      assertionName,
      entities,
      subGraphName,
    });
    console.log(`[seed]   + promoted ${label}: ${JSON.stringify(r).slice(0, 200)}`);
    return r;
  } catch (err) {
    console.warn(`[seed]   ! promote ${label} failed: ${err.message.split('\n')[0]}`);
    return { promotedCount: 0 };
  }
}

await promote('decision-log',    'decisions', 'all', `decisions (all drafts)`);
await promote('task-board',      'tasks',     'all', `tasks (all items)`);
await promote('code-structure',  'code',      codePromotions,   `code packages (${codePromotions.length})`);
await promote('github-activity', 'github',    githubPromotions, `github closed PRs (${githubPromotions.length})`);

// ──────────────────────────────────────────────────────────────────────────
// 4. SWM -> VM: publish a small curated "canonical" subset on-chain.
//
//    VM is deliberately the most expensive and selective layer: only the
//    anchors we'd really pay to sign and anchor. Pick the accepted
//    decisions + completed tasks + 2 flagship packages + top 5 merged
//    PRs — roughly 20 root entities.
// ──────────────────────────────────────────────────────────────────────────
if (SKIP_CHAIN) {
  console.log('\n[seed] --skip-chain set; SWM populated, VM left empty.');
  process.exit(0);
}

console.log('\n──── VM seed: SWM -> VM (publish, best-effort) ────');

// The VM selection is a curated subset of what we promoted to SWM.
// These are the "things we'd pay gas to anchor": accepted decisions,
// completed tasks, the two demo-flagship packages, and the 5 most-recent
// merged PRs. Fewer roots = smaller on-chain payload + snappier demo.
const vmDecisions = [
  Decisions.uri.decision('unified-layer-content'),
  Decisions.uri.decision('project-profile-in-meta-subgraph'),
  Decisions.uri.decision('verified-memory-hero-view'),
  Decisions.uri.decision('ast-code-ontology'),
  Decisions.uri.decision('subgraphs-as-first-class'),
];
const vmTasks = [
  Tasks.uri.task('subgraph-list-endpoint'),
  Tasks.uri.task('genui-endpoint-daemon'),
  Tasks.uri.task('useprojectprofile-hook'),
  Tasks.uri.task('vm-hero-panel'),
  Tasks.uri.task('subgraph-bar-ui'),
];
const vmCode = [
  Code.uri.package('@origintrail-official/dkg-node-ui'),
  Code.uri.package('@origintrail-official/dkg-graph-viz'),
];
const vmGithub = githubPromotions.slice(0, 5);

// Register the project on-chain (idempotent — 409 = already registered).
try {
  const reg = await client.request('POST', '/api/context-graph/register', {
    id: PROJECT_ID,
    revealOnChain: true,
    accessPolicy: 0,
  });
  console.log(`[seed]   + on-chain registration: ${JSON.stringify(reg).slice(0, 200)}`);
} catch (err) {
  if (err.status === 409) {
    console.log('[seed]   · project already registered on-chain');
  } else {
    console.warn(`[seed]   ! on-chain register failed: ${err.message.split('\n')[0]}`);
  }
}

// Publish is per-sub-graph because the promote step wrote each selection
// into the sub-graph's own SWM partition (`.../<sg>/_shared_memory`).
// `/api/shared-memory/publish` without `subGraphName` only reads the
// project's default SWM which is intentionally empty here. So we loop.
async function publishSubGraph(subGraphName, selection, label) {
  if (selection.length === 0) {
    console.log(`[seed]   · ${label}: empty selection, skipping`);
    return;
  }
  try {
    const r = await client.request('POST', '/api/shared-memory/publish', {
      contextGraphId: PROJECT_ID,
      subGraphName,
      selection,
      // Published entities are always removed from SWM after a confirmed
      // chain tx (disjoint layers), so the pyramid visual already reads
      // as intended. We intentionally do NOT set `clearAfter: true` —
      // that option wipes the *entire* SWM partition for this sub-graph,
      // including the larger set step 3 just promoted. With step 3
      // promoting `all` decisions/tasks/packages/PRs and step 4 publishing
      // only a curated VM subset, `clearAfter: true` leaves the SWM-only
      // band empty and destroys the seeded shared layer.
      clearAfter: false,
    });
    console.log(
      `[seed]   + ${label}: published ${selection.length} entities ` +
      JSON.stringify({
        kcId: r.kcId,
        status: r.status,
        txHash: r.txHash,
        blockNumber: r.blockNumber,
        kas: r.kas?.length,
      }),
    );
  } catch (err) {
    console.warn(`[seed]   ! ${label} publish failed: ${err.message.split('\n')[0]}`);
  }
}

await publishSubGraph('decisions', vmDecisions, 'decisions');
await publishSubGraph('tasks',     vmTasks,     'tasks');
await publishSubGraph('code',      vmCode,      'code');
await publishSubGraph('github',    vmGithub,    'github');

console.log('\n[seed] Done.');
