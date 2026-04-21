#!/usr/bin/env node
/**
 * Register the second-laptop agent URI for the Phase 4 two-machines demo.
 *
 * Writes a single agent entity (`urn:dkg:agent:cursor-branarakic-laptop2`)
 * into the `meta` sub-graph under its own `cursor-laptop2-agent` assertion
 * so it doesn't clobber the seed `participants` assertion from
 * import-agents.mjs.
 *
 * Written through node-2's daemon (:9202) by default, so the entity
 * originates on the "second machine" and then gossips back to node-1
 * — proves the inverse replication direction as a side-benefit.
 *
 * Usage (defaults target node-2):
 *   node scripts/register-laptop2-agent.mjs
 *   node scripts/register-laptop2-agent.mjs --api=http://localhost:9202
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient, parseArgs, resolveToken } from './lib/dkg-daemon.mjs';
import { Agent, Common, XSD, createTripleSink, uri, lit } from './lib/ontology.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const args = parseArgs();
const API_BASE = (args.api ?? process.env.DEVNET_API ?? 'http://localhost:9202').replace(/\/$/, '');
const NODE_ID = Number(args['node-id'] ?? process.env.DEVNET_NODE_ID ?? 2);
const PROJECT_ID = args.project ?? 'dkg-code-project';
const SUBGRAPH = args.subgraph ?? 'meta';
const ASSERTION_NAME = args.assertion ?? 'cursor-laptop2-agent';

const AGENT = {
  slug: 'cursor-branarakic-laptop2',
  name: 'Cursor — branarakic (laptop 2)',
  kind: 'ai',
  framework: 'cursor',
  operator: 'branarakic',
  joinedAt: new Date().toISOString(),
  reputation: 'Second-machine Cursor agent for the two-laptop shared-memory demo. Runs against devnet node-2.',
};

const sink = createTripleSink();
const { emit } = sink;
const id = Agent.uri.agent(AGENT.slug);
emit(uri(id), uri(Common.type), uri(Agent.T.Agent));
emit(uri(id), uri(Common.type), uri(Agent.T.AIAgent));
emit(uri(id), uri(Common.name), lit(AGENT.name));
emit(uri(id), uri(Common.label), lit(AGENT.name));
emit(uri(id), uri(Agent.P.framework), lit(AGENT.framework));
emit(uri(id), uri(Agent.P.operator), uri(Agent.uri.agent(AGENT.operator)));
emit(uri(id), uri(Agent.P.joinedAt), lit(AGENT.joinedAt, XSD.dateTime));
emit(uri(id), uri(Agent.P.reputation), lit(AGENT.reputation));

console.log(`[laptop2-agent] Produced ${sink.size()} triples for ${id}.`);

const token = resolveToken(REPO_ROOT, { nodeId: NODE_ID });
const client = makeClient({ apiBase: API_BASE, token });
const cgId = await client.toCanonicalCgId(PROJECT_ID);
await client.ensureSubGraph(cgId, SUBGRAPH);
await client.writeAssertion(
  {
    contextGraphId: cgId,
    assertionName: ASSERTION_NAME,
    subGraphName: SUBGRAPH,
    triples: sink.triples,
  },
  { label: 'laptop2-agent' },
);
try {
  await client.promote({
    contextGraphId: cgId,
    assertionName: ASSERTION_NAME,
    subGraphName: SUBGRAPH,
    entities: [id],
  });
  console.log('[laptop2-agent] Promoted to SWM.');
} catch (err) {
  console.warn(`[laptop2-agent] Promote skipped: ${err.message}`);
}
console.log(`[laptop2-agent] Done. ${id} registered on ${API_BASE}.`);
