/**
 * ElizaOS Actions for DKG V9.
 *
 * Each action maps to a DKGAgent capability. The DKG node must be
 * running (via DKGService) before actions are invoked.
 */
import { requireAgent } from './service.js';
import type { Action, ChatTurnPersistOptions, IAgentRuntime, Memory, State, HandlerCallback } from './types.js';

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
 * itself.
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
 * chat-turn persistence MUST NOT go through the canonical
 * `agent.publish()` pipeline — that writes finalized data to the broadcast
 * data graph (and requires the CG to already exist on-chain), which means
 * every user/assistant message would be shipped to the network and charged
 * against KA/finalization semantics. Chat history belongs in the per-agent
 * working-memory assertion graph instead (`agent.assertion.write`), which
 * stays local to the node and satisfies the `view: 'working-memory'`
 * retrieval contract this hook advertises.
 *
 * fresh installs don't have a `chat` context graph. Before
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
 * a parallel ad-hoc shape. Keeping the constants
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
export const CHAT_AGENT_CONTEXT_GRAPH = 'agent-context';
export const CHAT_TURNS_ASSERTION = 'chat-turns';
const CHAT_NS = 'urn:dkg:chat:';
const SCHEMA_NS = 'http://schema.org/';
const DKG_ONT_NS = 'http://dkg.io/ontology/';
const RDF_TYPE_IRI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_DATETIME_IRI = 'http://www.w3.org/2001/XMLSchema#dateTime';
const CHAT_USER_ACTOR = `${CHAT_NS}actor:user`;
const CHAT_AGENT_ACTOR = `${CHAT_NS}actor:agent`;

type ChatQuad = { subject: string; predicate: string; object: string; graph: string };

/**
 * per-runtime tracker
 * of which `schema:Conversation` session roots have already been
 * emitted by THIS process. The canonical writer in
 * `packages/node-ui/src/chat-memory.ts` (search for `isNewSession`)
 * does the exact same guard for the exact same reason — re-emitting
 * `?session rdf:type schema:Conversation` on every turn trips DKG
 * Working-Memory Rule 4 (entity exclusivity) and rejects the second
 * persisted turn in the same room even though only the message
 * nodes are new. Per-runtime keying so two concurrent agents in the
 * same process do not silently suppress each other's session
 * declarations.
 *
 * Falls open after process restart by design: if the session root
 * was previously persisted and the WM read shows it, the in-process
 * tracker hasn't been rehydrated and we'll re-emit. The triple-store
 * deduplicates byte-identical `(s,p,o,g)` quads, so the re-emission
 * is a no-op write at the storage layer — the WM Rule-4 check fires
 * only on cross-call repetition within a single process, which is
 * exactly the case this cache is designed to cover.
 */
let emittedSessionRootsByRuntime: WeakMap<object, Set<string>> = new WeakMap();
let emittedSessionRootsAnon: Set<string> = new Set();

/**
 * the per-runtime cache MUST key
 * by the destination assertion graph as well as the session URI.
 *
 * Before this fix the cache used only `(runtime, sessionUri)`. That
 * suppressed `?session rdf:type schema:Conversation` on the FIRST
 * write of a given session and then happily dropped it from every
 * other destination this same runtime subsequently wrote the same
 * session to (e.g. a second context graph, a second assertion name,
 * or an operator rotating `DKG_CHAT_CG`). Readers like
 * `ChatMemoryManager` enumerate sessions by the `schema:Conversation`
 * type triple in the destination graph, so the second store became
 * invisible even though the message quads landed there.
 *
 * The fix composes the destination `(contextGraphId, assertionName)`
 * into the cache key so each (runtime, cg, assertion, sessionUri)
 * tuple emits its own root exactly once. The WM Rule-4 guard we
 * originally installed this cache for is ALSO still satisfied:
 * re-emitting the root within the SAME destination still short-circuits
 * on every subsequent turn.
 */
function sessionRootCacheKey(
  destContextGraphId: string,
  destAssertionName: string,
  sessionUri: string,
): string {
  return `${destContextGraphId}\u0000${destAssertionName}\u0000${sessionUri}`;
}

// the previous
// implementation marked the session root as emitted at the moment we
// DECIDED to emit it, before `ensureContextGraphLocal()` and
// `assertion.write()` had a chance to fail. If the persist threw,
// the cache was poisoned: any retry on the same room saw "already
// emitted", skipped the `schema:Conversation` root, and the room was
// permanently missing its session-root triple.
//
// actions.ts:460). The earlier fix
// split the cache into a peek (`wouldEmitSessionRoot`) + a
// post-success mark (`markSessionRootEmitted`). That preserved
// crash-safety BUT introduced a race window between the peek and
// the mark: two concurrent persists for the same
// `(runtime, sessionUri, contextGraphId, assertionName)` could
// both peek `false` (cache miss), both emit `schema:Conversation`,
// and the WM Rule-4 duplicate-root validator would reject the
// second write. Real symptoms: any client racing two concurrent
// chat-turn persists in the same room would intermittently see one
// of the writes fail with "duplicate root".
//
// The fix: replace the peek-then-mark-after-success pattern with
// reserve-before-await + rollback-on-failure.
//   - `reserveSessionRoot()` is a SYNCHRONOUS atomic CAS — at most
//     one concurrent caller wins the reservation per key, so only
//     ONE persist includes the root quads.
//   - On write failure the caller MUST call `rollbackSessionRoot()`
//     so the next retry re-emits (preserves r3131820483 crash-
//     safety).
//   - On write success the reservation stays in place (semantics:
//     emitted), so subsequent persists for the same key skip the
//     root quads.
//
// JavaScript is single-threaded so the reservation is genuinely
// atomic — no other event loop turn can interleave between the
// `has()` check and the `add()` call inside `reserveSessionRoot`.
function getSessionRootSeenSet(runtime: unknown): Set<string> {
  if (runtime !== null && typeof runtime === 'object') {
    let s = emittedSessionRootsByRuntime.get(runtime as object);
    if (!s) {
      s = new Set<string>();
      emittedSessionRootsByRuntime.set(runtime as object, s);
    }
    return s;
  }
  return emittedSessionRootsAnon;
}

