#!/usr/bin/env node
/**
 * Write ~20 curated architectural decisions for the dkg-code-project.
 *
 * Each decision carries:
 *   - title, status (proposed/accepted/rejected/superseded), date
 *   - context, outcome, consequences, alternatives
 *   - decisions:affects     -> code:File or code:Package URIs
 *   - decisions:recordedIn  -> github:PullRequest URIs
 *   - decisions:proposedBy  -> github:User URIs
 *   - decisions:supersedes  -> older Decision slug (on the newer one)
 *
 * Decisions are synthetic but grounded in actual recent work on v10-rc
 * and this ui/upgrades branch, so the graph looks and queries like the
 * real thing. Statuses are deliberately mixed (a few `proposed` items
 * still up for discussion, one `rejected`, one `superseded`) so the
 * decisions sub-graph doesn't read as a wall of green checkmarks.
 * Tweak the DECISIONS array to tell a different story.
 *
 * Usage:
 *   node scripts/import-decisions.mjs
 *   node scripts/import-decisions.mjs --dry-run --out=/tmp/decisions.nt
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeClient, parseArgs, resolveToken } from './lib/dkg-daemon.mjs';
import {
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
const SUBGRAPH = args.subgraph ?? 'decisions';
const ASSERTION_NAME = args.assertion ?? 'decision-log';
const REPO = args.repo ?? 'OriginTrail/dkg-v9';
const [OWNER, REPO_NAME] = REPO.split('/');
const DRY_RUN = args['dry-run'] === 'true';
const OUT_FILE = args.out ?? null;

// Helper: build a code:File URI the same way the code importer does.
const pkg = (folder, pkgName) => ({ folder, name: pkgName });
const agent = pkg('agent', '@origintrail-official/dkg-agent');
const daemon = pkg('cli', '@origintrail-official/dkg-cli');
const nodeUi = pkg('node-ui', '@origintrail-official/dkg-node-ui');
const graphViz = pkg('graph-viz', '@origintrail-official/dkg-graph-viz');

const file = (p, relToPkg) => Code.uri.file(p.name, relToPkg);
const pkgU = (p) => Code.uri.package(p.name);
const prU = (num) => Github.uri.pr(OWNER, REPO_NAME, num);
const userU = (login) => Github.uri.user(login);
const agentU = (slug) => Agent.uri.agent(slug);

// Attribution: who actually drafted each decision. This drives the
// AgentChip in the UI so the curator can see at a glance "this batch
// was claude-code-branarakic's, that one was bojan". Decisions without
// an explicit entry fall back to 'claude-code-branarakic' which is the
// dominant author in this seed.
const DECISION_AUTHOR = {
  // Infra / operational — humans still drive these:
  'curated-cg-approval-rehydration':   'branarakic',
  'listcontextgraphs-chain-attested':  'branarakic',
  'ephemeral-pending-map':             'branarakic',
  'ci-shard-and-parallelize':          'bojan',
  'demock-product-tests':              'bojan',
  'reduce-randomsampling-draws':       'bojan',
  'publisher-epoch-snapshot-fast':     'bojan',
  // UI / architecture — mostly claude-code-branarakic:
  'rejection-notifications':           'claude-code-branarakic',
  'unified-layer-content':             'claude-code-branarakic',
  'vibrant-graph-predicates':          'claude-code-branarakic',
  'ast-code-ontology':                 'claude-code-branarakic',
  'project-profile-in-meta-subgraph':  'claude-code-branarakic',
  'live-genui-over-static-templates':  'claude-code-branarakic',
  'verified-memory-hero-view':         'claude-code-branarakic',
  'subgraphs-as-first-class':          'claude-code-branarakic',
  // Cross-package integration work — claude-code-bojan leads here:
  'chat-assertion-owner-alignment':    'claude-code-bojan',
  // Self-reported (OpenClaw writing about itself):
  'openclaw-cross-channel-account':    'openclaw-branarakic',
  // Still up for discussion — the more exploratory agents propose these:
  'shacl-on-vm-promotion':             'openclaw-branarakic',
  'ontology-as-published-knowledge':   'claude-code-branarakic',
  // Rejected proposals — hermes tends to push unconventional ideas early:
  'publish-via-adapter-openclaw':      'hermes-bojan',
};

const DECISIONS = [
  {
    slug: 'curated-cg-approval-rehydration',
    title: 'Rehydrate pending join-approvals after daemon restart',
    status: 'accepted',
    date: '2026-04-05',
    context:
      'Curated-CG approval flow was losing pending join requests when the daemon restarted, ' +
      'so invitees never received acceptance/rejection notifications and curators saw stale queues. ' +
      'The ephemeral in-memory map needed to be backed by sqlite state keyed on (contextGraphId, peerId).',
    outcome:
      'Persist pending join-approval records to the daemon sqlite store and rehydrate on boot. ' +
      'Curated subscriptions mark themselves synced after a successful catch-up so rejoining works cleanly.',
    consequences:
      'Acceptance/rejection notifications survive restart; existing migrations needed a new table; ' +
      'requires explicit cleanup when a CG is deleted.',
    alternatives: 'Keep in-memory only (lossy); push to a remote pubsub (heavier).',
    affects: [file(daemon, 'src/daemon.ts'), pkgU(agent)],
    recordedIn: [prU(189), prU(215)],
    proposedBy: 'branarakic',
    supersedes: ['ephemeral-pending-map'],
  },
  {
    slug: 'rejection-notifications',
    title: 'Notify invitee when curator rejects their join request',
    status: 'accepted',
    date: '2026-04-06',
    context:
      'UI only notified on acceptance; rejection was silent, confusing invitees who kept seeing "Request sent".',
    outcome:
      'Send an explicit rejection notification from the curator, displayed with a red chip and message in the node-ui notification tray.',
    consequences:
      'Invitee UI needs graceful empty-state if notification arrives before the project is opened; adds one new message type to the gossip protocol.',
    alternatives: 'Generic "request closed" notification (ambiguous).',
    affects: [file(daemon, 'src/daemon.ts'), file(nodeUi, 'src/ui/views/ProjectView.tsx')],
    recordedIn: [prU(215)],
    proposedBy: 'branarakic',
  },
  {
    slug: 'unified-layer-content',
    title: 'Unify MemoryStrip and LayerDetailView via a shared LayerContent component',
    status: 'accepted',
    date: '2026-04-12',
    context:
      'Expanded layer view and MemoryStrip cards had diverged: tabs, graph styling, and entity list ' +
      'behaved differently in each. Bugs fixed in one place silently reappeared in the other.',
    outcome:
      'Extract a shared LayerContent component (tabs: Entities / Assertions / Graph / Documents) used ' +
      'by both MemoryStrip (as MemoryStripExpanded wrapper) and the full LayerDetailView.',
    consequences:
      'Single source of truth for layer tab UI; a future change to any tab is instantly reflected in both views.',
    alternatives: 'Shared render-function per tab (less composable); CSS-level unification (fragile).',
    affects: [file(nodeUi, 'src/ui/views/ProjectView.tsx'), file(nodeUi, 'src/ui/styles.css')],
    recordedIn: [],
    proposedBy: 'branarakic',
  },
  {
    slug: 'vibrant-graph-predicates',
    title: 'Predicate-coloured edges and degree-scaled hexagons in graph-viz',
    status: 'accepted',
    date: '2026-04-13',
    context:
      'Graphs looked thin and monochrome: degree-1 nodes and high-degree hubs rendered at similar sizes, ' +
      'edges were slate hairlines that did not convey predicate semantics.',
    outcome:
      'Add a vibrant CODE_PREDICATE_COLORS palette per predicate (imports blue, contains purple, extends green, implements cyan, exports amber). ' +
      'Scale hexagons with degree and widen edges so hubs dominate visually.',
    consequences:
      'Graph communicates structure at a glance; slightly higher CPU on dense graphs; ' +
      'colours must be kept in sync with the profile ontology palette over time.',
    alternatives: 'Let the LLM colour edges per-scene (overkill and flaky).',
    affects: [pkgU(graphViz), file(nodeUi, 'src/ui/views/ProjectView.tsx')],
    recordedIn: [],
    proposedBy: 'branarakic',
  },
  {
    slug: 'ast-code-ontology',
    title: 'Adopt a dedicated http://dkg.io/ontology/code/ vocabulary for AST triples',
    status: 'accepted',
    date: '2026-04-14',
    context:
      'Importing ~24k code triples needed stable, human-readable URIs and predicates. Using schema.org ' +
      'loosely would have made cross-project reuse harder and hidden our semantics.',
    outcome:
      'Define code ontology with Package / File / Class / Interface / Function / TypeAlias / Enum / ExternalModule types and ' +
      'contains / definedIn / imports / exports / extends / implements predicates.',
    consequences:
      'Profile ontology can bind explicitly to code:Package, code:File, etc.; future multi-language parsers ' +
      'inherit the same vocabulary; SPARQL queries stay readable.',
    alternatives: 'Reuse schema.org SoftwareSourceCode (too broad); use spdx (license-focused, not structural).',
    affects: [pkgU(agent), pkgU(daemon)],
    recordedIn: [prU(200)],
    proposedBy: 'branarakic',
  },
  {
    slug: 'project-profile-in-meta-subgraph',
    title: 'Store the project profile as RDF in a `meta` sub-graph of the project itself',
    status: 'accepted',
    date: '2026-04-15',
    context:
      'Node UI must render different project types (code, book research, scientific) without hard-coding ' +
      'domain assumptions. A declarative profile accessible via standard SPARQL is the cleanest contract.',
    outcome:
      'Add http://dkg.io/ontology/profile/ with Profile / SubGraphBinding / EntityTypeBinding / ViewConfig. ' +
      'Write the profile into a `meta` sub-graph on project creation; the UI reads it via SPARQL.',
    consequences:
      'Profile is portable and discoverable; other DKG-aware UIs can reuse it; no UI code changes to support ' +
      'new project types, just a new profile + data.',
    alternatives: 'Hard-coded per-project-type UI branches (brittle); separate app per domain (no shared graph).',
    affects: [pkgU(daemon), pkgU(nodeUi)],
    recordedIn: [],
    proposedBy: 'branarakic',
  },
  {
    slug: 'live-genui-over-static-templates',
    title: 'Compose entity detail views with live LLM-generated OpenUI Lang, not static templates',
    status: 'accepted',
    date: '2026-04-16',
    context:
      'Static per-type templates defeated the point: the UI would look the same everywhere and could not ' +
      'adapt to entity-specific data. The existing daemon-side LlmClient + OpenUI Lang runtime make live composition tractable.',
    outcome:
      'Add POST /api/genui/render that streams OpenUI Lang from LlmClient given { contextGraphId, entityUri, profile, triples }. ' +
      'Profile contributes prompt hints per rdf:type, not the UI tree itself.',
    consequences:
      'Higher visual fidelity per entity; variable latency and token cost; fallback to generic detail view on LLM failure.',
    alternatives: 'Static templates per type (what we rejected); hand-coded detail views per type (does not scale across domains).',
    affects: [file(daemon, 'src/daemon.ts'), pkgU(nodeUi)],
    recordedIn: [],
    proposedBy: 'branarakic',
  },
  {
    slug: 'verified-memory-hero-view',
    title: 'Treat Verified Memory as the hero layer with rich provenance UI',
    status: 'accepted',
    date: '2026-04-16',
    context:
      'VM is where DKG actually earns TRAC — consensus, on-chain anchoring, agent identity — but the UI ' +
      'previously showed VM as just another layer with green styling.',
    outcome:
      'Introduce a VerifiedProvenancePanel component that surfaces TX hash, block, signing agents (DIDs + reputation), ' +
      'UAL, content hash, TRAC locked, NFT token ID. Add graph styling for VM: signature edges, agent nodes, chain-anchor nodes, VM halos.',
    consequences:
      'VM layer visibly justifies its cost; the new components become the reference for similar verification UIs in other DKG apps.',
    alternatives: 'Leave VM visually identical and put provenance in a modal (buries the value prop).',
    affects: [file(nodeUi, 'src/ui/views/ProjectView.tsx'), pkgU(graphViz)],
    recordedIn: [],
    proposedBy: 'branarakic',
  },
  {
    slug: 'subgraphs-as-first-class',
    title: 'Sub-graphs are first-class: every importer writes into exactly one',
    status: 'accepted',
    date: '2026-04-14',
    context:
      'Before, everything landed in a default graph. For multi-domain projects (code + github + decisions + tasks) we ' +
      'need client-side filtering and per-sub-graph visual themes.',
    outcome:
      'All importers take --subgraph; the Node UI introduces a SubGraphBar above the MemoryStrip; ' +
      'GET /api/sub-graph/list exposes per-sub-graph entity/triple counts.',
    consequences:
      'Cross-sub-graph joins are easy (shared URIs); per-sub-graph views stay fast; schema migrations track sub-graphs.',
    alternatives: 'Tag triples with a subGraphName predicate (ugly and slow).',
    affects: [file(daemon, 'src/daemon.ts'), pkgU(nodeUi)],
    recordedIn: [],
    proposedBy: 'branarakic',
  },
  {
    slug: 'listcontextgraphs-chain-attested',
    title: 'listContextGraphs returns chain-attested entries, not only locally synced ones',
    status: 'accepted',
    date: '2026-04-04',
    context:
      'listContextGraphs was filtering out projects that had been created on-chain but not yet fully ' +
      'synced locally, making newly-created curated CGs invisible to curators.',
    outcome:
      'Return all chain-attested entries regardless of local sync state; UI shows a "syncing" badge for partial ones.',
    consequences:
      'Curators see their own CGs immediately after on-chain create; UI must handle partial-sync states gracefully.',
    alternatives: 'Force a full sync before listing (slow and fails offline).',
    affects: [file(daemon, 'src/daemon.ts')],
    recordedIn: [prU(215)],
    proposedBy: 'branarakic',
  },
  {
    slug: 'ci-shard-and-parallelize',
    title: 'Parallelize and shard CI so typical PRs finish in ~5–6 min',
    status: 'accepted',
    date: '2026-04-13',
    context:
      'CI was a single long-running queue: publisher + agent + evm integration all ran end-to-end on every PR, ' +
      'frequently pushing wall-clock past 20 min and blocking merges.',
    outcome:
      'Split into sharded matrix jobs (agent × 4, publisher × 2–3), add selective triggers per path, and stop ' +
      'double-running on `test/**` push + pull_request for the same SHA.',
    consequences:
      'Typical PR turnaround ~5–6 min; runner cost up ~15%; shard-count is a knob we must tune as the test base grows.',
    alternatives: 'Move to self-hosted runners (more ops overhead); skip integration tests on PR (loses coverage).',
    affects: [pkgU(daemon), pkgU(agent)],
    recordedIn: [],
    proposedBy: 'branarakic',
  },
  {
    slug: 'demock-product-tests',
    title: 'De-mock UI/oracle tests and add product packages to CI',
    status: 'accepted',
    date: '2026-04-11',
    context:
      'Several UI and oracle tests were shimmed with ad-hoc fakes that drifted from real behaviour, masking ' +
      'regressions in adapter-openclaw and the publisher query path. Product packages were not in the CI matrix at all.',
    outcome:
      'Replace fakes with real fixtures, add a `test:product` target, and include adapter-openclaw + publisher in CI.',
    consequences:
      'Real coverage of product packages; a handful of tests got slower; CI bill bumps slightly but catches more.',
    alternatives: 'Keep shims and rely on manual QA (we already know how that ends).',
    affects: [pkgU(agent), pkgU(daemon)],
    recordedIn: [],
    proposedBy: 'branarakic',
  },
  {
    slug: 'reduce-randomsampling-draws',
    title: 'Reduce RandomSampling distribution draws from 10k to 2k in EVM tests',
    status: 'accepted',
    date: '2026-04-10',
    context:
      'EVM integration tests were drawing 10,000 distribution samples per case, pushing each case past 90 s and ' +
      'causing intermittent picker-flake timeouts on the D1 withdrawal path.',
    outcome:
      'Lower per-case draws to 2,000 — still enough for chi-square stability — and add a targeted stabilizer for the D1 flake.',
    consequences:
      'Wall-clock per EVM shard drops ~40%; confidence interval widens by ~0.3%, still inside acceptance bounds.',
    alternatives: 'Keep 10k and extend timeouts (cost balloons); skip distribution assertions (loses coverage).',
    affects: [pkgU(daemon)],
    recordedIn: [],
    proposedBy: 'branarakic',
  },
  {
    slug: 'chat-assertion-owner-alignment',
    title: 'Align chat semantic URIs with the assertion owner, not the sender',
    status: 'accepted',
    date: '2026-04-09',
    context:
      'Chat enrichment wrote assertions whose URIs embedded the sender identity, so two agents talking in the same ' +
      'context graph produced duplicate assertions that fought over ownership on sync.',
    outcome:
      'URIs now derive from the assertion owner (context graph + channel), with sender attached as metadata. ' +
      'Semantic enrichment review fixes land alongside.',
    consequences:
      'Chat history is a single authoritative graph per channel; existing assertions need a one-shot migration.',
    alternatives: 'Keep sender-embedded URIs and dedup on read (slower, still ambiguous).',
    affects: [pkgU(daemon), pkgU(agent)],
    recordedIn: [prU(215)],
    proposedBy: 'branarakic',
  },
  {
    slug: 'openclaw-cross-channel-account',
    title: 'Include accountId in OpenClaw cross-channel conversation key',
    status: 'accepted',
    date: '2026-04-07',
    context:
      'Cross-channel conversation threading keyed only on channel + peer, so the same user across two accounts ' +
      'was merged into a single thread, leaking state between personas.',
    outcome:
      'Include accountId in the conversation key; clear pending user message on failed sends; clean up internal ' +
      'hook handlers on stop() to prevent double-wire.',
    consequences:
      'Persona isolation is correct; migration writes a new thread for each (account, channel, peer) triple.',
    alternatives: 'Per-account OpenClaw instances (heavy, kills cross-channel UX).',
    affects: [pkgU(agent)],
    recordedIn: [prU(215)],
    proposedBy: 'branarakic',
  },
  {
    slug: 'ephemeral-pending-map',
    title: 'Keep curated-CG pending requests in an ephemeral in-memory map',
    status: 'superseded',
    date: '2026-03-29',
    context:
      'Original curated-CG approval path tracked pending invites in a per-daemon in-memory map to avoid adding ' +
      'schema churn and to keep the approval flow strictly local.',
    outcome:
      'Implemented as a Map<contextGraphId, Set<peerId>> inside the daemon, cleared on project close.',
    consequences:
      'Fast, zero migration cost — but invites were lost on restart, which motivated the rehydration follow-up.',
    alternatives: 'Persist to sqlite from day one (what we ended up doing).',
    affects: [file(daemon, 'src/daemon.ts')],
    recordedIn: [],
    proposedBy: 'branarakic',
  },
  {
    slug: 'publisher-epoch-snapshot-fast',
    title: 'Split publisher-epoch-snapshot into "fast" and "full" variants',
    status: 'accepted',
    date: '2026-04-03',
    context:
      'The epoch snapshot script was both the reference implementation and the hot-path diagnostic tool. At ~10k ' +
      'KAs per epoch it took minutes, which was unusable for live ops inspection during a bad epoch.',
    outcome:
      'Introduce publisher-epoch-snapshot-fast.ts that trades completeness for speed (subset of fields, skip ' +
      'per-KA reward trace); keep the full variant as the audit canonical.',
    consequences:
      'Live ops has a ~5 s snapshot; audit path is untouched; both must be kept in sync schema-wise.',
    alternatives: 'Parametrize one script (branchy + error-prone); stream snapshots (overkill for a diagnostic).',
    affects: [pkgU(daemon)],
    recordedIn: [],
    proposedBy: 'branarakic',
  },
  {
    slug: 'shacl-on-vm-promotion',
    title: 'Adopt SHACL shapes on the promote-to-VM validation path',
    status: 'proposed',
    date: '2026-04-17',
    context:
      'Right now anything can be promoted to Verified Memory. If VM is the layer other agents trust without ' +
      'recomputation, we need protocol-level guarantees about shape and completeness of the promoted data.',
    outcome:
      'Define SHACL shape files per ontology (code, github, decisions, tasks, profile); run them in the daemon ' +
      'promote path; reject promotions that fail validation with actionable error messages.',
    consequences:
      'Stronger guarantees for consumers; adds a dependency on a SHACL validator and a small perf cost per promote.',
    alternatives: 'Ad-hoc pre-flight checks (brittle); relax and trust upstream (defeats the point of VM).',
    affects: [pkgU(daemon)],
    recordedIn: [],
    proposedBy: 'branarakic',
  },
  {
    slug: 'ontology-as-published-knowledge',
    title: 'Publish project ontologies as signed Knowledge Assets on the DKG itself',
    status: 'proposed',
    date: '2026-04-17',
    context:
      'Today every node ships ontology files as static assets. That breaks portability: a visiting agent cannot ' +
      'discover the vocabulary of a project it just joined without out-of-band coordination.',
    outcome:
      'Treat each ontology as a KA, publish it into the project\'s `meta` sub-graph, and let the daemon resolve ' +
      '`owl:imports` / `profile:usesOntology` links transparently on open.',
    consequences:
      'Profiles and ontologies become first-class DKG citizens; bootstrap cost on project open goes up slightly; ' +
      'version pinning needs policy.',
    alternatives: 'Keep ontologies in package code (what we do now — not portable).',
    affects: [pkgU(daemon), pkgU(nodeUi)],
    recordedIn: [],
    proposedBy: 'branarakic',
  },
  {
    slug: 'publish-via-adapter-openclaw',
    title: 'Route all agent publishes through adapter-openclaw instead of the daemon directly',
    status: 'rejected',
    date: '2026-04-08',
    context:
      'A short-lived proposal to centralise all agent publishes through adapter-openclaw so it could batch, ' +
      'enrich, and sign in one place. Sounded clean on paper.',
    outcome:
      'Rejected. Forcing every adapter through OpenClaw creates a hard dependency and a single point of failure. ' +
      'Adapters already share the agent library; batching and enrichment belong in the publisher layer.',
    consequences:
      'Adapters stay independent; publisher grows a small batching/enrichment hook; OpenClaw remains optional.',
    alternatives: 'The rejected proposal itself; a pluggable pre-publish middleware chain (kept as future work).',
    affects: [pkgU(agent), pkgU(daemon)],
    recordedIn: [],
    proposedBy: 'branarakic',
  },
];

const sink = createTripleSink();
const { emit } = sink;

for (const d of DECISIONS) {
  const id = Decisions.uri.decision(d.slug);
  emit(uri(id), uri(Common.type), uri(Decisions.T.Decision));
  emit(uri(id), uri(Common.name), lit(d.title));
  emit(uri(id), uri(Common.label), lit(d.title));
  emit(uri(id), uri(Common.title), lit(d.title));
  emit(uri(id), uri(Decisions.P.status), lit(d.status));
  emit(uri(id), uri(Decisions.P.date), lit(d.date, 'http://www.w3.org/2001/XMLSchema#date'));
  // Mirror the decision date as dcterms:created so the activity feed
  // can order decisions with the same temporal cue as tasks / PRs.
  emit(uri(id), '<http://purl.org/dc/terms/created>',
    lit(`${d.date}T12:00:00Z`, XSD.dateTime));
  emit(uri(id), uri(Decisions.P.context), lit(d.context));
  emit(uri(id), uri(Decisions.P.outcome), lit(d.outcome));
  emit(uri(id), uri(Decisions.P.consequences), lit(d.consequences));
  if (d.alternatives) emit(uri(id), uri(Decisions.P.alternatives), lit(d.alternatives));
  for (const target of d.affects) emit(uri(id), uri(Decisions.P.affects), uri(target));
  for (const pr of d.recordedIn) emit(uri(id), uri(Decisions.P.recordedIn), uri(pr));
  for (const olderSlug of d.supersedes ?? [])
    emit(uri(id), uri(Decisions.P.supersedes), uri(Decisions.uri.decision(olderSlug)));
  if (d.proposedBy) emit(uri(id), uri(Decisions.P.proposedBy), uri(userU(d.proposedBy)));
  // Agent attribution — points at an entity in the `meta` sub-graph.
  // This is what drives the AgentChip in the UI, independent of the
  // github-user pointer above (which is for cross-linking into GitHub).
  const authorSlug = DECISION_AUTHOR[d.slug] ?? 'claude-code-branarakic';
  emit(uri(id), uri(Agent.Prov.wasAttributedTo), uri(agentU(authorSlug)));
}

console.log(`[decisions] Produced ${sink.size()} triples from ${DECISIONS.length} decisions.`);

if (OUT_FILE) {
  const nt = sink.triples.map(t => `${t.subject} ${t.predicate} ${t.object} .`).join('\n') + '\n';
  fs.writeFileSync(OUT_FILE, nt);
  console.log(`[decisions] Wrote ${sink.size()} triples to ${OUT_FILE}`);
}

if (DRY_RUN) {
  console.log('[decisions] --dry-run set; not importing.');
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
  { label: 'decisions' },
);
console.log(`[decisions] Done. Imported ${sink.size()} triples into ${cgId}/${SUBGRAPH}/${ASSERTION_NAME}.`);
