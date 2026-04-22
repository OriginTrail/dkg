#!/usr/bin/env node
/**
 * Synthetic chat-turn writer for the Phase 4 two-machines smoke test.
 *
 * Simulates what the capture-chat.mjs hook would emit when the second-
 * machine user types something at their Cursor. Writes a minimal
 * `chat:Session` + `chat:Turn` via the canonical assertion-write path,
 * promotes to SWM, and prints the turn URI.
 *
 * Defaults target devnet node-2 (port 9202) and attribute to the laptop2
 * agent so a subsequent `dkg_get_chat` on node-1 proves cross-node
 * gossip replication — the headline demo claim.
 *
 * Usage:
 *   node scripts/send-test-chat-turn.mjs
 *   node scripts/send-test-chat-turn.mjs --prompt="tree-sitter for python?" --reply="..."
 *   node scripts/send-test-chat-turn.mjs --api=http://localhost:9201 --agent=cursor-branarakic
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient, parseArgs, resolveToken } from './lib/dkg-daemon.mjs';
import { Agent, createTripleSink, uri, lit } from './lib/ontology.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const args = parseArgs();
const API_BASE = (args.api ?? process.env.DEVNET_API ?? 'http://localhost:9202').replace(/\/$/, '');
const NODE_ID = Number(args['node-id'] ?? process.env.DEVNET_NODE_ID ?? 2);
const PROJECT_ID = args.project ?? 'dkg-code-project';
const SUBGRAPH = args.subgraph ?? 'chat';
const ASSERTION_NAME = args.assertion ?? 'chat-log';
const AGENT_SLUG = args.agent ?? 'cursor-branarakic-laptop2';
const SESSION_ID = args.session ?? `phase4-smoke-${Date.now()}`;
const PROMPT = args.prompt
  ?? 'Phase 4 smoke test — can node-1 see this turn via gossip from node-2?';
const REPLY = args.reply
  ?? 'If you are reading this via dkg_get_chat on node-1, then yes: cross-node SWM gossip is working. Attribution should read "Cursor — branarakic (laptop 2)".';

const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  schema: 'http://schema.org/',
  dcterms: 'http://purl.org/dc/terms/',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  prov: 'http://www.w3.org/ns/prov#',
  chat: 'http://dkg.io/ontology/chat/',
};
const T = { Session: NS.chat + 'Session', Turn: NS.chat + 'Turn' };
const P = {
  type: NS.rdf + 'type',
  label: NS.rdfs + 'label',
  name: NS.schema + 'name',
  created: NS.dcterms + 'created',
  modified: NS.dcterms + 'modified',
  attributed: NS.prov + 'wasAttributedTo',
  inSession: NS.chat + 'inSession',
  turnIndex: NS.chat + 'turnIndex',
  userPrompt: NS.chat + 'userPrompt',
  assistantResponse: NS.chat + 'assistantResponse',
  speakerTool: NS.chat + 'speakerTool',
};

const sessionUri = `urn:dkg:chat:session:${SESSION_ID}`;
const turnUri = `${sessionUri}#turn:1`;
const agentUri = Agent.uri.agent(AGENT_SLUG);
const now = new Date().toISOString();

const sink = createTripleSink();
const { emit } = sink;

emit(uri(sessionUri), uri(P.type), uri(T.Session));
emit(uri(sessionUri), uri(P.label), lit(`Smoke ${SESSION_ID}`));
emit(uri(sessionUri), uri(P.name), lit(`Smoke ${SESSION_ID}`));
emit(uri(sessionUri), uri(P.created), lit(now, NS.xsd + 'dateTime'));
emit(uri(sessionUri), uri(P.attributed), uri(agentUri));
emit(uri(sessionUri), uri(P.speakerTool), lit('cursor'));

emit(uri(turnUri), uri(P.type), uri(T.Turn));
emit(uri(turnUri), uri(P.label), lit(`Turn 1 of ${SESSION_ID}`));
emit(uri(turnUri), uri(P.inSession), uri(sessionUri));
emit(uri(turnUri), uri(P.turnIndex), lit(1, NS.xsd + 'integer'));
emit(uri(turnUri), uri(P.created), lit(now, NS.xsd + 'dateTime'));
emit(uri(turnUri), uri(P.modified), lit(now, NS.xsd + 'dateTime'));
emit(uri(turnUri), uri(P.attributed), uri(agentUri));
emit(uri(turnUri), uri(P.userPrompt), lit(PROMPT));
emit(uri(turnUri), uri(P.assistantResponse), lit(REPLY));
emit(uri(turnUri), uri(P.speakerTool), lit('cursor'));

console.log(`[smoke] Produced ${sink.size()} triples for ${turnUri}.`);

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
  { label: 'smoke-turn' },
);
try {
  await client.promote({
    contextGraphId: cgId,
    assertionName: ASSERTION_NAME,
    subGraphName: SUBGRAPH,
    entities: [sessionUri, turnUri],
  });
  console.log('[smoke] Promoted session + turn to SWM.');
} catch (err) {
  console.warn(`[smoke] Promote skipped: ${err.message}`);
}

console.log(`[smoke] DONE
  api:         ${API_BASE}
  agent:       ${agentUri}
  session URI: ${sessionUri}
  turn URI:    ${turnUri}`);
