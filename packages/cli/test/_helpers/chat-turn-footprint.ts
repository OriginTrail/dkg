/**
 * What one `(sessionId, turnId)` left in the node's `'chat-turns'` Working
 * Memory assertion, read back with SPARQL.
 *
 * Shared by the persist-turn integration tiers: the CLI e2e
 * (`openclaw-persist-turn.e2e.test.ts`, a real `DKGAgent` behind a real
 * `http.Server`) and the devnet suite (`devnet/openclaw-persist-turn`, live
 * daemons over HTTP). It has no imports, so the devnet package can load it by
 * relative path the way it already loads `packages/publisher/test/_helpers`.
 *
 * Why the footprint counts Messages and states rather than ChatTurn subjects:
 * a resend used to land on the turn's one subject, and the duplication it caused
 * is the extra user/assistant Message pair (fresh random ids each write), the
 * extra `hasUserMessage` / `hasAssistantMessage` objects on that turn, and a
 * second `persistenceState` literal. Counting those does not depend on how the
 * turn's subject is named.
 *
 * The turn is found through its session link and its `turnId` literal, never by
 * building the subject from the id. A turn written by the current code sits
 * under a subject scoped to `(sessionId, turnId)`, one written before that under
 * `urn:dkg:chat:turn:<turnId>` (which two sessions that reused an id shared),
 * and the footprint of a `(sessionId, turnId)` has to read the same for both.
 */

export const CHAT_NS = 'urn:dkg:chat:';
const SCHEMA = 'http://schema.org/';
const DKG_ONT = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

export interface ChatTurnFootprint {
  turns: number;
  messages: number;
  userMessages: number;
  assistantMessages: number;
  states: string[];
  transitions: Array<{ state: string; assistantReply: string }>;
}

/** One user + one assistant message, one turn subject, one recorded state. */
export const ONE_STORED_TURN: ChatTurnFootprint = {
  turns: 1,
  messages: 2,
  userMessages: 1,
  assistantMessages: 1,
  states: ['stored'],
  transitions: [],
};

/** Nothing written for the turn. */
export const NO_CHAT_TURN: ChatTurnFootprint = {
  turns: 0,
  messages: 0,
  userMessages: 0,
  assistantMessages: 0,
  states: [],
  transitions: [],
};

/** Strip an N-Triples literal (`"x"`, `"x"^^<dt>`) to its lexical form. */
export const lexicalTerm = (term: string | undefined): string => {
  const match = /^"((?:[^"\\]|\\.)*)"/.exec(term ?? '');
  return match ? match[1] : (term ?? '');
};

/** The six SELECTs whose result counts make up a footprint. */
export function chatTurnFootprintQueries(sessionId: string, turnId: string) {
  const session = `<${CHAT_NS}session:${sessionId}>`;
  const turnIdLiteral = JSON.stringify(turnId);
  // The turn subject(s) of this session that carry this turn id, whatever they are named.
  const turn = `?t <${RDF_TYPE}> <${DKG_ONT}ChatTurn> . ?t <${SCHEMA}isPartOf> ${session} . ?t <${DKG_ONT}turnId> ${turnIdLiteral}`;
  return {
    turns: `SELECT ?t WHERE { ${turn} }`,
    messages: `SELECT ?m WHERE { ?m <${RDF_TYPE}> <${SCHEMA}Message> . ?m <${SCHEMA}isPartOf> ${session} . ?m <${DKG_ONT}turnId> ${turnIdLiteral} }`,
    userMessages: `SELECT ?u WHERE { ${turn} . ?t <${DKG_ONT}hasUserMessage> ?u }`,
    assistantMessages: `SELECT ?a WHERE { ${turn} . ?t <${DKG_ONT}hasAssistantMessage> ?a }`,
    states: `SELECT ?s WHERE { ${turn} . ?t <${DKG_ONT}persistenceState> ?s }`,
    transitions: `SELECT ?x ?s ?r WHERE { ${turn} . ?x <${RDF_TYPE}> <${DKG_ONT}ChatTurnPersistenceTransition> . ?x <${DKG_ONT}updatesTurn> ?t . ?x <${DKG_ONT}persistenceState> ?s . OPTIONAL { ?x <${DKG_ONT}assistantReply> ?r } }`,
  };
}

