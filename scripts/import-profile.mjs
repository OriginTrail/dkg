#!/usr/bin/env node
/**
 * Write the dkg-code-project profile into the `meta` sub-graph.
 *
 * The profile tells the generic Node UI how to display this project:
 *   - SubGraphBindings:  icon/color/label for each sub-graph
 *   - EntityTypeBindings: icon/color/label/prompt-hint for each rdf:type
 *   - ViewConfigs:       preset graph views (Package Map, PR Impact, Verified Provenance)
 *
 * Run:
 *   node scripts/import-profile.mjs
 *   node scripts/import-profile.mjs --project=dkg-code-project --dry-run
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeClient, parseArgs, resolveToken } from './lib/dkg-daemon.mjs';
import {
  Profile,
  Code,
  Github,
  Decisions,
  Tasks,
  Common,
  XSD,
  NS,
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
const SUBGRAPH = args.subgraph ?? 'meta';
const ASSERTION_NAME = args.assertion ?? 'project-profile';
const DRY_RUN = args['dry-run'] === 'true';

const sink = createTripleSink();
const { emit } = sink;

const profileId = Profile.uri.profile(PROJECT_ID);

// ── Profile root ──────────────────────────────────────────────
emit(uri(profileId), uri(Common.type), uri(Profile.T.Profile));
emit(uri(profileId), uri(Profile.P.appliesTo), lit(PROJECT_ID));
emit(uri(profileId), uri(Profile.P.displayName), lit('DKG Code memory'));
emit(uri(profileId), uri(Common.description), lit(
  'Shared context graph for the dkg-v9 monorepo: code (AST), github (PRs/issues/commits), ' +
  'decisions, and tasks — collaboratively produced by agents + humans.',
));
emit(uri(profileId), uri(Profile.P.primaryColor), lit('#a855f7'));
emit(uri(profileId), uri(Profile.P.accentColor), lit('#22c55e'));

// ── SubGraph bindings ─────────────────────────────────────────
// `timeline` — when set, opts this sub-graph into a Timeline tab. The UI
// reads `profile:timelinePredicate` from the binding and renders a
// horizontal ribbon of the sub-graph's entities sorted by that literal.
const subGraphs = [
  { slug: 'code',      icon: '⟨⟩', color: '#3b82f6', displayName: 'Code',      description: 'Packages, files, classes, and functions extracted from AST.', rank: 1 },
  { slug: 'github',    icon: '⎇',  color: '#f59e0b', displayName: 'GitHub',    description: 'Pull requests, issues, commits, and reviews.',               rank: 2, timeline: Github.P.mergedAt },
  { slug: 'decisions', icon: '◆',  color: '#ef4444', displayName: 'Decisions', description: 'Architectural decisions with context and consequences.',     rank: 3, timeline: Decisions.P.date },
  { slug: 'tasks',     icon: '✓',  color: '#06b6d4', displayName: 'Tasks',     description: 'Planned and in-flight work, cross-linked to decisions + PRs.', rank: 4, timeline: Tasks.P.dueDate },
  { slug: 'meta',      icon: 'ⓘ',  color: '#64748b', displayName: 'Meta',      description: 'Project self-description (the profile you are reading now).', rank: 5 },
];
for (const sg of subGraphs) {
  const id = Profile.uri.binding(PROJECT_ID, `sg-${sg.slug}`);
  emit(uri(id), uri(Common.type), uri(Profile.T.SubGraphBinding));
  emit(uri(id), uri(Profile.P.ofProfile), uri(profileId));
  emit(uri(id), uri(Profile.P.forSubGraph), lit(sg.slug));
  emit(uri(id), uri(Profile.P.icon), lit(sg.icon));
  emit(uri(id), uri(Profile.P.color), lit(sg.color));
  emit(uri(id), uri(Profile.P.displayName), lit(sg.displayName));
  emit(uri(id), uri(Common.description), lit(sg.description));
  emit(uri(id), uri(Profile.P.rank), lit(sg.rank, XSD.int));
  if (sg.timeline) emit(uri(id), uri(Profile.P.timelinePredicate), uri(sg.timeline));
}

// ── Entity type bindings (icon/color/label + GenUI prompt hint) ────
const bindings = [
  // Code
  {
    slug: 'code-package', type: Code.T.Package,
    icon: '📦', color: '#a855f7', label: 'Package',
    hint: 'Render as a PackageCard: show package name, folder, description. Follow with an EntityStatsGrid summarising file / class / function counts from the triples. Then a CrossRefList scoped to code:contains showing top files by lineCount.',
  },
  {
    slug: 'code-file', type: Code.T.File,
    icon: '📄', color: '#3b82f6', label: 'File',
    hint: 'Render a FileCard with path and line count, then an EntityTypeList grouping contained declarations (classes / functions / interfaces). Add a CrossRefList showing code:imports with target file/package names.',
  },
  {
    slug: 'code-class', type: Code.T.Class,
    icon: 'C', color: '#22c55e', label: 'Class',
    hint: 'EntityCard with name, defined-in file path, line range, and isExported badge. If there are code:extends/implements triples, surface them as an EntityTypeList of parents.',
  },
  {
    slug: 'code-function', type: Code.T.Function,
    icon: 'ƒ', color: '#06b6d4', label: 'Function',
    hint: 'EntityCard with name, line range, paramCount, isAsync / isExported badges, and defined-in file.',
  },
  {
    slug: 'code-interface', type: Code.T.Interface,
    icon: 'I', color: '#f59e0b', label: 'Interface',
    hint: 'EntityCard + list of extended interfaces from code:extends triples.',
  },
  {
    slug: 'code-module', type: Code.T.ExternalModule,
    icon: '↗', color: '#94a3b8', label: 'External Module',
    hint: 'Minimal EntityCard; this is a third-party import target. Mention how many internal files import it (count code:imports triples pointing here).',
  },
  // GitHub
  {
    slug: 'gh-pr', type: Github.T.PullRequest,
    icon: '⇄', color: '#f59e0b', label: 'Pull Request',
    hint: 'Render a PRCard with title, #number, state, author, merged-at. Follow with an EntityStatsGrid (additions, deletions, changedFiles). Then a CrossRefList of github:affects showing touched code:File URIs and a CrossRefList of github:reviewedBy reviewers.',
  },
  {
    slug: 'gh-issue', type: Github.T.Issue,
    icon: '●', color: '#ef4444', label: 'Issue',
    hint: 'EntityCard with title, state, author. Surface closed-by-PR via inverse github:closes.',
  },
  {
    slug: 'gh-commit', type: Github.T.Commit,
    icon: '◉', color: '#8b5cf6', label: 'Commit',
    hint: 'EntityCard with sha (short), author, message, and a CrossRefList of touched files.',
  },
  {
    slug: 'gh-user', type: Github.T.User,
    icon: '@', color: '#06b6d4', label: 'User',
    hint: 'EntityCard with login; summarise authored PRs and reviewed PRs as two small stat chips.',
  },
  {
    slug: 'gh-repo', type: Github.T.Repository,
    icon: '⎇', color: '#f59e0b', label: 'Repository',
    hint: 'EntityCard with repo name + an EntityStatsGrid of PR counts by state.',
  },
  // Decisions
  {
    slug: 'decision', type: Decisions.T.Decision,
    icon: '◆', color: '#ef4444', label: 'Decision',
    hint: 'Render a DecisionCard with title, status, date. Include context and outcome sections as quoted text. Add a CrossRefList of decisions:affects showing files/packages touched by this decision, and a link-out to the recording PR via decisions:recordedIn.',
  },
  // Tasks
  {
    slug: 'task', type: Tasks.T.Task,
    icon: '✓', color: '#06b6d4', label: 'Task',
    hint: 'TaskCard with title, status, priority, assignee. Show tasks:dependsOn as a chain of related tasks and tasks:touches as a list of files.',
  },
];
for (const b of bindings) {
  const id = Profile.uri.binding(PROJECT_ID, b.slug);
  emit(uri(id), uri(Common.type), uri(Profile.T.EntityTypeBinding));
  emit(uri(id), uri(Profile.P.ofProfile), uri(profileId));
  emit(uri(id), uri(Profile.P.forType), uri(b.type));
  emit(uri(id), uri(Profile.P.icon), lit(b.icon));
  emit(uri(id), uri(Profile.P.color), lit(b.color));
  emit(uri(id), uri(Profile.P.label), lit(b.label));
  emit(uri(id), uri(Profile.P.detailHint), lit(b.hint));
}

// ── ViewConfigs ───────────────────────────────────────────────
const views = [
  {
    slug: 'package-map',
    name: 'Package Map',
    description: 'Packages and the files they contain.',
    includeTypes: [Code.T.Package, Code.T.File],
    emphasizePredicates: [Code.P.contains],
    nodeSize: 'degree',
  },
  {
    slug: 'pr-impact',
    name: 'PR Impact',
    description: 'PRs and the files they touch — see hotspots at a glance.',
    includeTypes: [Github.T.PullRequest, Code.T.File, Github.T.User],
    emphasizePredicates: [Github.P.affects, Github.P.authoredBy],
    nodeSize: 'degree',
  },
  {
    slug: 'decision-network',
    name: 'Decision Network',
    description: 'Decisions, the PRs that recorded them, and the files they affect.',
    includeTypes: [Decisions.T.Decision, Github.T.PullRequest, Code.T.File],
    emphasizePredicates: [Decisions.P.affects, Decisions.P.recordedIn],
    nodeSize: 'degree',
  },
  {
    slug: 'verified-provenance',
    name: 'Verified Provenance',
    description: 'Verified-memory entities with their agent signers and on-chain anchors.',
    includeTypes: [], // layer-based filter
    emphasizePredicates: [],
    nodeSize: 'degree',
  },
];
for (const v of views) {
  const id = Profile.uri.view(PROJECT_ID, v.slug);
  emit(uri(id), uri(Common.type), uri(Profile.T.ViewConfig));
  emit(uri(id), uri(Profile.P.ofProfile), uri(profileId));
  emit(uri(id), uri(Profile.P.displayName), lit(v.name));
  emit(uri(id), uri(Common.description), lit(v.description));
  emit(uri(id), uri(Profile.P.nodeSize), lit(v.nodeSize));
  for (const t of v.includeTypes) emit(uri(id), uri(Profile.P.includeType), uri(t));
  for (const p of v.emphasizePredicates) emit(uri(id), uri(Profile.P.emphasizePredicate), uri(p));
}

// ── FilterChips ───────────────────────────────────────────────
// Declare the interactive filter rows the UI should render above the
// entity list in each sub-graph page. Multiple chips stack as OR within
// the same predicate, AND across predicates.
const chips = [
  { slug: 'decision-status', sg: 'decisions', type: Decisions.T.Decision, predicate: Decisions.P.status,
    label: 'Status', values: ['proposed', 'accepted', 'rejected', 'superseded'] },
  { slug: 'task-status',     sg: 'tasks',     type: Tasks.T.Task,         predicate: Tasks.P.status,
    label: 'Status', values: ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] },
  { slug: 'task-priority',   sg: 'tasks',     type: Tasks.T.Task,         predicate: Tasks.P.priority,
    label: 'Priority', values: ['p0', 'p1', 'p2', 'p3'] },
  { slug: 'gh-pr-state',     sg: 'github',    type: Github.T.PullRequest, predicate: Github.P.state,
    label: 'State', values: ['open', 'closed'] },
];
for (const c of chips) {
  const id = Profile.uri.chip(PROJECT_ID, c.slug);
  emit(uri(id), uri(Common.type), uri(Profile.T.FilterChip));
  emit(uri(id), uri(Profile.P.ofProfile), uri(profileId));
  emit(uri(id), uri(Profile.P.forSubGraph), lit(c.sg));
  emit(uri(id), uri(Profile.P.forType), uri(c.type));
  emit(uri(id), uri(Profile.P.onPredicate), uri(c.predicate));
  emit(uri(id), uri(Profile.P.label), lit(c.label));
  for (const v of c.values) emit(uri(id), uri(Profile.P.chipValue), lit(v));
}

// ── Saved SPARQL queries ──────────────────────────────────────
// Rendered as pills above the entity list. Clicking a pill runs the query
// against /api/sparql/query and displays the result set as the filtered
// entity list. `resultColumn` tells the UI which SELECT var holds the
// target entity URI.
const savedQueries = [
  {
    slug: 'decisions-touching-node-ui',
    sg: 'decisions',
    name: 'Decisions affecting node-ui',
    description: 'Every decision whose `affects` reaches a file in packages/node-ui.',
    resultColumn: 'decision',
    sparql: `
SELECT DISTINCT ?decision WHERE {
  GRAPH ?g { ?decision a <${Decisions.T.Decision}> ;
                       <${Decisions.P.affects}> ?target . }
  FILTER(CONTAINS(STR(?target), "node-ui"))
}`.trim(),
  },
  {
    slug: 'p0-p1-tasks-in-flight',
    sg: 'tasks',
    name: 'P0 / P1 tasks in flight',
    description: 'High-priority tasks currently `in_progress` or `blocked`.',
    resultColumn: 'task',
    sparql: `
SELECT DISTINCT ?task WHERE {
  GRAPH ?g {
    ?task a <${Tasks.T.Task}> ;
          <${Tasks.P.priority}> ?p ;
          <${Tasks.P.status}> ?s .
    FILTER(?p IN ("p0", "p1"))
    FILTER(?s IN ("in_progress", "blocked"))
  }
}`.trim(),
  },
  {
    slug: 'prs-that-affected-vm-packages',
    sg: 'github',
    name: 'PRs that touched flagship packages',
    description: 'Closed PRs that changed node-ui or graph-viz — likely VM candidates.',
    resultColumn: 'pr',
    sparql: `
SELECT DISTINCT ?pr WHERE {
  GRAPH ?g { ?pr a <${Github.T.PullRequest}> ;
                 <${Github.P.state}> "closed" ;
                 <${Github.P.affects}> ?f . }
  FILTER(CONTAINS(STR(?f), "node-ui") || CONTAINS(STR(?f), "graph-viz"))
}`.trim(),
  },
  {
    slug: 'decisions-with-open-tasks',
    sg: 'decisions',
    name: 'Decisions with open tasks',
    description: 'Decisions still tracked by at least one non-done task.',
    resultColumn: 'decision',
    sparql: `
SELECT DISTINCT ?decision WHERE {
  GRAPH ?g1 { ?decision a <${Decisions.T.Decision}> . }
  GRAPH ?g2 {
    ?task <${Tasks.P.relatedDecision}> ?decision ;
          <${Tasks.P.status}> ?s .
    FILTER(?s != "done" && ?s != "cancelled")
  }
}`.trim(),
  },
];
for (const q of savedQueries) {
  const id = Profile.uri.query(PROJECT_ID, q.slug);
  emit(uri(id), uri(Common.type), uri(Profile.T.SavedQuery));
  emit(uri(id), uri(Profile.P.ofProfile), uri(profileId));
  emit(uri(id), uri(Profile.P.forSubGraph), lit(q.sg));
  emit(uri(id), uri(Profile.P.displayName), lit(q.name));
  emit(uri(id), uri(Common.description), lit(q.description));
  emit(uri(id), uri(Profile.P.sparqlQuery), lit(q.sparql));
  emit(uri(id), uri(Profile.P.resultColumn), lit(q.resultColumn));
}

console.log(`[profile] Produced ${sink.size()} triples describing ${PROJECT_ID}.`);

if (DRY_RUN) {
  console.log('[profile] --dry-run set; not importing.');
  const nt = sink.triples.map(t => `${t.subject} ${t.predicate} ${t.object} .`).join('\n') + '\n';
  const outFile = args.out ?? '/tmp/profile.nt';
  fs.writeFileSync(outFile, nt);
  console.log(`[profile] Wrote ${sink.size()} triples to ${outFile}`);
  process.exit(0);
}

const token = resolveToken(REPO_ROOT);
const client = makeClient({ apiBase: API_BASE, token });
await client.ensureProject({
  id: PROJECT_ID,
  name: args.name ?? 'DKG Code memory',
  description: 'Shared context graph for the dkg-v9 monorepo itself.',
});
await client.ensureSubGraph(PROJECT_ID, SUBGRAPH);
await client.writeAssertion(
  {
    contextGraphId: PROJECT_ID,
    assertionName: ASSERTION_NAME,
    subGraphName: SUBGRAPH,
    triples: sink.triples,
  },
  { label: 'profile' },
);
console.log(`[profile] Done. Wrote profile for ${PROJECT_ID} into ${SUBGRAPH}/${ASSERTION_NAME}.`);