/**
 * actions.ts:460). Synchronous atomic
 * check-and-set. Returns `true` ONLY for the caller that won the
 * reservation; that caller MUST emit the `schema:Conversation`
 * root quads AND, on a downstream write failure, MUST call
 * `rollbackSessionRoot()` to release the reservation so a retry
 * can re-emit.
 *
 * Concurrent callers (within the same JS event loop, before the
 * winner's await suspension) see `false` and SKIP the root — so
 * only ONE write carries the root quads, eliminating the
 * peek-then-emit race that previously tripped WM Rule-4 duplicate-
 * root validation under concurrent persist.
 */
function reserveSessionRoot(
  runtime: unknown,
  sessionUri: string,
  destContextGraphId: string,
  destAssertionName: string,
): boolean {
  const set = getSessionRootSeenSet(runtime);
  const key = sessionRootCacheKey(destContextGraphId, destAssertionName, sessionUri);
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

/**
 * actions.ts:460). Roll back a
 * `reserveSessionRoot()` reservation. Call this from the failure
 * path of any `agent.assertion.write()` (or earlier
 * `ensureContextGraphLocal()`) that would have written the
 * reserved root quads, so the NEXT retry can re-emit them.
 *
 * No-op if the key wasn't reserved by this caller (the Set's
 * `delete` is idempotent), so it's safe to call defensively.
 */
function rollbackSessionRoot(
  runtime: unknown,
  sessionUri: string,
  destContextGraphId: string,
  destAssertionName: string,
): void {
  const set = getSessionRootSeenSet(runtime);
  const key = sessionRootCacheKey(destContextGraphId, destAssertionName, sessionUri);
  set.delete(key);
}

/** Test-only: drop every recorded session-root emission. */
export function __resetEmittedSessionRootsForTests(): void {
  emittedSessionRootsByRuntime = new WeakMap();
  emittedSessionRootsAnon = new Set();
}

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
    // message subjects
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
    // joins work for both sides of a turn.
    { subject: assistantMsgUri, predicate: `${DKG_ONT_NS}turnId`, object: rdfString(turnKey), graph: '' },
  ];
}

/**
 * Stub user-message quads for the "headless assistant reply" case.
 * the current chat
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
  _sessionUri: string,
  ts: string,
  turnIdLiteral: string,
): ChatQuad[] {
  // deliberately NO
  // `schema:isPartOf` edge. The previous stub declared itself a
  // `schema:Message` partitioned into the session, which caused
  // `ChatMemoryManager.getSession()` to enumerate it alongside the
  // real user/assistant messages and the node-ui mapped it to an
  // "assistant" bubble (non-`user` author → assistant). That
  // inflated message counts and surfaced blank assistant turns in
  // every headless reply.
  //
  // The stub still needs to be a typed subject so the turn
  // envelope's `dkg:hasUserMessage` edge has something to point at
  // (the reader requires both edges to resolve a turn), but it must
  // NOT participate in session enumeration. Dropping `isPartOf`
  // achieves that while keeping the reader contract intact. We
  // also keep the explicit `dkg:headlessUserMessage "true"` marker
  // so any code path that does discover the stub via a turnId join
  // can filter it out.
  //
  // actions.ts:584): the previous
  // revision typed the stub as `schema:Message`. That prevented
  // session enumeration (we already dropped `isPartOf`), but
  // `ChatMemoryManager.getStats()` runs an UNCONDITIONAL `?s
  // rdf:type schema:Message` count to compute `messageCount`,
  // which is also fed into `chatRelatedTriples` for the
  // `knowledgeTriples = totalTriples - chatTriples` calculation.
  // Every stub therefore inflated `messageCount` by 1 AND
  // depressed `knowledgeTriples` by the stub's own quad count —
  // every headless turn double-counted in the message stat and
  // mis-attributed quads to "chat" instead of "knowledge".
  //
  // Fix: drop the `schema:Message` type entirely and replace it
  // with a dedicated `dkg:HeadlessUserStub` type. The `dkg:hasUserMessage`
  // join in the reader contract only needs the URI to exist as a
  // subject — it does NOT require a specific RDF type — so the
  // type swap is invisible to ChatMemoryManager.getSessionGraphDelta()
  // / .getSession(), but `getStats()` no longer counts the stub
  // as a `schema:Message`. The retained `dkg:headlessUserMessage
  // "true"` marker plus the new type give downstream readers two
  // independent ways to filter stubs out.
  return [
    { subject: userMsgUri, predicate: RDF_TYPE_IRI, object: `${DKG_ONT_NS}HeadlessUserStub`, graph: '' },
    // Distinct system actor so UIs that DO discover the stub via
    // some other path don't render a blank user bubble.
    { subject: userMsgUri, predicate: `${SCHEMA_NS}author`, object: `${DKG_ONT_NS}agent:system`, graph: '' },
    { subject: userMsgUri, predicate: `${SCHEMA_NS}dateCreated`, object: `${rdfString(ts)}^^<${XSD_DATETIME_IRI}>`, graph: '' },
    // Explicit empty text — readers that concatenate "user: …" skip it.
    { subject: userMsgUri, predicate: `${SCHEMA_NS}text`, object: rdfString(''), graph: '' },
    // the literal here is the DISTINCT headless turn id
    // (`headless:${turnKey}`), NOT the canonical `turnKey`. See the
    // r31-3 block in `buildHeadlessAssistantTurnEnvelopeQuads` for
    // the full rationale — keeping all three subjects (stub,
    // assistant msg, envelope) in the headless turn on the SAME
    // distinct id keeps `?msg dkg:turnId ?t . ?turn dkg:turnId ?t`
    // joins coherent without ever colliding with the canonical
    // user-first turn that may arrive on the same `turnKey` later.
    { subject: userMsgUri, predicate: `${DKG_ONT_NS}turnId`, object: rdfString(turnIdLiteral), graph: '' },
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
 * from a regular user-first turn at query time.
 */