/**
 * Everything one `(sessionId, turnId)` left in the chat-turns assertion.
 *
 * `select` runs one SELECT against that assertion and `lexical` turns one of
 * its result cells into a plain string, so each tier supplies its own query
 * transport and cell shape. `states` and `transitions` come back sorted: the
 * stores do not order rows.
 */
export async function readChatTurnFootprint<Cell>(
  select: (sparql: string) => Promise<Array<Record<string, Cell>>>,
  lexical: (cell: Cell | undefined) => string,
  sessionId: string,
  turnId: string,
): Promise<ChatTurnFootprint> {
  const queries = chatTurnFootprintQueries(sessionId, turnId);
  const [turns, messages, userMessages, assistantMessages, states, transitions] = await Promise.all([
    select(queries.turns),
    select(queries.messages),
    select(queries.userMessages),
    select(queries.assistantMessages),
    select(queries.states),
    select(queries.transitions),
  ]);
  return {
    turns: turns.length,
    messages: messages.length,
    userMessages: userMessages.length,
    assistantMessages: assistantMessages.length,
    states: states.map((row) => lexical(row.s)).sort(),
    transitions: transitions
      .map((row) => ({ state: lexical(row.s), assistantReply: lexical(row.r) }))
      .sort((a, b) => a.state.localeCompare(b.state)),
  };
}

/** The footprint of a turn first reported as `firstState` that completed by a `stored` transition carrying `reply`: still one exchange. */
export const completedByTransition = (firstState: 'pending' | 'failed', reply: string): ChatTurnFootprint => ({
  ...ONE_STORED_TURN,
  states: [firstState],
  transitions: [{ state: 'stored', assistantReply: reply }],
});

export interface GraphDeltaSummary {
  mode: string | undefined;
  /** The ChatTurn subjects in the delta. */
  turns: string[];
  /** The persistence state(s) carried by the turn subjects themselves. */
  turnStates: string[];
  messages: number;
  /** Each transition node (a resource that points at a turn) with its state, final reply and target. */
  transitions: Array<{ state: string; reply: string; target: string }>;
}

/**
 * What a graph delta (`GET /api/memory/sessions/:id/graph-delta`) says about one
 * turn: its subject(s) and their states, how many Messages it carries, and every
 * transition node with its state and reply. The delta is a slice of the graph, so
 * a turn that completed after it was first written has its first state on the
 * turn, one exchange, and the completion on a transition. A body that is not a
 * delta reads as `mode: undefined` with nothing else. Transitions come back
 * sorted: the stores do not order rows.
 */
export function summarizeGraphDelta(
  delta: { mode?: string; triples?: Array<{ subject: string; predicate: string; object: string }> } | null | undefined,
): GraphDeltaSummary {
  const triples = delta?.triples ?? [];
  const valuesOf = (subject: string, predicate: string) =>
    triples.filter((t) => t.subject === subject && t.predicate === predicate).map((t) => t.object);
  const subjectsOfType = (type: string) =>
    triples.filter((t) => t.predicate === RDF_TYPE && t.object === type).map((t) => t.subject);
  const turns = subjectsOfType(`${DKG_ONT}ChatTurn`).sort();
  return {
    mode: delta?.mode,
    turns,
    turnStates: turns.flatMap((turn) => valuesOf(turn, `${DKG_ONT}persistenceState`)).sort(),
    messages: subjectsOfType(`${SCHEMA}Message`).length,
    transitions: subjectsOfType(`${DKG_ONT}ChatTurnPersistenceTransition`)
      .map((subject) => ({
        state: valuesOf(subject, `${DKG_ONT}persistenceState`)[0],
        reply: valuesOf(subject, `${DKG_ONT}assistantReply`)[0],
        target: valuesOf(subject, `${DKG_ONT}updatesTurn`)[0],
      }))
      .sort((a, b) => `${a.state}${a.reply}`.localeCompare(`${b.state}${b.reply}`)),
  };
}
