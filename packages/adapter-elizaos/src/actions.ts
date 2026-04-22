/**
 * ElizaOS Actions for DKG V9.
 *
 * Each action maps to a DKGAgent capability. The DKG node must be
 * running (via DKGService) before actions are invoked.
 */
import { requireAgent } from './service.js';
import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from './types.js';

function hasSetting(runtime: IAgentRuntime, key: string): boolean {
  return !!runtime.getSetting(key);
}

export const dkgPublish: Action = {
  name: 'DKG_PUBLISH',
  similes: ['PUBLISH_TO_DKG', 'STORE_KNOWLEDGE', 'ADD_TO_GRAPH'],
  description: 'Publish knowledge (RDF triples) to the OriginTrail Decentralized Knowledge Graph.',

  validate: async (runtime: IAgentRuntime) => hasSetting(runtime, 'DKG_DATA_DIR') || true,

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<boolean> => {
    try {
      const agent = requireAgent();
      const text = message.content.text;

      const contextGraphMatch = text.match(/context[- ]?graph[:\s]+["']?([^\s"']+)/i)
        ?? text.match(/paranet[:\s]+["']?([^\s"']+)/i);
      const contextGraphId = contextGraphMatch?.[1] ?? 'default';

      const nquadsMatch = text.match(/```(?:nquads|n-quads|turtle)?\s*([\s\S]*?)```/i);
      if (!nquadsMatch) {
        callback({ text: 'Please provide N-Quads triples in a code block to publish.' });
        return false;
      }

      const quads = parseNQuads(nquadsMatch[1]);
      if (quads.length === 0) {
        callback({ text: 'No valid triples found in the code block.' });
        return false;
      }

      const result = await agent.publish(contextGraphId, quads as any);
      callback({
        text: `Published ${quads.length} triple(s) to context graph "${contextGraphId}". KC ID: ${result.kcId}, KAs: ${result.kaManifest.length}`,
      });
      return true;
    } catch (err: any) {
      callback({ text: `DKG publish failed: ${err.message}` });
      return false;
    }
  },

  examples: [
    [
      { user: '{{user1}}', content: { text: 'publish this to DKG:\n```nquads\n<http://ex.org/alice> <http://schema.org/name> "Alice" .\n```', action: 'DKG_PUBLISH' } },
      { user: '{{user2}}', content: { text: 'Published 1 triple(s) to context graph "default".' } },
    ],
  ],
};

export const dkgQuery: Action = {
  name: 'DKG_QUERY',
  similes: ['QUERY_DKG', 'SEARCH_KNOWLEDGE', 'SPARQL_QUERY', 'ASK_DKG'],
  description: 'Query the DKG knowledge graph using SPARQL.',

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<boolean> => {
    try {
      const agent = requireAgent();
      const text = message.content.text;

      const sparqlMatch = text.match(/```(?:sparql)?\s*([\s\S]*?)```/i)
        ?? text.match(/(SELECT\s[\s\S]+)/i);
      if (!sparqlMatch) {
        callback({ text: 'Please provide a SPARQL query (in a code block or inline).' });
        return false;
      }

      const result = await agent.query(sparqlMatch[1].trim());
      const bindings = result.bindings;
      if (bindings.length === 0) {
        callback({ text: 'Query returned no results.' });
      } else {
        const formatted = bindings.slice(0, 20).map(row =>
          Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(', '),
        ).join('\n');
        callback({
          text: `Query returned ${bindings.length} result(s):\n${formatted}${bindings.length > 20 ? '\n... (truncated)' : ''}`,
        });
      }
      return true;
    } catch (err: any) {
      callback({ text: `DKG query failed: ${err.message}` });
      return false;
    }
  },

  examples: [
    [
      { user: '{{user1}}', content: { text: 'query the DKG:\n```sparql\nSELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10\n```', action: 'DKG_QUERY' } },
      { user: '{{user2}}', content: { text: 'Query returned 10 result(s):' } },
    ],
  ],
};

export const dkgFindAgents: Action = {
  name: 'DKG_FIND_AGENTS',
  similes: ['DISCOVER_AGENTS', 'FIND_AGENT', 'SEARCH_AGENTS', 'LIST_AGENTS'],
  description: 'Discover AI agents on the DKG network by skill or framework.',

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<boolean> => {
    try {
      const agent = requireAgent();
      const text = message.content.text.toLowerCase();

      const skillMatch = text.match(/skill[:\s]+["']?([^\s"']+)/i);
      if (skillMatch) {
        const offerings = await agent.findSkills({ skillType: skillMatch[1] });
        if (offerings.length === 0) {
          callback({ text: `No agents found offering skill "${skillMatch[1]}".` });
        } else {
          const list = offerings.map(o =>
            `- ${o.agentName}: ${o.skillType} (${o.pricePerCall ?? 0} ${o.currency ?? 'TRAC'})`,
          ).join('\n');
          callback({ text: `Found ${offerings.length} agent(s) with that skill:\n${list}` });
        }
        return true;
      }

      const frameworkMatch = text.match(/framework[:\s]+["']?(\w+)/i);
      const agents = await agent.findAgents(
        frameworkMatch ? { framework: frameworkMatch[1] } : undefined,
      );
      if (agents.length === 0) {
        callback({ text: 'No agents found on the network.' });
      } else {
        const list = agents.map(a =>
          `- ${a.name} (${a.peerId.slice(0, 12)}...): ${a.framework ?? 'unknown'}`,
        ).join('\n');
        callback({ text: `Found ${agents.length} agent(s):\n${list}` });
      }
      return true;
    } catch (err: any) {
      callback({ text: `Agent discovery failed: ${err.message}` });
      return false;
    }
  },

  examples: [
    [
      { user: '{{user1}}', content: { text: 'find agents with skill: ImageAnalysis', action: 'DKG_FIND_AGENTS' } },
      { user: '{{user2}}', content: { text: 'Found 2 agent(s) with that skill:' } },
    ],
  ],
};

export const dkgSendMessage: Action = {
  name: 'DKG_SEND_MESSAGE',
  similes: ['MESSAGE_AGENT', 'CHAT_AGENT', 'DM_AGENT'],
  description: 'Send an encrypted message to another DKG agent.',

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<boolean> => {
    try {
      const agent = requireAgent();
      const text = message.content.text;

      const peerMatch = text.match(/peer[:\s]+["']?([^\s"']+)/i);
      if (!peerMatch) {
        callback({ text: 'Please specify a peer ID to message.' });
        return false;
      }

      const msgMatch = text.match(/message[:\s]+["'](.+?)["']/i)
        ?? text.match(/say[:\s]+["'](.+?)["']/i);
      const msgText = msgMatch?.[1] ?? text.replace(/.*peer[:\s]+["']?[^\s"']+["']?\s*/i, '').trim();

      const result = await agent.sendChat(peerMatch[1], msgText);
      if (result.delivered) {
        callback({ text: `Message delivered to ${peerMatch[1].slice(0, 12)}...` });
      } else {
        callback({ text: `Message delivery failed: ${result.error ?? 'unknown error'}` });
      }
      return true;
    } catch (err: any) {
      callback({ text: `Message send failed: ${err.message}` });
      return false;
    }
  },

  examples: [
    [
      { user: '{{user1}}', content: { text: 'message peer: 12D3KooW... say: "Hello!"', action: 'DKG_SEND_MESSAGE' } },
      { user: '{{user2}}', content: { text: 'Message delivered to 12D3KooW...' } },
    ],
  ],
};

export const dkgInvokeSkill: Action = {
  name: 'DKG_INVOKE_SKILL',
  similes: ['CALL_SKILL', 'USE_SKILL', 'RUN_SKILL', 'INVOKE_AGENT'],
  description: 'Invoke a remote agent skill on the DKG network.',

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<boolean> => {
    try {
      const agent = requireAgent();
      const text = message.content.text;

      const peerMatch = text.match(/peer[:\s]+["']?([^\s"']+)/i);
      const skillMatch = text.match(/skill[:\s]+["']?([^\s"']+)/i);
      if (!peerMatch || !skillMatch) {
        callback({ text: 'Please specify both a peer ID and skill URI.' });
        return false;
      }

      const inputMatch = text.match(/input[:\s]+["'](.+?)["']/i)
        ?? text.match(/```([\s\S]*?)```/);
      const input = inputMatch?.[1] ?? '';

      const response = await agent.invokeSkill(
        peerMatch[1],
        skillMatch[1],
        new TextEncoder().encode(input),
      );

      if (response.success && response.outputData) {
        callback({ text: `Skill response: ${new TextDecoder().decode(response.outputData)}` });
      } else {
        callback({ text: `Skill invocation ${response.success ? 'ok' : 'failed'}: ${response.error ?? 'no output'}` });
      }
      return true;
    } catch (err: any) {
      callback({ text: `Skill invocation failed: ${err.message}` });
      return false;
    }
  },

  examples: [
    [
      { user: '{{user1}}', content: { text: 'invoke skill: ImageAnalysis on peer: 12D3KooW... input: "analyze this"', action: 'DKG_INVOKE_SKILL' } },
      { user: '{{user2}}', content: { text: 'Skill response: ...' } },
    ],
  ],
};

/**
 * DKG_PERSIST_CHAT_TURN — fulfils spec §09A_FRAMEWORK_ADAPTERS chat-turn
 * persistence contract. Stores the user message + assistant reply (when
 * present) into the agent's working-memory graph as RDF triples so that
 * downstream queries can recover the chat history through the DKG node
 * itself. See BUGS_FOUND.md K-11.
 */
export const dkgPersistChatTurn: Action = {
  name: 'DKG_PERSIST_CHAT_TURN',
  similes: ['STORE_CHAT_TURN', 'PERSIST_CHAT', 'STORE_CHAT', 'RECORD_TURN', 'SAVE_CHAT_TURN'],
  description:
    'Persist a chat turn (user message + assistant reply) into the DKG ' +
    'working-memory graph so it can be retrieved later via SPARQL.',

  validate: async () => true,

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: Record<string, unknown>,
    callback: HandlerCallback,
  ): Promise<boolean> => {
    try {
      const agent = requireAgent();
      const result = await persistChatTurnImpl(agent, runtime, message, state, options);
      callback({ text: `Chat turn persisted (${result.tripleCount} triples).` });
      return true;
    } catch (err: any) {
      callback({ text: `Chat turn persist failed: ${err.message}` });
      return false;
    }
  },

  examples: [
    [
      { user: '{{user1}}', content: { text: 'remember this conversation', action: 'DKG_PERSIST_CHAT_TURN' } },
      { user: '{{user2}}', content: { text: 'Chat turn persisted.' } },
    ],
  ],
};

/**
 * Minimal agent contract required by {@link persistChatTurnImpl}.
 *
 * Bot review A1/A3: chat-turn persistence MUST NOT go through the canonical
 * `agent.publish()` pipeline — that writes finalized data to the broadcast
 * data graph (and requires the CG to already exist on-chain), which means
 * every user/assistant message would be shipped to the network and charged
 * against KA/finalization semantics. Chat history belongs in the per-agent
 * working-memory assertion graph instead (`agent.assertion.write`), which
 * stays local to the node and satisfies the `view: 'working-memory'`
 * retrieval contract this hook advertises.
 *
 * Bot review A2: fresh installs don't have a `chat` context graph. Before
 * writing we best-effort call `ensureContextGraphLocal` so the CG exists
 * locally (this is idempotent if it already exists) and won't throw on
 * the first turn persisted. In production this method is on `DKGAgent`;
 * tests may omit it and the ensure step becomes a no-op.
 *
 * The tuple type is deliberately wide so unit tests can plug in a capturing
 * fake without booting a real DKGAgent (libp2p + chain + storage are
 * validated end-to-end by the downstream integration suites).
 */
export interface ChatTurnPersistenceAgent {
  assertion: {
    write: (
      contextGraphId: string,
      name: string,
      quads: Array<{ subject: string; predicate: string; object: string; graph?: string }>,
      opts?: { subGraphName?: string },
    ) => Promise<void>;
  };
  ensureContextGraphLocal?: (opts: {
    id: string;
    name: string;
    description?: string;
    curated?: boolean;
  }) => Promise<void>;
}

/**
 * Canonical chat-turn vocabulary, copied from
 * `packages/node-ui/src/chat-memory.ts` so this adapter does NOT introduce
 * a parallel ad-hoc shape (bot review A* second pass). Keeping the constants
 * here avoids a hard dep on `dkg-node-ui` (which would cycle), but the
 * IRIs MUST match `chat-memory.ts` byte-for-byte so `ChatMemoryManager` and
 * the node-ui session view can read these turns immediately.
 *
 *   AGENT_CONTEXT_GRAPH      -> 'agent-context'
 *   CHAT_TURNS_ASSERTION     -> 'chat-turns'
 *   CHAT_NS                  -> 'urn:dkg:chat:'
 *   SCHEMA                   -> 'http://schema.org/'
 *   DKG_ONT                  -> 'http://dkg.io/ontology/'
 */
const CHAT_AGENT_CONTEXT_GRAPH = 'agent-context';
const CHAT_TURNS_ASSERTION = 'chat-turns';
const CHAT_NS = 'urn:dkg:chat:';
const SCHEMA_NS = 'http://schema.org/';
const DKG_ONT_NS = 'http://dkg.io/ontology/';
const RDF_TYPE_IRI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_DATETIME_IRI = 'http://www.w3.org/2001/XMLSchema#dateTime';
const CHAT_USER_ACTOR = `${CHAT_NS}actor:user`;
const CHAT_AGENT_ACTOR = `${CHAT_NS}actor:agent`;

type ChatQuad = { subject: string; predicate: string; object: string; graph: string };

function buildSessionEntityQuads(sessionUri: string, sessionId: string): ChatQuad[] {
  return [
    { subject: sessionUri, predicate: RDF_TYPE_IRI, object: `${SCHEMA_NS}Conversation`, graph: '' },
    { subject: sessionUri, predicate: `${DKG_ONT_NS}sessionId`, object: rdfString(sessionId), graph: '' },
  ];
}

function buildUserMessageQuads(
  userMsgUri: string,
  sessionUri: string,
  ts: string,
  userText: string,
  turnKey: string,
): ChatQuad[] {
  return [
    { subject: userMsgUri, predicate: RDF_TYPE_IRI, object: `${SCHEMA_NS}Message`, graph: '' },
    { subject: userMsgUri, predicate: `${SCHEMA_NS}isPartOf`, object: sessionUri, graph: '' },
    { subject: userMsgUri, predicate: `${SCHEMA_NS}author`, object: CHAT_USER_ACTOR, graph: '' },
    { subject: userMsgUri, predicate: `${SCHEMA_NS}dateCreated`, object: `${rdfString(ts)}^^<${XSD_DATETIME_IRI}>`, graph: '' },
    { subject: userMsgUri, predicate: `${SCHEMA_NS}text`, object: rdfString(userText), graph: '' },
    // Bot review PR #229 round 6, actions.ts:388 — message subjects
    // carry the canonical `dkg:turnId` too so SPARQL readers that join
    // `?msg dkg:turnId ?t . ?turn dkg:turnId ?t` (instead of walking
    // `schema:isPartOf` + inverse `dkg:hasUserMessage`) can locate the
    // enclosing turn without an extra hop. Keeps the RDF shape flat
    // and round-trippable against ChatMemoryManager queries.
    { subject: userMsgUri, predicate: `${DKG_ONT_NS}turnId`, object: rdfString(turnKey), graph: '' },
  ];
}

function buildAssistantMessageQuads(
  assistantMsgUri: string,
  userMsgUri: string,
  sessionUri: string,
  ts: string,
  assistantText: string,
  turnKey: string,
): ChatQuad[] {
  return [
    { subject: assistantMsgUri, predicate: RDF_TYPE_IRI, object: `${SCHEMA_NS}Message`, graph: '' },
    { subject: assistantMsgUri, predicate: `${SCHEMA_NS}isPartOf`, object: sessionUri, graph: '' },
    { subject: assistantMsgUri, predicate: `${SCHEMA_NS}author`, object: CHAT_AGENT_ACTOR, graph: '' },
    { subject: assistantMsgUri, predicate: `${SCHEMA_NS}dateCreated`, object: `${rdfString(ts)}^^<${XSD_DATETIME_IRI}>`, graph: '' },
    { subject: assistantMsgUri, predicate: `${SCHEMA_NS}text`, object: rdfString(assistantText), graph: '' },
    { subject: assistantMsgUri, predicate: `${DKG_ONT_NS}replyTo`, object: userMsgUri, graph: '' },
    // See `buildUserMessageQuads` — same `dkg:turnId` shape so reader
    // joins work for both sides of a turn (bot review round 6).
    { subject: assistantMsgUri, predicate: `${DKG_ONT_NS}turnId`, object: rdfString(turnKey), graph: '' },
  ];
}

/**
 * Stub user-message quads for the "headless assistant reply" case.
 * PR #229 bot review round 8 (actions.ts:746): the current chat
 * reader contract in `packages/node-ui/src/chat-memory.ts` requires
 * BOTH `dkg:hasUserMessage` AND `dkg:hasAssistantMessage` to be
 * present on a turn (it does a single `SELECT ?user ?assistant
 * WHERE { ?turn hasUserMessage ?user . ?turn hasAssistantMessage
 * ?assistant }` join, and returns `turn_not_found` when either side
 * is missing). Before this, headless assistant replies — proactive
 * agent messages, recovery-path assistant sends, cases where the
 * user-turn hook was suppressed — produced a turn the reader could
 * not find at all.
 *
 * To keep the reader contract untouched (it is also used by
 * ChatMemoryManager incremental sync) we emit a stub
 * `schema:Message` for the user side, flagged with
 * `dkg:headlessUserMessage "true"` so downstream consumers that care
 * about the distinction can filter on it. Body is empty and author
 * is `dkg:agent:system` — explicitly NOT `CHAT_USER_ACTOR` — so a
 * naïve consumer that displays user messages doesn't render a blank
 * user turn. The stub still carries the canonical `turnKey` via
 * `dkg:turnId` so the one-hop join that round 6 added keeps working.
 */
function buildHeadlessUserStubQuads(
  userMsgUri: string,
  sessionUri: string,
  ts: string,
  turnKey: string,
): ChatQuad[] {
  return [
    { subject: userMsgUri, predicate: RDF_TYPE_IRI, object: `${SCHEMA_NS}Message`, graph: '' },
    { subject: userMsgUri, predicate: `${SCHEMA_NS}isPartOf`, object: sessionUri, graph: '' },
    // Distinct system actor so UIs don't render a blank user bubble.
    { subject: userMsgUri, predicate: `${SCHEMA_NS}author`, object: `${DKG_ONT_NS}agent:system`, graph: '' },
    { subject: userMsgUri, predicate: `${SCHEMA_NS}dateCreated`, object: `${rdfString(ts)}^^<${XSD_DATETIME_IRI}>`, graph: '' },
    // Explicit empty text — readers that concatenate "user: …" skip it.
    { subject: userMsgUri, predicate: `${SCHEMA_NS}text`, object: rdfString(''), graph: '' },
    { subject: userMsgUri, predicate: `${DKG_ONT_NS}turnId`, object: rdfString(turnKey), graph: '' },
    // Headless marker — consumers that want to filter these out can.
    { subject: userMsgUri, predicate: `${DKG_ONT_NS}headlessUserMessage`, object: rdfString('true'), graph: '' },
  ];
}

/**
 * Variant of `buildTurnEnvelopeQuads` for the "headless assistant
 * reply" case (no user message, no user-turn hook). Emits the full
 * `dkg:ChatTurn` envelope (type, session link, turnId, timestamp,
 * BOTH hasUserMessage and hasAssistantMessage, eliza provenance) so
 * the node-ui / ChatMemoryManager reader — which requires BOTH edges
 * to resolve a turn — finds the reply. The user side points at the
 * stub emitted by {@link buildHeadlessUserStubQuads}. Marked
 * `dkg:headlessTurn "true"` so the turn itself is distinguishable
 * from a regular user-first turn at query time. See bot review PR
 * #229, actions.ts:517 / actions.ts:746.
 */
function buildHeadlessAssistantTurnEnvelopeQuads(
  turnUri: string,
  sessionUri: string,
  turnKey: string,
  ts: string,
  userMsgUri: string,
  assistantMsgUri: string,
  characterName: string,
  userId: string,
  roomId: string,
): ChatQuad[] {
  return [
    { subject: turnUri, predicate: RDF_TYPE_IRI, object: `${DKG_ONT_NS}ChatTurn`, graph: '' },
    { subject: turnUri, predicate: `${SCHEMA_NS}isPartOf`, object: sessionUri, graph: '' },
    { subject: turnUri, predicate: `${DKG_ONT_NS}turnId`, object: rdfString(turnKey), graph: '' },
    { subject: turnUri, predicate: `${SCHEMA_NS}dateCreated`, object: `${rdfString(ts)}^^<${XSD_DATETIME_IRI}>`, graph: '' },
    // Both edges present — reader contract (hasUserMessage AND
    // hasAssistantMessage) is satisfied (PR #229 round 8).
    { subject: turnUri, predicate: `${DKG_ONT_NS}hasUserMessage`, object: userMsgUri, graph: '' },
    { subject: turnUri, predicate: `${DKG_ONT_NS}hasAssistantMessage`, object: assistantMsgUri, graph: '' },
    { subject: turnUri, predicate: `${DKG_ONT_NS}headlessTurn`, object: rdfString('true'), graph: '' },
    { subject: turnUri, predicate: `${DKG_ONT_NS}elizaUserId`, object: rdfString(userId), graph: '' },
    { subject: turnUri, predicate: `${DKG_ONT_NS}elizaRoomId`, object: rdfString(roomId), graph: '' },
    { subject: turnUri, predicate: `${DKG_ONT_NS}agentName`, object: rdfString(characterName), graph: '' },
  ];
}

/**
 * Resolve a STABLE timestamp for the turn / message quads so a hook
 * that re-fires for the same message produces byte-identical quads
 * (same `schema:dateCreated` value), preserving the idempotence the
 * surrounding code relies on. Preference order:
 *   1. explicit override via `options.ts` (if supplied by the caller),
 *   2. the ElizaOS memory's own `createdAt` (ms since epoch) or
 *      a string `date`/`timestamp`/`ts` field if present,
 *   3. a deterministic timestamp derived from the turnSourceId — the
 *      exact same source id will always map to the exact same
 *      ISO-8601 value across process restarts.
 *
 * The third case is a degraded fallback for test doubles / synthetic
 * callers that don't carry a clock. It is NOT a real wall-clock — it
 * is a stable *identifier* formatted as an ISO-8601 string so the
 * downstream `xsd:dateTime` literal is well-formed.
 *
 * See bot review PR #229, actions.ts:539.
 */
function resolveStableTurnTimestamp(
  message: unknown,
  optsAny: { ts?: string; timestamp?: string },
  turnSourceId: string,
): string {
  if (typeof optsAny.ts === 'string' && optsAny.ts.length > 0) return optsAny.ts;
  if (typeof optsAny.timestamp === 'string' && optsAny.timestamp.length > 0) return optsAny.timestamp;
  const m = message as {
    createdAt?: number | string;
    timestamp?: number | string;
    date?: string;
    ts?: string;
  } | null | undefined;
  if (m) {
    if (typeof m.createdAt === 'number' && Number.isFinite(m.createdAt)) {
      return new Date(m.createdAt).toISOString();
    }
    if (typeof m.createdAt === 'string' && m.createdAt.length > 0) return m.createdAt;
    if (typeof m.timestamp === 'number' && Number.isFinite(m.timestamp)) {
      return new Date(m.timestamp).toISOString();
    }
    if (typeof m.timestamp === 'string' && m.timestamp.length > 0) return m.timestamp;
    if (typeof m.date === 'string' && m.date.length > 0) return m.date;
    if (typeof m.ts === 'string' && m.ts.length > 0) return m.ts;
  }
  // Deterministic fallback: hash the turn source id → bounded integer
  // → ISO-8601 string. This is NOT meaningful as a wall-clock; it is a
  // stable *synthetic* value so a retry collides byte-for-byte with
  // the original write.
  const seed = String(turnSourceId);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  }
  // Map into a safe 32-bit-epoch range centred on 2020-01-01 so the
  // resulting Date is valid and stable.
  const base = Date.UTC(2020, 0, 1);
  return new Date(base + (h % 63113904000)).toISOString();
}

function buildTurnEnvelopeQuads(
  turnUri: string,
  sessionUri: string,
  turnKey: string,
  ts: string,
  userMsgUri: string,
  assistantMsgUri: string | null,
  characterName: string,
  userId: string,
  roomId: string,
): ChatQuad[] {
  const quads: ChatQuad[] = [
    { subject: turnUri, predicate: RDF_TYPE_IRI, object: `${DKG_ONT_NS}ChatTurn`, graph: '' },
    { subject: turnUri, predicate: `${SCHEMA_NS}isPartOf`, object: sessionUri, graph: '' },
    { subject: turnUri, predicate: `${DKG_ONT_NS}turnId`, object: rdfString(turnKey), graph: '' },
    { subject: turnUri, predicate: `${SCHEMA_NS}dateCreated`, object: `${rdfString(ts)}^^<${XSD_DATETIME_IRI}>`, graph: '' },
    { subject: turnUri, predicate: `${DKG_ONT_NS}hasUserMessage`, object: userMsgUri, graph: '' },
    // ElizaOS-specific provenance kept in the same DKG_ONT namespace so
    // ChatMemoryManager queries (which only look at schema:* and dkg:*)
    // ignore them but they remain queryable for adapter-level tooling.
    { subject: turnUri, predicate: `${DKG_ONT_NS}elizaUserId`, object: rdfString(userId), graph: '' },
    { subject: turnUri, predicate: `${DKG_ONT_NS}elizaRoomId`, object: rdfString(roomId), graph: '' },
    { subject: turnUri, predicate: `${DKG_ONT_NS}agentName`, object: rdfString(characterName), graph: '' },
  ];
  if (assistantMsgUri) {
    quads.push({
      subject: turnUri,
      predicate: `${DKG_ONT_NS}hasAssistantMessage`,
      object: assistantMsgUri,
      graph: '',
    });
  }
  return quads;
}

/** Shared implementation used by the action AND the dkgService.persistChatTurn / hooks.onChatTurn surface.
 *
 *  Bot review A1–A7 + second-pass follow-ups:
 *    - A1/A3: writes via `agent.assertion.write` (WM path) instead of
 *             `agent.publish` (broadcast/finalization path).
 *    - A2:    lazily ensures the target CG exists locally so fresh
 *             installs don't throw.
 *    - A3:    builds real `Quad[]` (with `graph: ''`; the publisher
 *             rewrites this to the real assertion graph URI).
 *    - A4:    emits `rdf:type` objects as bare IRIs (publisher wraps).
 *    - A5:    `encodeURIComponent`-based reversible turn-key encoding so
 *             `room/a` and `room:a` don't collide.
 *    - 2nd-pass A6: separate user-turn vs assistant-reply paths. The
 *             previous "merge" implementation forwarded the assistant
 *             `Memory` straight into `persistChatTurnImpl`, which read
 *             `message.content.text` as `userMessage` — corrupting the
 *             turn whenever `onAssistantReply` fired. The new contract is
 *             that `options.mode === 'assistant-reply'` (set by the
 *             onAssistantReply hook) emits ONLY the assistant message
 *             quads + a single `dkg:hasAssistantMessage` link onto the
 *             existing turn envelope. Repeat fires of the user hook for
 *             the same `message.id` are also idempotent because every
 *             quad is keyed by the deterministic `turnKey`.
 *    - 2nd-pass A4 (RDF shape): emits the canonical
 *             `schema:Conversation` / `schema:Message` / `dkg:ChatTurn`
 *             shape that `node-ui/src/chat-memory.ts` reads. The previous
 *             `https://schema.origintrail.io/dkg/v10/ChatTurn` predicates
 *             were invisible to ChatMemoryManager / node-ui session views.
 *    - 2nd-pass A5 (default CG): defaults to the canonical
 *             `agent-context` context graph (the same constant
 *             `ChatMemoryManager.AGENT_CONTEXT_GRAPH` uses) so writes are
 *             readable out-of-the-box without setting `DKG_CHAT_CG`.
 *             Operators that set `DKG_CHAT_CG`/`options.contextGraphId`
 *             keep their explicit override.
 */
export async function persistChatTurnImpl(
  agent: ChatTurnPersistenceAgent,
  runtime: IAgentRuntime,
  message: Memory,
  state: State,
  options: Record<string, unknown>,
): Promise<{ tripleCount: number; turnUri: string; kcId: string }> {
  const optsAny = options as Record<string, unknown> & {
    contextGraphId?: string;
    assistantText?: string;
    assistantReply?: { text?: string };
    assertionName?: string;
    /**
     * Routing flag set by the dedicated `onAssistantReply` hook handler
     * in `index.ts`. When `'assistant-reply'`, the impl skips re-emitting
     * the user-message + turn-envelope quads and only writes the assistant
     * message + the link onto the existing turn. Default `'user-turn'`.
     */
    mode?: 'user-turn' | 'assistant-reply';
    /**
     * Optional override for the source-of-truth message id when the
     * assistant-reply hook fires with a different memory id than the
     * user-turn hook. Lets onAssistantReply target the same `turnUri`.
     */
    userMessageId?: string;
    /**
     * Optional stable timestamp override — bot review PR #229 follow-up
     * on actions.ts:539. When the hook is re-fired for the same memory
     * (network retry, ElizaOS re-emitting an event on reconnect, test
     * harness repeating a call) callers can pin the timestamp so the
     * rewritten quads are byte-identical with the originals. Accepts
     * either `ts` or `timestamp` (alias) for DX parity with the hook
     * payload types. If neither is supplied we derive a stable value
     * from the underlying message; see `resolveStableTurnTimestamp`.
     */
    ts?: string;
    timestamp?: string;
  };

  const mode = optsAny.mode ?? 'user-turn';
  const userId = (message as any).userId ?? 'anonymous';
  const roomId = (message as any).roomId ?? 'default';
  // For assistant-reply mode, prefer the user message id if the caller
  // passed it explicitly so we hit the same turnUri. Otherwise fall back
  // to the assistant memory's own id — in which case the 'assistant-
  // reply' code path below emits the FULL ChatTurn envelope (not just
  // the hasAssistantMessage link) so the reply is discoverable by
  // readers that filter on `?turn a dkg:ChatTurn` even without a
  // matching user-turn hook.
  //
  // Bot review (PR #229 follow-up, actions.ts:517): the previous revision
  // fell through to the append-only path on this fallback, which wrote
  // ONLY the assistant message + `dkg:hasAssistantMessage` link onto a
  // turnUri that had no ChatTurn / dkg:hasUserMessage quads — the
  // ChatMemoryManager queries that filter `?turn a dkg:ChatTurn` then
  // dropped the reply entirely. We now track whether we're on that
  // fallback so the write path below can emit the turn envelope.
  const headlessAssistantReply =
    mode === 'assistant-reply' && !optsAny.userMessageId;
  // Bot review PR #229 round 6, actions.ts:635 — a `mem-${Date.now()}`
  // fallback is NOT stable: two separate calls for the same logical
  // message (e.g. retry, rebroadcast) would fabricate different turn
  // source ids, produce different `turnUri`s, and defeat the whole
  // idempotence contract this function advertises. Require a stable
  // id from the caller — explicit `userMessageId` for the assistant
  // path or `message.id` for the user-turn path. Throw loudly if
  // neither is present so the adapter boundary surfaces the missing
  // upstream contract instead of silently corrupting the chat graph.
  const rawMemoryId = (message as any)?.id;
  const explicitUserMessageId = mode === 'assistant-reply' ? optsAny.userMessageId : undefined;
  const turnSourceId = explicitUserMessageId
    ?? (typeof rawMemoryId === 'string' && rawMemoryId.length > 0 ? rawMemoryId : undefined);
  if (!turnSourceId) {
    throw new Error(
      'persistChatTurnImpl: missing stable message identifier — ' +
      'either options.userMessageId (assistant-reply path) or message.id ' +
      '(user-turn path) MUST be provided. Refusing to fabricate a time-based ' +
      'id because it would break idempotence across retries.',
    );
  }
  const characterName = runtime.character?.name ?? runtime.getSetting('DKG_AGENT_NAME') ?? 'elizaos-agent';
  const contextGraphId = optsAny.contextGraphId
    ?? runtime.getSetting('DKG_CHAT_CG')
    ?? CHAT_AGENT_CONTEXT_GRAPH;
  const assertionName = optsAny.assertionName
    ?? runtime.getSetting('DKG_CHAT_ASSERTION')
    ?? CHAT_TURNS_ASSERTION;

  // Deterministic per-room/per-message turn key so re-fires are idempotent
  // and so onAssistantReply can target the same turnUri/userMsgUri/
  // assistantMsgUri the user-turn hook produced.
  const turnKey = `${encodeIriSegment(roomId)}:${encodeIriSegment(turnSourceId)}`;
  const sessionId = String(roomId);
  // Bot review PR #229 round 6, actions.ts:649 — keep the *canonical*
  // session URI byte-identical to what `ChatMemoryManager` / node-ui
  // read. That reader composes `${CHAT_NS}session:${sessionId}` with
  // the raw session id (roomId) and filters SPARQL binding comparisons
  // against that exact string. `encodeIriSegment` (which is
  // `encodeURIComponent` under the hood) mutates common room id shapes
  // like `room:a` → `room%3Aa` and would silently fork the graph into
  // two disjoint session subjects depending on whether the writer or
  // reader encoded first. We still run the same sessionId through
  // assertSafeSessionId below so a hostile roomId (angle brackets,
  // quotes, whitespace) does NOT reach the N-Quads serializer.
  const sessionUri = `${CHAT_NS}session:${assertSafeSessionId(sessionId)}`;
  const userMsgUri = `${CHAT_NS}msg:user:${turnKey}`;
  const assistantMsgUri = `${CHAT_NS}msg:agent:${turnKey}`;
  const turnUri = `${CHAT_NS}turn:${turnKey}`;
  // Bot review (PR #229 follow-up, actions.ts:539): `new Date().toISOString()`
  // broke idempotence. Re-firing onChatTurn / onAssistantReply for the
  // same message reuses the same {turnUri, userMsgUri, assistantMsgUri}
  // but would stamp a FRESH schema:dateCreated every time, so readers
  // that sort / dedupe by the timestamp saw duplicate/conflicting
  // entries for the same turn. Prefer a stable timestamp from the
  // hook/message payload; as a last resort derive one deterministically
  // from the turnSourceId so a retry is byte-identical with the
  // original write.
  const ts = resolveStableTurnTimestamp(message, optsAny, turnSourceId);
  // Bot review PR #229 round 6, actions.ts:662 — assistant timestamp
  // MUST sort strictly after the user message timestamp so clients
  // that order a turn by `schema:dateCreated` always see `user → agent`.
  // Adding +1ms is sufficient because we only store ISO-8601 with ms
  // precision and users don't produce >1 message per millisecond in
  // the same room. If the deterministic source timestamp is already at
  // the end of the representable range (extremely unlikely but cheap
  // to guard) we just reuse the user ts rather than wrap.
  const assistantTs = deriveAssistantTimestamp(ts);

  let quads: ChatQuad[];

  if (mode === 'assistant-reply') {
    // 2nd-pass A6: append-only assistant-reply path. When the caller
    // supplied `userMessageId` (the common case — onAssistantReply
    // fires after onChatTurn), we do NOT touch the user-message or
    // turn-metadata quads; those were emitted by the user-turn hook.
    // We only add the assistant Message subject and the single
    // dkg:hasAssistantMessage link onto the existing turn.
    //
    // When `userMessageId` is absent (bot review actions.ts:517: a
    // reply without a matching user turn — e.g. proactive agent
    // message, or the user-turn hook was skipped), the turn envelope
    // does NOT exist yet, so we emit the full session + turn envelope
    // ourselves. We skip the user-message quads because there is no
    // user message, but we still produce a `dkg:ChatTurn` subject so
    // ChatMemoryManager queries filtered on `?turn a dkg:ChatTurn`
    // can find this reply.
    const assistantText = (message as any)?.content?.text
      ?? optsAny.assistantText
      ?? optsAny.assistantReply?.text
      ?? (state as any)?.lastAssistantReply
      ?? '';
    if (headlessAssistantReply) {
      // PR #229 bot review round 8 (actions.ts:746): the reader in
      // `packages/node-ui/src/chat-memory.ts` requires BOTH
      // `dkg:hasUserMessage` AND `dkg:hasAssistantMessage` on a turn
      // or it returns `turn_not_found`. Emit a stub user Message so
      // the reader contract is satisfied, and drop the misleading
      // `dkg:replyTo` edge that the regular `buildAssistantMessageQuads`
      // adds (there is no real user message to reply to here — the
      // stub is a placeholder, not a user turn).
      const assistantQuads = buildAssistantMessageQuads(
        assistantMsgUri,
        userMsgUri,
        sessionUri,
        assistantTs,
        assistantText,
        turnKey,
      ).filter((q) => q.predicate !== `${DKG_ONT_NS}replyTo`);
      quads = [
        ...buildSessionEntityQuads(sessionUri, sessionId),
        ...buildHeadlessUserStubQuads(userMsgUri, sessionUri, ts, turnKey),
        ...assistantQuads,
        ...buildHeadlessAssistantTurnEnvelopeQuads(
          turnUri,
          sessionUri,
          turnKey,
          ts,
          userMsgUri,
          assistantMsgUri,
          characterName,
          userId,
          roomId,
        ),
      ];
    } else {
      quads = [
        ...buildAssistantMessageQuads(assistantMsgUri, userMsgUri, sessionUri, assistantTs, assistantText, turnKey),
        { subject: turnUri, predicate: `${DKG_ONT_NS}hasAssistantMessage`, object: assistantMsgUri, graph: '' },
      ];
    }
  } else {
    // user-turn path: emit (idempotently) the session entity, the user
    // message, the turn envelope, and (if the same call has captured an
    // assistant reply on `state` / `options`) the assistant message.
    const userText = message.content?.text ?? '';
    const assistantText =
      optsAny.assistantText
      ?? optsAny.assistantReply?.text
      ?? (state as any)?.lastAssistantReply
      ?? '';

    quads = [
      ...buildSessionEntityQuads(sessionUri, sessionId),
      ...buildUserMessageQuads(userMsgUri, sessionUri, ts, userText, turnKey),
    ];
    if (assistantText) {
      quads.push(...buildAssistantMessageQuads(assistantMsgUri, userMsgUri, sessionUri, assistantTs, assistantText, turnKey));
    }
    quads.push(
      ...buildTurnEnvelopeQuads(
        turnUri,
        sessionUri,
        turnKey,
        ts,
        userMsgUri,
        assistantText ? assistantMsgUri : null,
        characterName,
        userId,
        roomId,
      ),
    );
  }

  // A2: best-effort lazy CG ensure. If the CG already exists this is a
  // cheap no-op; if the agent doesn't expose the method (unit tests) we
  // skip and let assertionWrite surface a real error. We intentionally do
  // NOT register on-chain here — that's a separate explicit operation.
  if (typeof agent.ensureContextGraphLocal === 'function') {
    await agent.ensureContextGraphLocal({
      id: contextGraphId,
      name: contextGraphId,
      description: 'ElizaOS chat-turn persistence (canonical schema:Conversation / schema:Message shape)',
      curated: true,
    });
  }

  // A1/A3: write into the per-agent WM assertion graph, not the
  // broadcast data graph.
  await agent.assertion.write(contextGraphId, assertionName, quads);
  return { tripleCount: quads.length, turnUri, kcId: '' };
}

/**
 * Bot review A5: reversible URI-segment encoding. Replacing every non-[A-Za-z0-9_.-]
 * byte with `_` is lossy — `room/a` and `room:a` both collapse to `room_a`,
 * silently merging distinct rooms (or distinct messages) onto the same
 * `turnUri`. `encodeURIComponent` is round-trippable via `decodeURIComponent`
 * and keeps percent-encoded chars IRI-safe for our `urn:dkg:` scheme.
 *
 * We leave the legacy `escapeIri` export in place for back-compat with
 * any callers still importing it (none in-tree), but route chat-turn
 * encoding through `encodeIriSegment`.
 */
function encodeIriSegment(s: string): string {
  // Keep `.`, `-`, `_` unescaped (they're safe in our URN scheme);
  // everything else goes through encodeURIComponent.
  return encodeURIComponent(String(s));
}

/**
 * Bot review PR #229 round 6, actions.ts:649 companion — validate a
 * raw session id (roomId) before it's dropped verbatim into the
 * canonical `urn:dkg:chat:session:<id>` IRI. We MUST NOT run it
 * through `encodeURIComponent` (that forks the graph from readers),
 * but we also MUST NOT trust it blindly — characters forbidden in
 * N-Quads subjects would corrupt the N-Quads serializer downstream
 * and could smuggle a second triple onto the same line. Reject
 * whitespace, angle brackets, quotes, and control characters; pass
 * everything else through unchanged so colons / slashes / dots in
 * natural room ids (e.g. `room:alpha`, `org/room`) round-trip.
 */
function assertSafeSessionId(sessionId: string): string {
  const s = String(sessionId);
  if (s.length === 0) {
    throw new Error('persistChatTurnImpl: sessionId (roomId) must be non-empty');
  }
  if (/[\s<>"\\`\u0000-\u001f\u007f]/.test(s)) {
    throw new Error(
      `persistChatTurnImpl: sessionId "${s}" contains characters forbidden ` +
      'in an N-Quads IRI segment (whitespace, angle brackets, quotes, or ' +
      'controls). Choose a room id that is safe to drop verbatim into a ' +
      '`urn:dkg:chat:session:` URI.',
    );
  }
  return s;
}

/**
 * Bot review PR #229 round 6, actions.ts:662 — assistant reply
 * timestamp MUST sort strictly after the user message timestamp on
 * the same turn so downstream readers that order by
 * `schema:dateCreated` always observe `user → agent`. We add +1ms.
 * If the parsed user timestamp is unparseable or would overflow the
 * JS Date range, fall back to the user timestamp verbatim so the
 * write still succeeds (the overall RDF remains queryable even if
 * the relative order is unstable in that extreme edge case).
 */
function deriveAssistantTimestamp(userTs: string): string {
  const ms = Date.parse(userTs);
  if (!Number.isFinite(ms)) return userTs;
  const bumped = ms + 1;
  if (!Number.isFinite(bumped)) return userTs;
  try {
    return new Date(bumped).toISOString();
  } catch {
    return userTs;
  }
}

function escapeIri(s: string): string {
  // Back-compat shim (intentionally unused by persistChatTurnImpl now).
  // Kept to avoid breaking hypothetical external importers. Consider
  // removing in the next breaking release.
  void encodeIriSegment; // silence linters that flag unused helper pairs
  return String(s).replace(/[^A-Za-z0-9_.-]/g, '_');
}

function rdfString(s: string): string {
  const escaped = String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

function parseNQuads(text: string): Array<{ subject: string; predicate: string; object: string; graph?: string }> {
  const quads: Array<{ subject: string; predicate: string; object: string; graph?: string }> = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^<([^>]+)>\s+<([^>]+)>\s+("[^"]*(?:\\.[^"]*)*"(?:@\w+|(?:\^\^<[^>]+>))?|<[^>]+>)\s*(?:<([^>]+)>)?\s*\.?\s*$/);
    if (!match) continue;
    quads.push({
      subject: match[1],
      predicate: match[2],
      object: match[3].startsWith('<') ? match[3].slice(1, -1) : match[3],
      graph: match[4],
    });
  }
  return quads;
}