function buildHeadlessAssistantTurnEnvelopeQuads(
  turnUri: string,
  sessionUri: string,
  turnIdLiteral: string,
  ts: string,
  userMsgUri: string,
  assistantMsgUri: string,
  characterName: string,
  userId: string,
  roomId: string,
): ChatQuad[] {
  // actions.ts:622): the previous
  // revision wrote `dkg:turnId = "${turnKey}"` here — i.e. the
  // canonical turn key with no prefix. Combined with the
  // `headless-turn:${turnKey}` URI shape that already kept the
  // SUBJECT distinct, that meant a session in which a headless
  // reply was persisted FIRST and the matching user-first turn
  // was replayed LATER ended up with TWO `dkg:ChatTurn` subjects
  // carrying the SAME `dkg:turnId` literal:
  //
  //   <headless-turn:K> rdf:type ChatTurn ; dkg:turnId "K"
  //   <turn:K>          rdf:type ChatTurn ; dkg:turnId "K"
  //
  // `ChatMemoryManager.getSessionGraphDelta()` resolves the
  // current turn with a `LIMIT 1` SPARQL on
  // `?turn dkg:turnId "K"`, so reads bound nondeterministically
  // to one or the other. Turn counts and watermarks drifted
  // across replays.
  //
  // Fix: the headless envelope writes a DISTINCT
  // `dkg:turnId = "headless:${turnKey}"` literal. The canonical
  // `${turnKey}` literal is reserved for the user-first turn (if
  // it ever arrives) and the `LIMIT 1` lookup-by-id is now
  // deterministic — `?turn dkg:turnId "K"` matches at most ONE
  // subject. Callers that want to address the headless envelope
  // by id pass `headless:K`; callers using the existing
  // `getSessionGraphDelta(sessionId, "K", …)` always get the
  // canonical user-first turn whenever it exists. Reader URI
  // resolution still works for both shapes (the resolver joins on
  // `dkg:turnId` literal — no hard-coded URI prefix) — only the
  // *id* changed, not the discovery contract.
  return [
    { subject: turnUri, predicate: RDF_TYPE_IRI, object: `${DKG_ONT_NS}ChatTurn`, graph: '' },
    { subject: turnUri, predicate: `${SCHEMA_NS}isPartOf`, object: sessionUri, graph: '' },
    { subject: turnUri, predicate: `${DKG_ONT_NS}turnId`, object: rdfString(turnIdLiteral), graph: '' },
    { subject: turnUri, predicate: `${SCHEMA_NS}dateCreated`, object: `${rdfString(ts)}^^<${XSD_DATETIME_IRI}>`, graph: '' },
    // Both edges present — reader contract (hasUserMessage AND
    // hasAssistantMessage) is satisfied.
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
 */
/**
 * Coerce a timestamp candidate (string | number) to a well-formed
 * ISO-8601 `xsd:dateTime` literal body, or `null` if no coercion is
 * possible. Returns just the lexical form (callers are responsible
 * for wrapping it in quotes + the `^^xsd:dateTime` type tag).
 *
 * Prior revisions
 * returned string timestamps verbatim and then emitted them under
 * `^^xsd:dateTime`. ElizaOS frequently serializes epoch milliseconds
 * as strings (`"1718049600000"`), so the rewritten quad became the
 * invalid literal `"1718049600000"^^xsd:dateTime` — which breaks
 * SPARQL ordering / FILTER, and drifts between readers. This helper
 * normalises every incoming shape (ms number, ms string, ISO string,
 * RFC-2822 string) to a real `Date.toISOString()` before we commit
 * it to the RDF layer.
 */
function coerceToIsoDateTime(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  // Accept a bare integer / float string as epoch milliseconds.
  // Reject exponent / leading-plus forms to stay conservative —
  // they're not produced by any standard ElizaOS serializer.
  if (/^-?\d+(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // Already looks like ISO-8601 with a date (YYYY-MM-DD) and a `T`
  // time component → trust after a round-trip through `Date` to
  // normalise timezone / fractional-seconds rendering.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  // Last resort: parse via `Date.parse` (handles RFC-2822 and some
  // locale strings). Anything still unparseable returns null so the
  // caller can fall through to the deterministic synthetic stamp.
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function resolveStableTurnTimestamp(
  message: unknown,
  optsAny: { ts?: string; timestamp?: string },
  turnSourceId: string,
): string {
  if (typeof optsAny.ts === 'string' && optsAny.ts.length > 0) {
    const iso = coerceToIsoDateTime(optsAny.ts);
    if (iso !== null) return iso;
  }
  if (typeof optsAny.timestamp === 'string' && optsAny.timestamp.length > 0) {
    const iso = coerceToIsoDateTime(optsAny.timestamp);
    if (iso !== null) return iso;
  }
  const m = message as {
    createdAt?: number | string;
    timestamp?: number | string;
    date?: string;
    ts?: string;
  } | null | undefined;
  if (m) {
    for (const candidate of [m.createdAt, m.timestamp, m.date, m.ts]) {
      if (candidate === undefined || candidate === null) continue;
      const iso = coerceToIsoDateTime(candidate);
      if (iso !== null) return iso;
    }
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
  // the full runtime surface lives in the public
  // `ChatTurnPersistOptions` type. We still accept `Record<string,
  // unknown>` at the entry point (matches ElizaOS' loose `options`
  // contract) but type the internal alias so every property access
  // below is compile-checked against the documented surface.
  const optsAny = options as Record<string, unknown> & ChatTurnPersistOptions;

  const mode = optsAny.mode ?? 'user-turn';
  const userId = (message as any).userId ?? 'anonymous';
  const roomId = (message as any).roomId ?? 'default';
  // whether the preceding
  // user-turn envelope (dkg:ChatTurn subject + real user Message +
  // hasUserMessage edge) has ALREADY been persisted. Previously this
  // was inferred from `!optsAny.userMessageId` alone, which conflates
  // two different things:
  //
  //   1. "do we know the parent user message id?" (addressing)
  //   2. "did the matching onChatTurn write succeed?" (durability)
  //
  // A caller can legitimately know (1) — typically the ElizaOS
  // runtime forwards the parent id automatically — while (2) failed
  // because the hook was disabled, the user-turn write errored, or a
  // reconnect replayed the assistant hook without a matching user
  // hook. Under the old rule we took the cheap append-only path,
  // wrote a lone `hasAssistantMessage` onto a turn URI that never got
  // typed, and the reader dropped the reply entirely.
  //
  // require the EXPLICIT
  // `userTurnPersisted` signal. The previous revision still fell
  // back to the legacy "presence of userMessageId === user turn
  // persisted" inference when the explicit flag was absent. That
  // conflates addressing (the runtime knows the parent id) with
  // durability (the matching onChatTurn write actually succeeded),
  // and the public catch-all overload
  // `persistChatTurn(..., options?: Record<string, unknown>)` lets
  // any external caller omit the flag and still take the append-
  // only branch — recreating the unreadable-reply bug whenever the
  // earlier user-turn write failed but the runtime still knew the
  // parent id (typical case: hook disabled, write errored, replay
  // after reconnect).
  //
  // New rule: append-only (`userTurnPersisted = true`) is selected
  // ONLY when the caller PROVES it by explicitly passing
  // `userTurnPersisted: true`. Anything else — explicit `false`,
  // omitted, or any non-boolean — fails closed to the safe full-
  // envelope/headless path that emits the user-stub + both edges so
  // the reader contract (`hasUserMessage` ∧ `hasAssistantMessage`)
  // is satisfied unconditionally. The in-process plugin caller
  // (`onAssistantReplyHandler`, r16-2) already plumbs a real boolean
  // here, so this only changes behaviour for ambiguous external
  // callers — and the change is in the safe direction.
  const userTurnPersistedRaw = optsAny.userTurnPersisted === true;
  // a `mem-${Date.now()}`
  // fallback is NOT stable: two separate calls for the same logical
  // message (e.g. retry, rebroadcast) would fabricate different turn
  // source ids, produce different `turnUri`s, and defeat the whole
  // idempotence contract this function advertises. Require a stable
  // id from the caller — explicit `userMessageId` for the assistant
  // path or `message.id` for the user-turn path. Throw loudly if
  // neither is present so the adapter boundary surfaces the missing
  // upstream contract instead of silently corrupting the chat graph.
  const rawMemoryId = (message as any)?.id;
  //
  // Pre-fix this only honoured `optsAny.userMessageId` on the
  // `assistant-reply` path. The user-turn path silently dropped any
  // pre-minted id and keyed `turnSourceId` off `message.id`. The
  // wrapper (`onChatTurnHandler`) however cached the persisted-turn
  // marker under `optsAny.userMessageId ?? message.id`,
  // explicitly to support hosts that pre-mint a user-turn id. The
  // result was a SILENT key mismatch: when a host did pre-mint
  // `userMessageId`, the cache said the turn existed under
  // `userMessageId` but the RDF was written under `message.id`, so
  // the matching `onAssistantReply` looked up the cache hit, took
  // the append-only path, and wrote `hasAssistantMessage` onto a
  // turn URI that didn't exist — making the reply unreadable.
  //
  // Honour `optsAny.userMessageId` on BOTH paths so the cache key
  // and the on-disk turn URI converge. The assistant-reply path
  // semantics are unchanged (it has always required this id); the
  // user-turn path now respects the pre-mint contract the comment
  // and the cache key already advertised.
  const explicitUserMessageId =
    typeof optsAny.userMessageId === 'string' && (optsAny.userMessageId as string).length > 0
      ? (optsAny.userMessageId as string)
      : undefined;
  // on the
  // append-only assistant path, falling back to `message.id`
  // (the assistant-reply Memory's own id) when `userMessageId`
  // is missing produces a `turnSourceId` based on the assistant
  // id rather than the user id. The append-only branch then
  // writes `hasAssistantMessage` onto a brand-new turn URI that
  // has no matching `hasUserMessage` edge, so the reader
  // (`getSessionGraphDelta`) never resolves it and the reply is
  // unreadable. The append-only path is ONLY safe when the
  // caller can prove BOTH (a) `userTurnPersisted: true` AND
  // (b) the user message id that the prior `onChatTurn` write
  // keyed the canonical turn under. Refuse to take the cheap
  // path when (b) is missing — fall through to the safe
  // headless full-envelope path that emits both edges on a
  // distinct headless turn URI (also fixed in r21-1).
  const userTurnPersisted =
    userTurnPersistedRaw
    && mode === 'assistant-reply'
    && typeof explicitUserMessageId === 'string'
    && explicitUserMessageId.length > 0;
  const headlessAssistantReply = mode === 'assistant-reply' && !userTurnPersisted;
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
  // keep the *canonical*
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
  // the headless
  // assistant-reply path MUST NOT mutate the canonical
  // `${CHAT_NS}turn:${turnKey}` subject. If the real user-turn
  // was actually persisted earlier (typical case: the caller
  // conservatively set `userTurnPersisted: false` after a
  // restart/replay even though the prior write succeeded), the
  // canonical turn already carries `dkg:hasUserMessage →
  // ${userMsgUri}` (the real user message). Stamping a SECOND
  // `dkg:hasUserMessage → ${userStubUri}` onto that same
  // canonical subject leaves the reader's
  // `SELECT ?u ?a WHERE { ?turn hasUserMessage ?u . ... } LIMIT 1`
  // free to bind the stub instead of the real user message —
  // resurrecting the blank-turn regression that round 8 / r15-2
  // / r20-1 already paid down.
  //
  // Fix: route the headless envelope onto a DEDICATED
  // `${CHAT_NS}headless-turn:` URI. The reader still discovers it
  // via `?turn rdf:type dkg:ChatTurn`, but the canonical
  // turn URI is left alone for the (potentially-already-
  // persisted) real user-turn. The two URIs cannot collide and
  // the `dkg:headlessTurn "true"` marker on the headless
  // envelope keeps it filterable at query time. Mirrors the
  // existing `msg:user:` ↔ `msg:user-stub:` separation r15-2
  // introduced.
  const headlessTurnUri = `${CHAT_NS}headless-turn:${turnKey}`;
  // `new Date().toISOString()`
  // broke idempotence. Re-firing onChatTurn / onAssistantReply for the
  // same message reuses the same {turnUri, userMsgUri, assistantMsgUri}
  // but would stamp a FRESH schema:dateCreated every time, so readers
  // that sort / dedupe by the timestamp saw duplicate/conflicting
  // entries for the same turn. Prefer a stable timestamp from the
  // hook/message payload; as a last resort derive one deterministically
  // from the turnSourceId so a retry is byte-identical with the
  // original write.
  const ts = resolveStableTurnTimestamp(message, optsAny, turnSourceId);
  // assistant timestamp
  // MUST sort strictly after the user message timestamp so clients
  // that order a turn by `schema:dateCreated` always see `user → agent`.
  // Adding +1ms is sufficient because we only store ISO-8601 with ms
  // precision and users don't produce >1 message per millisecond in
  // the same room. If the deterministic source timestamp is already at
  // the end of the representable range (extremely unlikely but cheap
  // to guard) we just reuse the user ts rather than wrap.
  const assistantTs = deriveAssistantTimestamp(ts);

  let quads: ChatQuad[];
  // tracked across both branches so we can
  // promote the session-root cache AFTER assertion.write() succeeds.
  let didIncludeSessionRoot = false;

  if (mode === 'assistant-reply') {
    // 2nd-pass A6: append-only assistant-reply path. When the caller
    // supplied `userMessageId` (the common case — onAssistantReply
    // fires after onChatTurn), we do NOT touch the user-message or
    // turn-metadata quads; those were emitted by the user-turn hook.
    // We only add the assistant Message subject and the single
    // dkg:hasAssistantMessage link onto the existing turn.
    //
    // When `userMessageId` is absent (a reply without a matching
    // user turn — e.g. proactive agent message, or the user-turn
    // hook was skipped), the turn envelope
    // does NOT exist yet, so we emit the full session + turn envelope
    // ourselves. We skip the user-message quads because there is no
    // user message, but we still produce a `dkg:ChatTurn` subject so
    // ChatMemoryManager queries filtered on `?turn a dkg:ChatTurn`
    // can find this reply.

    // actions.ts:1107 / actions.ts:1149):
    // the user-turn path can ALSO write the assistant leg when the
    // caller plumbs `assistantText` / `assistantReply.text` /
    // `state.lastAssistantReply`. If a separate `onAssistantReply`
    // hook then fires for the same turn, the append-only branch
    // below would re-emit `buildAssistantMessageQuads(...)` onto
    // the SAME `msg:agent:${turnKey}` URI, stacking duplicate
    // `schema:text` / `schema:dateCreated` / `schema:author` quads
    // (RDF predicates are multi-valued). Downstream `LIMIT 1`
    // queries against that subject would then bind nondeterministic
    // values for the reply text.
    //
    // The plugin wrapper (`onAssistantReplyHandler` in src/index.ts)
    // gates this at the boundary by consulting an in-process
    // `persistedAssistantMessages` cache and short-circuiting the
    // call entirely when the user-turn path already wrote the
    // assistant leg. Defence-in-depth here: also accept an explicit
    // `assistantAlreadyPersisted: true` option so direct callers
    // that don't go through the wrapper (`dkgService` /
    // `_dkgServiceLoose` users) get the same protection. Returning
    // a synthetic no-op result with `tripleCount: 0` and the
    // expected canonical turnUri is byte-equivalent to a successful
    // idempotent re-fire — which is exactly what this branch
    // semantically represents.
    if (optsAny.assistantAlreadyPersisted === true) {
      return {
        tripleCount: 0,
        turnUri: headlessAssistantReply ? headlessTurnUri : turnUri,
        kcId: '',
      };
    }

    // actions.ts:1172, KK3X).
    //
    // used `??` for the entire fallback chain. `??` only
    // bridges null/undefined — `''` is a defined-but-empty string and
    // SHORT-CIRCUITS the chain, so an assistant hook that delivers
    // the final text in `options.assistantText` /
    // `options.assistantReply.text` / `state.lastAssistantReply` and
    // leaves `message.content.text` as `''` (the real-world shape:
    // ElizaOS assistant memories often surface only `options.text`
    // when the runtime accepts the raw model output before stamping
    // the memory record) ended up persisting a BLANK
    // `schema:text` on the canonical `msg:agent:K` subject —
    // exactly the regression the documented fallback chain was
    // there to PREVENT.
    //
    // Fix: select the FIRST non-empty string in the chain, mirroring
    // the wrapper boundary (`onAssistantReplyHandler` in src/index.ts)
    // which already uses explicit length checks for the same reason.
    // A string is "non-empty" when it's a string AND has at least one
    // non-whitespace character — purely-whitespace text would still
    // be a degenerate reply payload and we'd rather fall back to the
    // next candidate than persist `"   "` as the final assistant
    // reply. If ALL candidates are empty/whitespace/missing the chain
    // collapses to `''` exactly as before (preserving the original
    // semantics for the fully-empty case — that branch is what the
    // r31-11 IoNQ guard actively short-circuits upstream of this
    // path; reaching here with an all-empty payload is degenerate
    // either way).
    const pickNonEmptyText = (...candidates: unknown[]): string => {
      for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        if (candidate.trim().length === 0) continue;
        return candidate;
      }
      return '';
    };
    const assistantText = pickNonEmptyText(
      (message as any)?.content?.text,
      optsAny.assistantText,
      optsAny.assistantReply?.text,
      (state as any)?.lastAssistantReply,
    );
    if (headlessAssistantReply) {
      // the reader in
      // `packages/node-ui/src/chat-memory.ts` requires BOTH
      // `dkg:hasUserMessage` AND `dkg:hasAssistantMessage` on a turn
      // or it returns `turn_not_found`. Emit a stub user Message so
      // the reader contract is satisfied, and drop the misleading
      // `dkg:replyTo` edge that the regular `buildAssistantMessageQuads`
      // adds (there is no real user message to reply to here — the
      // stub is a placeholder, not a user turn).
      //
      // the stub MUST NOT share
      // the canonical user-message URI (`msg:user:${turnKey}`). Under
      // the r14-2 default (`userTurnPersisted=false` when the caller
      // does not assert otherwise) we will enter the headless branch
      // EVEN IF `onChatTurn` already persisted the real user message —
      // the flag is opt-in precisely because the handler boundary has
      // no visibility into onChatTurn's outcome. If we then wrote the
      // stub quads onto the real user-message URI we would stack a
      // second `schema:author = agent:system` + empty `schema:text`
      // onto the real subject and corrupt the chat history (both
      // predicates are multi-valued in RDF, so the store keeps BOTH
      // the real user's author/text AND the stub's).
      //
      // actions.ts:1048): the previous
      // revision derived `stubTurnKey` from `rawMemoryId` (the
      // assistant memory's own id) "to keep the stub distinct from
      // the canonical msg:user URI". That distinctness is ALREADY
      // provided by the dedicated `msg:user-stub:` / `msg:agent-
      // headless:` namespace prefixes — adding the assistant id was
      // over-engineering that broke retry idempotence: when the
      // caller drives the headless path with a stable
      // `userMessageId` (so `turnKey` is stable across retries) but
      // the assistant Memory's `message.id` differs across
      // reconnects, every retry produced a FRESH `stubTurnKey` →
      // fresh `userStubUri` + fresh `headlessAssistantMsgUri`. The
      // canonical `headless-turn:${turnKey}` envelope (keyed on the
      // stable `turnKey`) then accumulated multiple
      // `dkg:hasUserMessage` / `dkg:hasAssistantMessage` edges, and
      // ChatMemoryManager.getSessionGraphDelta()'s `LIMIT 1` query
      // bound to an arbitrary stub/assistant pair → reads were
      // nondeterministic across replay.
      //
      // Fix: key BOTH the stub user-message URI AND the headless
      // assistant-message URI on the same `turnKey` the headless
      // envelope already uses. The `msg:user-stub:` / `msg:agent-
      // headless:` namespace prefixes are sufficient to keep the
      // stub from colliding with any canonical `msg:user:` /
      // `msg:agent:` URI for the same `turnKey`. Headless retries
      // are now byte-identical and `getSessionGraphDelta()` always
      // resolves to the same stub/assistant pair regardless of how
      // many times the assistant Memory id rotated.
      const userStubUri = `${CHAT_NS}msg:user-stub:${turnKey}`;
      const headlessAssistantMsgUri = `${CHAT_NS}msg:agent-headless:${turnKey}`;
      // actions.ts:622): the dkg:turnId
      // LITERAL stamped on every quad in the headless turn's
      // subject set is the DISTINCT `headless:${turnKey}` form,
      // NOT the canonical `${turnKey}`. Without this distinction
      // the LIMIT 1 SPARQL `?turn dkg:turnId "K"` lookup in
      // `ChatMemoryManager.getSessionGraphDelta()` would bind
      // nondeterministically to either the headless envelope or a
      // later-arriving canonical user-first turn (both would
      // carry the same literal). All three subjects in the
      // headless turn (stub user message, assistant message,
      // turn envelope) share this distinct literal so
      // `?msg dkg:turnId ?t . ?turn dkg:turnId ?t` joins remain
      // coherent within the headless turn while staying disjoint
      // from any canonical turn for the same `turnKey`.
      const headlessTurnIdLiteral = `headless:${turnKey}`;
      // actions.ts:1173): the headless
      // branch was reusing `buildAssistantMessageQuads(...)` verbatim,
      // which emits `?msg schema:isPartOf <session>`. That edge is
      // ALSO the predicate `ChatMemoryManager.getSession()` enumerates
      // messages on (`?m schema:isPartOf <sessionUri>` — see
      // `node-ui/src/chat-memory.ts`). When the canonical user-first
      // turn is later replayed for the same `turnKey`, the user-turn
      // path writes a SECOND assistant message at the canonical
      // `msg:agent:${turnKey}` URI, also session-scoped. Both messages
      // then surface in `getSession()` because their URIs differ
      // (`msg:agent-headless:${turnKey}` vs `msg:agent:${turnKey}`)
      // even though they represent the same logical reply — chat
      // history shows duplicates.
      //
      // Fix (split across writer + reader): tag the headless assistant
      // message with `dkg:headlessAssistantMessage "true"` here so the
      // reader can identify and dedupe it. The reader-side complement
      // is in `ChatMemoryManager.getSession()` (post-process bindings:
      // when a non-headless message exists for the same canonical
      // `turnKey` — extracted by stripping the `headless:` literal
      // prefix off `dkg:turnId` — drop the headless variant). We
      // deliberately leave the `schema:isPartOf` edge in place so a
      // headless reply that NEVER gets a canonical user-first turn
      // replay (the typical proactive-agent / recovery-path case) is
      // still surfaced by the standard session-enumeration query.
      // Dedupe activates only when BOTH variants exist for the same
      // canonical turn key.
      //
      // Mirrors the established `dkg:headlessUserMessage "true"`
      // marker on the user stub — the markers give downstream
      // consumers two independent ways to filter headless content
      // (URI namespace + explicit predicate).
      const assistantQuads = buildAssistantMessageQuads(
        headlessAssistantMsgUri,
        userStubUri,
        sessionUri,
        assistantTs,
        assistantText,
        headlessTurnIdLiteral,
      ).filter((q) => q.predicate !== `${DKG_ONT_NS}replyTo`);
      assistantQuads.push({
        subject: headlessAssistantMsgUri,
        predicate: `${DKG_ONT_NS}headlessAssistantMessage`,
        object: rdfString('true'),
        graph: '',
      });
      // adapter-elizaos/src/index.ts:521).
      //
      // When the matching user-turn write embedded a PROVISIONAL
      // assistant string (e.g. partial-streaming completion the host
      // parked on `assistantText` / `state.lastAssistantReply` before
      // the final reply landed) and the later `onAssistantReply`
      // brings DIFFERENT final text, the wrapper sets
      // `assistantSupersedesCanonical: true` and forces
      // `userTurnPersisted: false` to route the second write through
      // THIS branch — onto the distinct `msg:agent-headless:K` URI —
      // so we never stack a second `schema:text` triple on the
      // canonical `msg:agent:K` subject (the multi-valued RDF the
      // bot called out at index.ts:521).
      //
      // The marker tells the reader's r31-5 dedupe logic to INVERT
      // its preference for THIS turn key only: when both variants
      // exist AND the headless one is marked superseding, drop the
      // canonical (stale provisional) and surface the headless
      // (fresh final). Without this marker the dedupe would still
      // prefer the canonical, freezing stale text in chat history.
      // Headless-only writes (no canonical present) trivially keep
      // working — the marker is a no-op when there's no canonical
      // to suppress.
      if (optsAny.assistantSupersedesCanonical === true) {
        assistantQuads.push({
          subject: headlessAssistantMsgUri,
          predicate: `${DKG_ONT_NS}supersedesCanonicalAssistant`,
          object: rdfString('true'),
          graph: '',
        });
      }
      // synchronous atomic
      // reservation. Only the caller that wins the reservation
      // includes the root quads — concurrent persists for the same
      // (runtime, sessionUri, dest) skip the root, eliminating the
      // peek-then-emit race that previously tripped WM Rule-4
      // duplicate-root validation under concurrent load. On a write
      // failure we MUST `rollbackSessionRoot()` so a retry re-emits
      // (the rollback happens in the catch block below the await).
      didIncludeSessionRoot = reserveSessionRoot(
        runtime,
        sessionUri,
        contextGraphId,
        assertionName,
      );
      quads = [
        // only emit the session root the first time this
        // runtime sees this `sessionUri` in the current process.
        // Re-emitting `?session rdf:type schema:Conversation`
        // on every turn trips DKG WM Rule 4 (entity exclusivity)
        // and fails the second persisted turn in the same room.
        // scope by the destination (contextGraphId,
        // assertionName) so writing the same session into two
        // different stores still emits a `schema:Conversation`
        // root in BOTH places.
        ...(didIncludeSessionRoot
          ? buildSessionEntityQuads(sessionUri, sessionId)
          : []),
        ...buildHeadlessUserStubQuads(userStubUri, sessionUri, ts, headlessTurnIdLiteral),
        ...assistantQuads,
        ...buildHeadlessAssistantTurnEnvelopeQuads(
          // headless envelope MUST land on the dedicated
          // `headless-turn:` URI so it cannot pollute the
          // canonical `turn:` URI used by the user-first path.
          headlessTurnUri,
          sessionUri,
          // distinct `headless:${turnKey}` literal — see
          // the rationale block in `buildHeadlessAssistantTurnEnvelopeQuads`.
          headlessTurnIdLiteral,
          ts,
          userStubUri,
          headlessAssistantMsgUri,
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
    // actions.ts:1172, KK3X). Same
    // short-circuit hazard as the assistant-reply branch above:
    // `??` only bridges null/undefined, so an explicit `''` on
    // `optsAny.assistantText` (or `optsAny.assistantReply.text`)
    // would have suppressed the legitimate fallback to the next
    // candidate. In the user-turn path the symptom is different —
    // the `if (assistantText)` guard on line 1448 means an empty
    // first candidate causes the entire assistant leg to be
    // SILENTLY DROPPED even though `state.lastAssistantReply`
    // had the real text. Use the same first-non-empty selector
    // as the assistant-reply branch so the documented fallback
    // chain actually runs.
    const pickNonEmptyAssistantText = (...candidates: unknown[]): string => {
      for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        if (candidate.trim().length === 0) continue;
        return candidate;
      }
      return '';
    };
    const assistantText = pickNonEmptyAssistantText(
      optsAny.assistantText,
      optsAny.assistantReply?.text,
      (state as any)?.lastAssistantReply,
    );

    // synchronous atomic reservation.
    // See the rationale block above on the headless branch — same
    // semantics here. On a write failure we MUST
    // `rollbackSessionRoot()` so a retry re-emits.
    didIncludeSessionRoot = reserveSessionRoot(
      runtime,
      sessionUri,
      contextGraphId,
      assertionName,
    );
    quads = [
      // only emit the session root the first time this
      // runtime sees this `sessionUri` in the current process —
      // identical guard to the headless branch above and to the
      // canonical writer in `node-ui/src/chat-memory.ts:519`.
      // Re-emitting `?session rdf:type schema:Conversation` on
      // every turn trips DKG WM Rule 4 and rejects the second
      // persisted turn in the same room.
      // scope by the destination (contextGraphId,
      // assertionName) so the root re-emits in a second
      // store that has not yet received it.
      ...(didIncludeSessionRoot
        ? buildSessionEntityQuads(sessionUri, sessionId)
        : []),
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

  // actions.ts:460). The session-root
  // reservation was taken SYNCHRONOUSLY above before the first
  // await. If anything between here and `agent.assertion.write()`
  // throws (CG ensure, the assertion write itself), we MUST roll
  // the reservation back so the next retry re-emits the
  // `schema:Conversation` root quads. Otherwise the cache would
  // be poisoned: the retry would observe the (now-stale)
  // reservation, skip the root, and the room would permanently
  // lack its `schema:Conversation` triple — exactly the
  // r3131820483 regression the original split was designed to
  // avoid. The try/catch makes the failure path symmetric with
  // the success path's "reservation persists" semantics.
  try {
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
  } catch (err) {
    if (didIncludeSessionRoot) {
      rollbackSessionRoot(runtime, sessionUri, contextGraphId, assertionName);
    }
    throw err;
  }
  // with `reserveSessionRoot()` taking the
  // reservation synchronously above, the reservation IS the "this
  // root has been emitted" signal — so no post-success mark is
  // needed. The catch block above is the only place that releases
  // a reservation (write failure → retry should re-emit).
  // callers that take the headless assistant-reply path get
  // back the dedicated `headlessTurnUri` so any follow-up
  // attribution (e.g. `recordPersistedUserTurn`) keys against the
  // turn URI we actually wrote to. Returning `turnUri` here would
  // be a lie because we deliberately did NOT write anything onto
  // the canonical `turn:` subject in the headless branch.
  return {
    tripleCount: quads.length,
    turnUri: headlessAssistantReply ? headlessTurnUri : turnUri,
    kcId: '',
  };
}

/**
 * reversible URI-segment encoding. Replacing every non-[A-Za-z0-9_.-]
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
 * validate a
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
 * assistant reply
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
