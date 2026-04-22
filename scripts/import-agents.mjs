#!/usr/bin/env node
/**
 * Seed a small set of first-class agent entities into the project's
 * `meta` sub-graph. Every decision / task / commit in the project then
 * carries `prov:wasAttributedTo <agent URI>` so the UI can surface
 * *who* wrote each triple at a glance.
 *
 * For the dkg-code-project PoC we seed a plausible multi-participant
 * setup: two humans (you + a teammate), each driving two AI agents
 * (Claude Code + OpenClaw / Hermes). That gives the UI enough variety
 * to show attribution colors, framework badges, and the "requested by
 * <human>" chain without looking fake.
 *
 * Agents are entities, not profile config — they live in `meta` as
 * their own assertion (`participants`). Other projects can ship a
 * different set; the UI reads them via the standard useAgents() hook.
 *
 * Usage:
 *   node scripts/import-agents.mjs
 *   node scripts/import-agents.mjs --dry-run --out=/tmp/agents.nt
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeClient, parseArgs, resolveToken } from './lib/dkg-daemon.mjs';
import {
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
const SUBGRAPH = args.subgraph ?? 'meta';
const ASSERTION_NAME = args.assertion ?? 'participants';
const DRY_RUN = args['dry-run'] === 'true';
const OUT_FILE = args.out ?? null;

const agentUri = (slug) => Agent.uri.agent(slug);

// ── Seed cast ─────────────────────────────────────────────────
// The PoC assumes a two-human team, each running their own AI agents.
// Slug convention: `{framework}-{operator}` for AI, `{operator}` for
// humans — keeps URIs stable across imports and readable in SPARQL.
// Wallet addresses — for the demo we use Hardhat's default accounts so
// they're recognisable in devnet logs. Humans control their own wallet;
// AI agents run with a delegated wallet issued by the operator.
export const AGENTS = [
  // ─── Humans ──────────────────────────────────────────────────
  {
    slug: 'branarakic',
    name: 'branarakic',
    kind: 'human',
    walletAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // hardhat[0]
    joinedAt: '2026-01-03T09:00:00Z',
    reputation: 'Project lead. Makes the final call on VM promotion.',
  },
  {
    slug: 'bojan',
    name: 'bojan',
    kind: 'human',
    walletAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', // hardhat[1]
    joinedAt: '2026-02-11T14:30:00Z',
    reputation: 'Operations lead. Owns the devnet and CI pipeline.',
  },

  // ─── AI agents ────────────────────────────────────────────────
  {
    slug: 'claude-code-branarakic',
    name: 'Claude Code',
    kind: 'ai',
    framework: 'claude-code',
    operator: 'branarakic',
    walletAddress: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', // hardhat[2]
    peerId: '12D3KooWKA4US8STRnvXiPKQXs9ApDClaude1',
    joinedAt: '2026-02-20T10:00:00Z',
    reputation: 'Ships most of the node-ui / graph-viz refactors. Verbose, strong opinions.',
  },
  {
    slug: 'openclaw-branarakic',
    name: 'OpenClaw',
    kind: 'ai',
    framework: 'openclaw',
    operator: 'branarakic',
    walletAddress: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', // hardhat[3]
    peerId: '12D3KooWKA4US8STRnvXiPKQXs9ApDOpenClaw1',
    joinedAt: '2026-03-05T11:20:00Z',
    reputation: 'Chat-first agent. Drafts decisions during research sessions, proposes novel approaches.',
  },
  {
    slug: 'claude-code-bojan',
    name: 'Claude Code',
    kind: 'ai',
    framework: 'claude-code',
    operator: 'bojan',
    walletAddress: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', // hardhat[4]
    peerId: '12D3KooWKA4US8STRnvXiPKQXs9ApDClaude2',
    joinedAt: '2026-03-18T15:45:00Z',
    reputation: 'Focuses on CI, ops, and cross-package integration hardening.',
  },
  {
    slug: 'hermes-bojan',
    name: 'Hermes',
    kind: 'ai',
    framework: 'hermes',
    operator: 'bojan',
    walletAddress: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc', // hardhat[5]
    joinedAt: '2026-04-02T09:15:00Z',
    reputation: 'Early-stage. Explores alternatives, often gets rejected, learns fast.',
  },
];

const sink = createTripleSink();
const { emit } = sink;

for (const a of AGENTS) {
  const id = agentUri(a.slug);
  const kindType = a.kind === 'human' ? Agent.T.HumanAgent : Agent.T.AIAgent;
  emit(uri(id), uri(Common.type), uri(Agent.T.Agent));
  emit(uri(id), uri(Common.type), uri(kindType));
  emit(uri(id), uri(Common.name), lit(a.name));
  emit(uri(id), uri(Common.label), lit(a.name));
  if (a.framework)     emit(uri(id), uri(Agent.P.framework),     lit(a.framework));
  if (a.operator)      emit(uri(id), uri(Agent.P.operator),      uri(agentUri(a.operator)));
  if (a.walletAddress) emit(uri(id), uri(Agent.P.walletAddress), lit(a.walletAddress));
  if (a.peerId)        emit(uri(id), uri(Agent.P.peerId),        lit(a.peerId));
  if (a.avatar)        emit(uri(id), uri(Agent.P.avatar),        lit(a.avatar));
  if (a.joinedAt)      emit(uri(id), uri(Agent.P.joinedAt),      lit(a.joinedAt, XSD.dateTime));
  if (a.reputation)    emit(uri(id), uri(Agent.P.reputation),    lit(a.reputation));
}

console.log(`[agents] Produced ${sink.size()} triples from ${AGENTS.length} agents.`);

if (OUT_FILE) {
  const nt = sink.triples.map(t => `${t.subject} ${t.predicate} ${t.object} .`).join('\n') + '\n';
  fs.writeFileSync(OUT_FILE, nt);
  console.log(`[agents] Wrote ${sink.size()} triples to ${OUT_FILE}`);
}

if (DRY_RUN) {
  console.log('[agents] --dry-run set; not importing.');
  process.exit(0);
}

const token = resolveToken(REPO_ROOT);
const client = makeClient({ apiBase: API_BASE, token });
await client.ensureProject({
  id: PROJECT_ID,
  name: 'DKG Code memory',
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
  { label: 'agents' },
);
console.log(`[agents] Done. Imported ${sink.size()} triples into ${PROJECT_ID}/${SUBGRAPH}/${ASSERTION_NAME}.`);
