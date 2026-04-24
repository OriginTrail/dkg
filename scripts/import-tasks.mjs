#!/usr/bin/env node
/**
 * Write ~30 mock tasks for the dkg-code-project, cross-linked to decisions,
 * PRs, and code files. Covers a realistic mix of statuses (todo / in_progress /
 * blocked / done / cancelled), priorities (p0–p3), dependencies, assignees
 * (humans + a demo agent DID), dueDates, and `relatedIssue` links so the
 * tasks sub-graph exercises every Tasks.* predicate in the ontology.
 *
 * Usage:
 *   node scripts/import-tasks.mjs
 *   node scripts/import-tasks.mjs --dry-run --out=/tmp/tasks.nt
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeClient, parseArgs, resolveToken } from './lib/dkg-daemon.mjs';
import {
  Tasks,
  Decisions,
  Code,
  Github,
  Agent,
  Common,
  XSD,
  createTripleSink,
  uri,
  lit,
} from './lib/ontology.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const args = parseArgs();
const API_BASE = (args.api ?? process.env.DEVNET_API ?? 'http://localhost:9201').replace(/\/$/, '');
const PROJECT_ID = args.project ?? 'dkg-code-project';
const SUBGRAPH = args.subgraph ?? 'tasks';
const ASSERTION_NAME = args.assertion ?? 'task-board';
const REPO = args.repo ?? 'OriginTrail/dkg-v9';
const [OWNER, REPO_NAME] = REPO.split('/');
const DRY_RUN = args['dry-run'] === 'true';
const OUT_FILE = args.out ?? null;

const agentPkg = '@origintrail-official/dkg-agent';
const daemonPkg = '@origintrail-official/dkg-cli';
const nodeUiPkg = '@origintrail-official/dkg-node-ui';
const graphVizPkg = '@origintrail-official/dkg-graph-viz';

const file = (pkgName, rel) => Code.uri.file(pkgName, rel);
const pkg = (name) => Code.uri.package(name);
const prU = (n) => Github.uri.pr(OWNER, REPO_NAME, n);
const issueU = (n) => Github.uri.issue(OWNER, REPO_NAME, n);
const userU = (login) => Github.uri.user(login);
const agentU = (slug) => Agent.uri.agent(slug);
const decU = (slug) => Decisions.uri.decision(slug);

// Synthesize a plausible `dcterms:created` per task. Real creation time
// will come from the live agent-write path later; for the seed we spread
// the tasks across the past few weeks deterministically so the activity
// feed reads as a believable sequence of work.
const SEED_CREATED_AT_BASE = Date.parse('2026-04-04T09:00:00Z');
function seedCreatedFor(slug) {
  // Tiny hash of the slug → 0..N hours offset, spread over ~14 days.
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0;
  const hoursOffset = Math.abs(h) % (14 * 24);
  return new Date(SEED_CREATED_AT_BASE + hoursOffset * 60 * 60 * 1000).toISOString();
}

// Task attribution. Mix it so the curation view shows real variety —
// AI-authored tickets, human-filed ops work, plus a couple from the
// teammate's agents so you see "N from bojan's team" in the feed.
const TASK_AUTHOR = {
  // Current in-flight UI work — claude-code-branarakic's lane:
  'subgraph-bar-ui':                   'claude-code-branarakic',
  'genui-endpoint-daemon':             'claude-code-branarakic',
  'useprojectprofile-hook':            'claude-code-branarakic',
  'register-openui-components':        'claude-code-branarakic',
  'vm-hero-panel':                     'claude-code-branarakic',
  'vm-graph-styling':                  'claude-code-branarakic',
  'subgraph-list-endpoint':            'claude-code-branarakic',
  'book-research-stub':                'claude-code-branarakic',
  'relations-tab':                     'claude-code-branarakic',
  'predicate-filter-chips':            'claude-code-branarakic',
  'graph-viz-font-tuning':             'claude-code-branarakic',
  'label-truncation-smarter':          'claude-code-branarakic',
  'genui-fallback-unbound-types':      'claude-code-branarakic',
  'genui-streaming-progress':          'claude-code-branarakic',
  'sparql-cross-subgraph-queries':     'claude-code-branarakic',
  'profile-ontology-publish':          'claude-code-branarakic',
  // Longer-term R&D:
  'ast-multi-lang':                    'openclaw-branarakic',
  'sessions-subgraph':                 'openclaw-branarakic',
  'shacl-on-vm-promotion':             'openclaw-branarakic',
  'agent-coordinated-writes':          'openclaw-branarakic',
  'agent-proposes-decision-live':      'openclaw-branarakic',
  // Ops / CI / test — bojan's crew:
  'ci-shard-and-parallelize':          'bojan',
  'demock-ui-oracle-tests':            'bojan',
  'evm-randomsampling-draws':          'bojan',
  'publisher-epoch-snapshot-fast':     'bojan',
  // Integration / cross-package — claude-code-bojan:
  'wake-transport-reconciliation-v2':  'claude-code-bojan',
  'shacl-runtime-integration':         'claude-code-bojan',
  'chat-assertion-owner-align':        'claude-code-bojan',
  'openclaw-cross-channel-accountid':  'claude-code-bojan',
  'chain-analysis-dashboard':          'claude-code-bojan',
  // Hermes explores unconventional directions — this one got cancelled:
  'migrate-cg-format-v1':              'hermes-bojan',
  // Housekeeping:
  'retire-dkg-code-project':           'branarakic',
};

const TASKS = [
  { slug: 'subgraph-bar-ui', title: 'Build SubGraphBar above MemoryStrip',
    status: 'in_progress', priority: 'p1', estimate: 4, assignee: 'branarakic',
    relatedDecision: ['subgraphs-as-first-class'],
    touches: [file(nodeUiPkg, 'src/ui/views/ProjectView.tsx')] },
  { slug: 'genui-endpoint-daemon', title: 'Add POST /api/genui/render with LlmClient streaming',
    status: 'in_progress', priority: 'p1', estimate: 6, assignee: 'branarakic',
    relatedDecision: ['live-genui-over-static-templates'],
    touches: [file(daemonPkg, 'src/daemon.ts')] },
  { slug: 'useprojectprofile-hook', title: 'Ship useProjectProfile(contextGraphId) hook',
    status: 'todo', priority: 'p1', estimate: 3, assignee: 'branarakic',
    relatedDecision: ['project-profile-in-meta-subgraph'],
    dependsOn: ['genui-endpoint-daemon'],
    touches: [pkg(nodeUiPkg)] },
  { slug: 'register-openui-components', title: 'Register the PoC GenUI component library',
    status: 'todo', priority: 'p1', estimate: 5, assignee: 'branarakic',
    relatedDecision: ['live-genui-over-static-templates'],
    dependsOn: ['genui-endpoint-daemon'],
    touches: [pkg(nodeUiPkg)] },
  { slug: 'vm-hero-panel', title: 'Build VerifiedProvenancePanel for VM layer',
    status: 'todo', priority: 'p0', estimate: 5, assignee: 'branarakic',
    relatedDecision: ['verified-memory-hero-view'],
    dependsOn: ['register-openui-components'],
    touches: [file(nodeUiPkg, 'src/ui/views/ProjectView.tsx'), pkg(graphVizPkg)] },
  { slug: 'vm-graph-styling', title: 'Graph-viz: signature edges, agent nodes, VM halos',
    status: 'todo', priority: 'p1', estimate: 4, assignee: 'branarakic',
    relatedDecision: ['verified-memory-hero-view', 'vibrant-graph-predicates'],
    dependsOn: ['vm-hero-panel'],
    touches: [pkg(graphVizPkg)] },
  { slug: 'subgraph-list-endpoint', title: 'GET /api/sub-graph/list with per-sub-graph counts',
    status: 'done', priority: 'p1', estimate: 2, assignee: 'branarakic',
    relatedDecision: ['subgraphs-as-first-class'],
    touches: [file(daemonPkg, 'src/daemon.ts')] },
  { slug: 'book-research-stub', title: 'Prove UI portability with a book-research profile + data',
    status: 'todo', priority: 'p2', estimate: 4, assignee: 'branarakic',
    relatedDecision: ['project-profile-in-meta-subgraph'],
    dependsOn: ['useprojectprofile-hook'] },
  { slug: 'ast-multi-lang', title: 'Extend AST parser to Solidity / Python / Rust',
    status: 'blocked', priority: 'p2', estimate: 12, assignee: 'branarakic',
    relatedDecision: ['ast-code-ontology'],
    dependsOn: ['register-openui-components'] },
  { slug: 'sessions-subgraph', title: 'Import git-log sessions (coalesced per author) into `sessions`',
    status: 'todo', priority: 'p2', estimate: 3, assignee: 'branarakic',
    relatedDecision: ['subgraphs-as-first-class'],
    dependsOn: ['subgraph-list-endpoint'] },
  { slug: 'agent-coordinated-writes', title: 'Let OpenClaw publish new decisions/tasks into DKG live',
    status: 'todo', priority: 'p1', estimate: 8, assignee: 'branarakic',
    relatedDecision: ['live-genui-over-static-templates'],
    dependsOn: ['vm-hero-panel'],
    relatedPR: [prU(215)] },
  { slug: 'relations-tab', title: 'Dedicated cross-sub-graph Relations tab',
    status: 'todo', priority: 'p2', estimate: 4, assignee: 'branarakic',
    relatedDecision: ['unified-layer-content'],
    dependsOn: ['subgraph-bar-ui'] },
  { slug: 'predicate-filter-chips', title: 'PredicateFilterChips inside the Graph tab',
    status: 'todo', priority: 'p2', estimate: 3, assignee: 'branarakic',
    relatedDecision: ['vibrant-graph-predicates'],
    dependsOn: ['vm-graph-styling'] },
  { slug: 'shacl-on-vm-promotion', title: 'SHACL validation on promote-to-VM path',
    status: 'todo', priority: 'p2', estimate: 6, assignee: 'branarakic',
    relatedDecision: ['verified-memory-hero-view'],
    dependsOn: ['vm-hero-panel'] },
  { slug: 'retire-dkg-code-project', title: 'Retire the old dkg-code project once dkg-code-project is accepted',
    status: 'todo', priority: 'p3', estimate: 1, assignee: 'branarakic',
    dependsOn: ['book-research-stub'] },

  // ─── ui/upgrades follow-ups ─────────────────────────────────────
  { slug: 'graph-viz-font-tuning', title: 'Lower default graph label font and tighten truncation',
    status: 'done', priority: 'p2', estimate: 1, assignee: 'branarakic',
    relatedDecision: ['vibrant-graph-predicates'],
    touches: [pkg(graphVizPkg), file(nodeUiPkg, 'src/ui/views/ProjectView.tsx')] },
  { slug: 'label-truncation-smarter', title: 'Smarter localName fallback for URN-style URIs (URL-decoded paths, `:` tail)',
    status: 'done', priority: 'p2', estimate: 1, assignee: 'branarakic',
    relatedDecision: ['vibrant-graph-predicates'],
    dependsOn: ['graph-viz-font-tuning'],
    touches: [pkg(graphVizPkg)] },
  { slug: 'genui-fallback-unbound-types', title: 'Fall back to generic detail panel when no profile binding matches',
    status: 'todo', priority: 'p1', estimate: 2, assignee: 'branarakic',
    relatedDecision: ['live-genui-over-static-templates'],
    dependsOn: ['register-openui-components'],
    touches: [pkg(nodeUiPkg)] },
  { slug: 'genui-streaming-progress', title: 'Show token-count progress while OpenUI Lang streams',
    status: 'todo', priority: 'p2', estimate: 2, assignee: 'branarakic',
    relatedDecision: ['live-genui-over-static-templates'],
    dependsOn: ['genui-fallback-unbound-types'],
    touches: [pkg(nodeUiPkg)] },
  { slug: 'sparql-cross-subgraph-queries', title: 'UI preset: "decisions affecting files in packages/node-ui"',
    status: 'todo', priority: 'p1', estimate: 3, assignee: 'branarakic',
    relatedDecision: ['subgraphs-as-first-class', 'unified-layer-content'],
    dependsOn: ['subgraph-list-endpoint'],
    touches: [file(daemonPkg, 'src/daemon.ts'), pkg(nodeUiPkg)] },
  { slug: 'profile-ontology-publish', title: 'Publish the profile ontology itself as a Knowledge Asset',
    status: 'todo', priority: 'p2', estimate: 4,
    relatedDecision: ['ontology-as-published-knowledge'],
    dependsOn: ['vm-hero-panel'],
    touches: [pkg(daemonPkg)] },

  // ─── ops / test / CI (done work that should show up as completed) ──
  { slug: 'ci-shard-and-parallelize', title: 'Shard CI to cut PR wall-clock to ~5–6 min',
    status: 'done', priority: 'p1', estimate: 4, assignee: 'branarakic',
    relatedDecision: ['ci-shard-and-parallelize'],
    relatedPR: [prU(189)],
    touches: [pkg(daemonPkg), pkg(agentPkg)] },
  { slug: 'demock-ui-oracle-tests', title: 'Replace fake shims in UI/oracle tests with real fixtures',
    status: 'done', priority: 'p1', estimate: 5, assignee: 'branarakic',
    relatedDecision: ['demock-product-tests'],
    dependsOn: ['ci-shard-and-parallelize'],
    touches: [pkg(agentPkg), pkg(daemonPkg)] },
  { slug: 'evm-randomsampling-draws', title: 'Lower RandomSampling draws 10k→2k; stabilize D1 withdrawal flake',
    status: 'done', priority: 'p1', estimate: 2, assignee: 'branarakic',
    relatedDecision: ['reduce-randomsampling-draws'],
    touches: [pkg(daemonPkg)] },
  { slug: 'publisher-epoch-snapshot-fast', title: 'Ship publisher-epoch-snapshot-fast for live ops',
    status: 'done', priority: 'p2', estimate: 3, assignee: 'branarakic',
    relatedDecision: ['publisher-epoch-snapshot-fast'],
    touches: [pkg(daemonPkg)] },
  { slug: 'chat-assertion-owner-align', title: 'Align chat semantic URIs with assertion owner',
    status: 'done', priority: 'p1', estimate: 3, assignee: 'branarakic',
    relatedDecision: ['chat-assertion-owner-alignment'],
    relatedPR: [prU(215)],
    touches: [pkg(daemonPkg), pkg(agentPkg)] },
  { slug: 'openclaw-cross-channel-accountid', title: 'Fix OpenClaw cross-channel key to include accountId',
    status: 'done', priority: 'p1', estimate: 2, assignee: 'branarakic',
    relatedDecision: ['openclaw-cross-channel-account'],
    relatedPR: [prU(215)],
    touches: [pkg(agentPkg)] },

  // ─── blocked / cancelled / in-review so the board isn't a monoculture ──
  { slug: 'wake-transport-reconciliation-v2', title: 'Tighten wake-transport reconciliation under high churn',
    status: 'in_progress', priority: 'p0', estimate: 6, assignee: 'branarakic',
    dueDate: '2026-04-25',
    relatedIssue: [issueU(77)],
    touches: [pkg(agentPkg), file(daemonPkg, 'src/daemon.ts')] },
  { slug: 'shacl-runtime-integration', title: 'Wire SHACL validator into /api/shared-memory/promote',
    status: 'blocked', priority: 'p1', estimate: 8, assignee: 'branarakic',
    relatedDecision: ['shacl-on-vm-promotion'],
    dependsOn: ['shacl-on-vm-promotion', 'profile-ontology-publish'],
    relatedIssue: [issueU(42)] },
  { slug: 'chain-analysis-dashboard', title: 'Interactive chain-analysis dashboard on top of snapshot scripts',
    status: 'todo', priority: 'p2', estimate: 5, assignee: 'openclaw-agent',
    relatedDecision: ['publisher-epoch-snapshot-fast'],
    dependsOn: ['publisher-epoch-snapshot-fast'],
    touches: [pkg(daemonPkg)] },
  { slug: 'agent-proposes-decision-live', title: 'OpenClaw auto-drafts a Decision after it publishes a new KA',
    status: 'todo', priority: 'p2', estimate: 6, assignee: 'openclaw-agent',
    relatedDecision: ['live-genui-over-static-templates'],
    dependsOn: ['agent-coordinated-writes'] },
  { slug: 'migrate-cg-format-v1', title: 'Migrate legacy context-graph format to v1 (pre-sub-graph)',
    status: 'cancelled', priority: 'p2', estimate: 10, assignee: 'branarakic',
    relatedDecision: ['subgraphs-as-first-class'] },
];

const sink = createTripleSink();
const { emit } = sink;

for (const t of TASKS) {
  const id = Tasks.uri.task(t.slug);
  emit(uri(id), uri(Common.type), uri(Tasks.T.Task));
  emit(uri(id), uri(Common.name), lit(t.title));
  emit(uri(id), uri(Common.label), lit(t.title));
  emit(uri(id), uri(Common.title), lit(t.title));
  emit(uri(id), uri(Tasks.P.status), lit(t.status));
  emit(uri(id), uri(Tasks.P.priority), lit(t.priority));
  if (typeof t.estimate === 'number') emit(uri(id), uri(Tasks.P.estimate), lit(t.estimate, XSD.int));
  if (t.assignee) emit(uri(id), uri(Tasks.P.assignee), uri(userU(t.assignee)));
  if (t.dueDate) emit(uri(id), uri(Tasks.P.dueDate), lit(t.dueDate, 'http://www.w3.org/2001/XMLSchema#date'));
  // Every task gets a `dcterms:created` so the activity feed can
  // order it. Overridden by t.createdAt if the seed provides one.
  emit(
    uri(id),
    '<http://purl.org/dc/terms/created>',
    lit(t.createdAt ?? seedCreatedFor(t.slug), XSD.dateTime),
  );
  for (const dep of t.dependsOn ?? []) emit(uri(id), uri(Tasks.P.dependsOn), uri(Tasks.uri.task(dep)));
  for (const dec of t.relatedDecision ?? []) emit(uri(id), uri(Tasks.P.relatedDecision), uri(decU(dec)));
  for (const pr of t.relatedPR ?? []) emit(uri(id), uri(Tasks.P.relatedPR), uri(pr));
  for (const issue of t.relatedIssue ?? []) emit(uri(id), uri(Tasks.P.relatedIssue), uri(issue));
  for (const touch of t.touches ?? []) emit(uri(id), uri(Tasks.P.touches), uri(touch));
  // Agent attribution — same contract as decisions.
  const authorSlug = TASK_AUTHOR[t.slug] ?? 'claude-code-branarakic';
  emit(uri(id), uri(Agent.Prov.wasAttributedTo), uri(agentU(authorSlug)));
}

console.log(`[tasks] Produced ${sink.size()} triples from ${TASKS.length} tasks.`);

if (OUT_FILE) {
  const nt = sink.triples.map(t => `${t.subject} ${t.predicate} ${t.object} .`).join('\n') + '\n';
  fs.writeFileSync(OUT_FILE, nt);
  console.log(`[tasks] Wrote ${sink.size()} triples to ${OUT_FILE}`);
}

if (DRY_RUN) {
  console.log('[tasks] --dry-run set; not importing.');
  process.exit(0);
}

const token = resolveToken(REPO_ROOT);
const client = makeClient({ apiBase: API_BASE, token });
const { cgId } = await client.ensureProject({
  id: PROJECT_ID,
  name: 'DKG Code memory',
  description: 'Shared context graph for the dkg-v9 monorepo itself.',
});
await client.ensureSubGraph(cgId, SUBGRAPH);
await client.writeAssertion(
  {
    contextGraphId: cgId,
    assertionName: ASSERTION_NAME,
    subGraphName: SUBGRAPH,
    triples: sink.triples,
  },
  { label: 'tasks' },
);
console.log(`[tasks] Done. Imported ${sink.size()} triples into ${cgId}/${SUBGRAPH}/${ASSERTION_NAME}.`);
