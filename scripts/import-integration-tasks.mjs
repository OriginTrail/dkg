#!/usr/bin/env node
/**
 * Import the Cursor & Claude Code DKG-integration plan (PR #224) as live
 * tasks into the `tasks` sub-graph of `dkg-code-project`.
 *
 * Maps every todo from
 *   /Users/aleatoric/.cursor/plans/cursor_and_claude_code_dkg_integration_3dcf2a9e.plan.md
 * to a `tasks:Task` with a stable `urn:dkg:task:cursor-dkg-<slug>` URI.
 *
 * Writes under a dedicated assertion name (`integration-board`) so reruns
 * replace the integration tasks without touching the 33-task seed written
 * by `import-tasks.mjs`.
 *
 * Usage:
 *   node scripts/import-integration-tasks.mjs             # write + promote to SWM
 *   node scripts/import-integration-tasks.mjs --dry-run   # dump triples, no write
 *   node scripts/import-integration-tasks.mjs --no-promote
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeClient, parseArgs, resolveToken } from './lib/dkg-daemon.mjs';
import {
  Tasks,
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
const ASSERTION_NAME = args.assertion ?? 'integration-board';
const REPO = args.repo ?? 'OriginTrail/dkg-v9';
const [OWNER, REPO_NAME] = REPO.split('/');
const PR_NUMBER = Number(args.pr ?? 224);
const DRY_RUN = args['dry-run'] === 'true';
const NO_PROMOTE = args['no-promote'] === 'true';
const OUT_FILE = args.out ?? null;

// The agent populating these tasks — same URI the capture hook uses so
// `prov:wasAttributedTo` points at the Cursor session that's actually
// driving the work.
const AGENT_SLUG = args.agent ?? 'cursor-branarakic';

const prUri = Github.uri.pr(OWNER, REPO_NAME, PR_NUMBER);
const agentUri = Agent.uri.agent(AGENT_SLUG);

// ── Status calibration ──────────────────────────────────────────────
//
// Every plan todo is represented below. Status reflects current repo
// reality on `feat/cursor-dkg-integration` (commits b10f4dea, af713630,
// 67ac08b0) plus what we've empirically observed working in-session
// (MCP read tools all return, capture hook is writing chat turns, the
// 💬 sub-graph is populated). Phases 4/5/6 remain todo; Phase 2 install
// recipes are in_progress pending Claude Code + README polish.

const TASKS = [
  // ─── Phase 0 — pre-flight ─────────────────────────────────────
  {
    slug: 'cursor-dkg-phase0-spike',
    title: 'Phase 0 · Verify Cursor afterAgentResponse payload shape',
    status: 'done', priority: 'p1', estimate: 1,
    createdAt: '2026-04-18T08:00:00Z',
  },

  // ─── Phase 1 — ontology + profile ─────────────────────────────
  {
    slug: 'cursor-dkg-chat-ontology',
    title: 'Phase 1 · Extend ontology.mjs with chat namespace + ConversationTurn/Session shortcuts',
    status: 'done', priority: 'p1', estimate: 1,
    createdAt: '2026-04-18T08:30:00Z',
  },
  {
    slug: 'cursor-dkg-chat-profile-binding',
    title: 'Phase 1 · Register chat SubGraphBinding + ConversationTurn EntityTypeBinding in profile',
    status: 'done', priority: 'p1', estimate: 1,
    dependsOn: ['cursor-dkg-chat-ontology'],
    createdAt: '2026-04-18T09:00:00Z',
  },

  // ─── Phase 2 — MCP read server ────────────────────────────────
  {
    slug: 'cursor-dkg-mcp-scaffold',
    title: 'Phase 2 · Scaffold packages/mcp-dkg (TS, stdio transport, MCP SDK, bin entrypoint, config loader)',
    status: 'done', priority: 'p1', estimate: 3,
    createdAt: '2026-04-18T09:30:00Z',
  },
  {
    slug: 'cursor-dkg-mcp-list-tools',
    title: 'Phase 2 · Implement dkg_list_projects + dkg_list_subgraphs MCP tools',
    status: 'done', priority: 'p1', estimate: 1,
    dependsOn: ['cursor-dkg-mcp-scaffold'],
    createdAt: '2026-04-18T10:00:00Z',
  },
  {
    slug: 'cursor-dkg-mcp-read-tools',
    title: 'Phase 2 · Implement dkg_sparql + dkg_get_entity + dkg_search MCP tools',
    status: 'done', priority: 'p1', estimate: 2,
    dependsOn: ['cursor-dkg-mcp-scaffold'],
    createdAt: '2026-04-18T10:30:00Z',
  },
  {
    slug: 'cursor-dkg-mcp-activity-tools',
    title: 'Phase 2 · Implement dkg_list_activity + dkg_get_agent MCP tools',
    status: 'done', priority: 'p1', estimate: 2,
    dependsOn: ['cursor-dkg-mcp-scaffold'],
    createdAt: '2026-04-18T11:00:00Z',
  },
  {
    slug: 'cursor-dkg-mcp-chat-tool',
    title: 'Phase 2 · Implement dkg_get_chat MCP tool (SPARQL over chat sub-graph)',
    status: 'done', priority: 'p1', estimate: 1,
    dependsOn: ['cursor-dkg-mcp-scaffold'],
    createdAt: '2026-04-18T11:30:00Z',
  },
  {
    slug: 'cursor-dkg-install-recipes',
    title: 'Phase 2 · Install recipes + capture-hook wiring for both Cursor and Claude Code documented in packages/mcp-dkg/README.md',
    status: 'done', priority: 'p2', estimate: 2,
    dependsOn: ['cursor-dkg-mcp-scaffold'],
    createdAt: '2026-04-18T12:00:00Z',
  },

  // ─── Phase 3 — capture hook ───────────────────────────────────
  {
    slug: 'cursor-dkg-capture-hook-script',
    title: 'Phase 3 · Write .cursor/hooks/capture-chat.mjs (stdin → /api/assertion/chat-log/import-file → /promote)',
    status: 'done', priority: 'p1', estimate: 2,
    createdAt: '2026-04-18T12:30:00Z',
  },
  {
    slug: 'cursor-dkg-hooks-config',
    title: 'Phase 3 · Wire .cursor/hooks.json (sessionStart/End + beforeSubmitPrompt + afterAgentResponse)',
    status: 'done', priority: 'p1', estimate: 1,
    dependsOn: ['cursor-dkg-capture-hook-script'],
    createdAt: '2026-04-18T13:00:00Z',
  },
  {
    slug: 'cursor-dkg-claude-code-parity',
    title: 'Phase 3 · Claude Code parity — hooks merged into ~/.claude/settings.json, event-name aliases + last_assistant_message in capture-chat.mjs',
    status: 'done', priority: 'p2', estimate: 1,
    dependsOn: ['cursor-dkg-capture-hook-script'],
    createdAt: '2026-04-18T13:30:00Z',
  },
  {
    slug: 'cursor-dkg-verify-write-endpoint',
    title: 'Phase 3 · Verify existing /api/assertion/<name>/write supports incremental turn appends (no new endpoint)',
    status: 'done', priority: 'p1', estimate: 1,
    createdAt: '2026-04-18T13:30:00Z',
  },

  // ─── Phase 4 — two-machine wiring (THE HEADLINE GOAL) ─────────
  {
    slug: 'cursor-dkg-two-machines-wiring',
    title: 'Phase 4 · Second-machine wiring on devnet-node-2 (:9202) — .dkg/config.node2.yaml + laptop2 agent registered',
    status: 'done', priority: 'p0', estimate: 4,
    dependsOn: ['cursor-dkg-capture-hook-script', 'cursor-dkg-mcp-chat-tool'],
    dueDate: '2026-04-19',
    createdAt: '2026-04-18T14:00:00Z',
  },
  {
    slug: 'cursor-dkg-gossip-verification',
    title: 'Phase 4 · Auto-promote + gossip verified bidirectionally — turn on A → SWM on B ≤5s (both directions)',
    status: 'done', priority: 'p0', estimate: 2,
    dependsOn: ['cursor-dkg-two-machines-wiring'],
    dueDate: '2026-04-19',
    createdAt: '2026-04-18T14:00:00Z',
  },

  // ─── Phase 5 — review surface polish ──────────────────────────
  {
    slug: 'cursor-dkg-ui-polish',
    title: 'Phase 5 · Profile rows landed: ChatSession + ChatTurn EntityTypeBindings, chat-privacy/tool FilterChips, "Chat shared with me" SavedQuery — all visible via SPARQL on meta sub-graph',
    status: 'done', priority: 'p2', estimate: 1,
    dependsOn: ['cursor-dkg-chat-profile-binding'],
    createdAt: '2026-04-18T14:30:00Z',
  },
  {
    slug: 'cursor-dkg-eod-demo',
    title: 'Phase 5 · EOD demo validated — cross-agent dkg_get_chat on node2 returns branarakic tree-sitter discussion from gossiped SWM',
    status: 'done', priority: 'p2', estimate: 1,
    dependsOn: ['cursor-dkg-gossip-verification', 'cursor-dkg-ui-polish'],
    createdAt: '2026-04-18T14:30:00Z',
  },

  // ─── Phase 6 — agent write tools (deferred) ───────────────────
  {
    slug: 'cursor-dkg-write-tools',
    title: 'Phase 6 · Write tools landed: dkg_propose_decision / dkg_add_task / dkg_comment / dkg_request_vm_publish / dkg_set_session_privacy — all auto-promote WM→SWM, gossip to node2 ≤5s',
    status: 'done', priority: 'p2', estimate: 6,
    dependsOn: ['cursor-dkg-eod-demo'],
    createdAt: '2026-04-18T15:00:00Z',
  },

  // ─── Phase 7 — agent annotations + project ontology + URI convergence ─
  {
    slug: 'cursor-dkg-coding-project-ontology',
    title: 'Phase 7 · Author coding-project starter ontology (formal Turtle/OWL + agent-guide.md) at packages/mcp-dkg/templates/ontologies/coding-project/',
    status: 'done', priority: 'p1', estimate: 3,
    dependsOn: ['cursor-dkg-write-tools'],
    createdAt: '2026-04-18T19:00:00Z',
  },
  {
    slug: 'cursor-dkg-import-ontology-script',
    title: 'Phase 7 · scripts/import-ontology.mjs loads .ttl + .md into meta/project-ontology assertion + auto-promotes to SWM',
    status: 'done', priority: 'p1', estimate: 1,
    dependsOn: ['cursor-dkg-coding-project-ontology'],
    createdAt: '2026-04-18T19:10:00Z',
  },
  {
    slug: 'cursor-dkg-mcp-get-ontology',
    title: 'Phase 7 · dkg_get_ontology MCP tool — returns formal .ttl + agent guide markdown for the project ontology',
    status: 'done', priority: 'p1', estimate: 1,
    dependsOn: ['cursor-dkg-import-ontology-script'],
    createdAt: '2026-04-18T19:20:00Z',
  },
  {
    slug: 'cursor-dkg-mcp-annotate-turn',
    title: 'Phase 7 · dkg_annotate_turn MCP tool — batch-emits chat:topic/mentions/examines/proposes/concludes/asks + sugar over Phase 6 writes (proposedDecisions/Tasks/comments/vmPublishRequests)',
    status: 'done', priority: 'p1', estimate: 3,
    dependsOn: ['cursor-dkg-mcp-get-ontology'],
    createdAt: '2026-04-18T19:30:00Z',
  },
  {
    slug: 'cursor-dkg-hook-mention-regex',
    title: 'Phase 7 · Mention-regex backstop in capture-chat.mjs — auto-emits chat:mentions for any urn:dkg:* in turn text (defensive backstop if agent forgets dkg_annotate_turn)',
    status: 'done', priority: 'p2', estimate: 1,
    dependsOn: ['cursor-dkg-mcp-annotate-turn'],
    createdAt: '2026-04-18T19:40:00Z',
  },
  {
    slug: 'cursor-dkg-hook-agent-self-register',
    title: 'Phase 7 · capture-chat.mjs auto-registers agent in meta/agent-self-register-<slug> on first sessionStart — fixes operator-B onboarding pinch point',
    status: 'done', priority: 'p2', estimate: 1,
    dependsOn: ['cursor-dkg-mcp-annotate-turn'],
    createdAt: '2026-04-18T19:45:00Z',
  },
  {
    slug: 'cursor-dkg-hook-session-context',
    title: 'Phase 7 · capture-chat.mjs returns additionalContext on sessionStart — annotation protocol summary + 30 most-recent entities → agent boots with conventions in working context',
    status: 'done', priority: 'p1', estimate: 2,
    dependsOn: ['cursor-dkg-hook-agent-self-register'],
    createdAt: '2026-04-18T19:50:00Z',
  },
  {
    slug: 'cursor-dkg-cursor-rule',
    title: 'Phase 7 · .cursor/rules/dkg-annotate.mdc with alwaysApply:true — annotation contract + look-before-mint + slug normalisation rule + URI patterns',
    status: 'done', priority: 'p2', estimate: 1,
    dependsOn: ['cursor-dkg-mcp-annotate-turn'],
    createdAt: '2026-04-18T20:00:00Z',
  },
  {
    slug: 'cursor-dkg-agents-md',
    title: 'Phase 7 · AGENTS.md sibling for Claude Code/Continue/etc. — same protocol, more comprehensive than the Cursor rule',
    status: 'done', priority: 'p2', estimate: 1,
    dependsOn: ['cursor-dkg-cursor-rule'],
    createdAt: '2026-04-18T20:05:00Z',
  },
  {
    slug: 'cursor-dkg-starter-ontologies',
    title: 'Phase 7 · 4 additional starter ontologies (book-research, pkm, scientific-research, narrative-writing) shipped as ttl+md pairs in packages/mcp-dkg/templates/ontologies/',
    status: 'done', priority: 'p2', estimate: 3,
    dependsOn: ['cursor-dkg-coding-project-ontology'],
    createdAt: '2026-04-18T20:15:00Z',
  },
  {
    slug: 'cursor-dkg-create-project-modal-wire',
    title: 'Phase 7 · CreateProjectModal ontology picker wired (community + agent enabled with starter dropdown; upload deferred). Bundled starters via Vite import.meta.glob; calls /api/assertion/project-ontology/write+promote on CG creation',
    status: 'done', priority: 'p2', estimate: 2,
    dependsOn: ['cursor-dkg-starter-ontologies'],
    createdAt: '2026-04-18T20:30:00Z',
  },
  {
    slug: 'cursor-dkg-inbound-invite-investigation',
    title: 'Phase 7 · Investigated passive inbound-invite UX (gap confirmed: requires daemon CONTEXT_GRAPH_INVITED event + sseBroadcast). Spec + minimum-fix plan documented in packages/mcp-dkg/docs/INBOUND_INVITES.md for Phase 8',
    status: 'done', priority: 'p3', estimate: 1,
    createdAt: '2026-04-18T20:45:00Z',
  },
  {
    slug: 'cursor-dkg-reconciliation-doc',
    title: 'Phase 7 · Spec for future dkg_propose_same_as reconciliation flow documented in packages/mcp-dkg/docs/RECONCILIATION.md (Phase 8 work — repair pathway for the rare cases where look-before-mint loses a race)',
    status: 'done', priority: 'p3', estimate: 1,
    createdAt: '2026-04-18T20:50:00Z',
  },
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
  if (typeof t.estimate === 'number') {
    emit(uri(id), uri(Tasks.P.estimate), lit(t.estimate, XSD.int));
  }
  if (t.dueDate) {
    emit(uri(id), uri(Tasks.P.dueDate), lit(t.dueDate, 'http://www.w3.org/2001/XMLSchema#date'));
  }
  emit(
    uri(id),
    '<http://purl.org/dc/terms/created>',
    lit(t.createdAt ?? '2026-04-18T12:00:00Z', XSD.dateTime),
  );
  for (const dep of t.dependsOn ?? []) {
    emit(uri(id), uri(Tasks.P.dependsOn), uri(Tasks.uri.task(dep)));
  }
  // Every integration task is linked to PR #224 so the tasks cluster
  // around it in the graph viz and UI cross-references pick them up.
  emit(uri(id), uri(Tasks.P.relatedPR), uri(prUri));
  emit(uri(id), uri(Agent.Prov.wasAttributedTo), uri(agentUri));
}

console.log(`[integration-tasks] Produced ${sink.size()} triples from ${TASKS.length} tasks.`);

if (OUT_FILE) {
  const nt = sink.triples.map(t => `${t.subject} ${t.predicate} ${t.object} .`).join('\n') + '\n';
  fs.writeFileSync(OUT_FILE, nt);
  console.log(`[integration-tasks] Wrote N-Triples to ${OUT_FILE}`);
}

if (DRY_RUN) {
  console.log('[integration-tasks] --dry-run set; not importing.');
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
  { label: 'integration-tasks' },
);
console.log(
  `[integration-tasks] Wrote ${sink.size()} triples into ${cgId}/${SUBGRAPH}/${ASSERTION_NAME}.`,
);

if (!NO_PROMOTE) {
  const taskUris = TASKS.map(t => Tasks.uri.task(t.slug));
  try {
    await client.promote({
      contextGraphId: cgId,
      assertionName: ASSERTION_NAME,
      subGraphName: SUBGRAPH,
      entities: taskUris,
    });
    console.log(`[integration-tasks] Promoted ${taskUris.length} tasks WM → SWM.`);
  } catch (err) {
    console.warn(`[integration-tasks] Promote skipped: ${err.message}`);
  }
}
