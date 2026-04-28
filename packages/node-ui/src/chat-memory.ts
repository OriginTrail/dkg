import { isSafeIri } from '@origintrail-official/dkg-core';
import { LlmClient } from './llm/client.js';
import type { LlmConfig } from './llm/types.js';

export interface MemoryToolContext {
  query: (
    sparql: string,
    opts?: {
      contextGraphId?: string;
      graphSuffix?: '_shared_memory';
      includeSharedMemory?: boolean;
      view?: 'working-memory' | 'shared-working-memory' | 'verified-memory';
      agentAddress?: string;
      assertionName?: string;
      subGraphName?: string;
    },
  ) => Promise<any>;
  /**
   * Direct SWM write primitive. Retained on the context so callers that
   * legitimately want Shared Working Memory semantics (e.g. user-initiated
   * promotion to a project's shared memory) have access to it, but chat-turn
   * and per-project memory writes use `writeAssertion` instead.
   */
  share: (contextGraphId: string, quads: any[], opts?: { localOnly?: boolean; subGraphName?: string }) => Promise<{ shareOperationId: string }>;
  /**
   * Create a per-agent Working Memory assertion graph. Idempotent: "already
   * exists" is resolved quietly, any other error surfaces.
   */
  createAssertion: (
    contextGraphId: string,
    name: string,
    opts?: { subGraphName?: string },
  ) => Promise<{ assertionUri: string | null; alreadyExists: boolean }>;
  /** Append quads into an existing Working Memory assertion graph. */
  writeAssertion: (
    contextGraphId: string,
    name: string,
    quads: any[],
    opts?: { subGraphName?: string },
  ) => Promise<{ written: number }>;
  publishFromSharedMemory: (
    contextGraphId: string,
    selection: 'all' | { rootEntities: string[] },
    opts?: { clearSharedMemoryAfter?: boolean },
  ) => Promise<any>;
  createContextGraph: (opts: { id: string; name: string; description?: string; private?: boolean }) => Promise<void>;
  listContextGraphs: () => Promise<any[]>;
}

/** Options passed to ChatMemoryManager at construction time. */
export interface ChatMemoryManagerOptions {
  /**
   * The attached agent's address. Used as the `agentAddress` field on
   * `view: 'working-memory'` queries so the query engine can route reads
   * to the correct per-agent assertion graph. Defaults to `undefined`
   * during tests / scripts; the daemon passes the node peer ID at runtime.
   */
  agentAddress?: string;
  /**
   * Target context graph for chat-turn persistence. Defaults to
   * `'agent-context'`. Tests and scripts can override.
   */
  contextGraphId?: string;
  /**
   * Assertion name for chat-turn persistence. Defaults to `'chat-turns'`.
   */
  assertionName?: string;
}

export interface MemoryStats {
  contextGraphId: string;
  initialized: boolean;
  messageCount: number;
  knowledgeTriples: number;
  totalTriples: number;
  sessionCount: number;
  entityCount: number;
}

export interface MemoryEntity {
  uri: string;
  type: string;
  label: string;
  properties: Array<{ predicate: string; object: string }>;
  sourceSession?: string;
}

export interface PublishFromSwmResult {
  kcId?: bigint;
  ual?: string;
  status: string;
  tripleCount: number;
}

export interface SessionPublicationStatus {
  sessionId: string;
  sharedMemoryTripleCount: number;
  dataTripleCount: number;
  scope: 'shared_memory_only' | 'published' | 'published_with_pending' | 'empty';
  rootEntityCount: number;
}

export interface SessionPublishResult extends PublishFromSwmResult {
  sessionId: string;
  rootEntityCount: number;
  publication: SessionPublicationStatus;
}

export interface SessionGraphDeltaWatermark {
  baseTurnId: string | null;
  previousTurnId: string | null;
  appliedTurnId: string | null;
  latestTurnId: string | null;
  turnIndex: number;
  turnCount: number;
}

export interface SessionGraphDeltaResult {
  mode: 'delta' | 'full_refresh_required';
  reason?: 'session_empty' | 'turn_not_found' | 'missing_watermark' | 'watermark_mismatch';
  sessionId: string;
  turnId: string;
  watermark: SessionGraphDeltaWatermark;
  triples: Array<{ subject: string; predicate: string; object: string }>;
}

const IMPORT_SOURCES = ['claude', 'chatgpt', 'gemini', 'other'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export interface ImportResultQuad {
  subject: string;
  predicate: string;
  object: string;
}

export interface ImportResult {
  batchId: string | null;
  source: ImportSource;
  memoryCount: number;
  tripleCount: number;
  entityCount: number;
  quads: ImportResultQuad[];
  quadsTruncated?: boolean;
  warnings?: string[];
}

/**
 * Chat-turn persistence target.
 *
 * V10 architectural note: writes go through Working Memory assertion routes
 * (`agent.assertion.create` + `agent.assertion.write`), not SWM via
 * `agent.share`. The `'chat-turns'` assertion inside the `'agent-context'`
 * context graph is the single canonical home for all chat-turn persistence
 * in the adapter; reads use `view: 'working-memory'` to hit the matching
 * per-agent WM assertion graph.
 *
 * Triple shapes (`schema:Message` / `schema:Conversation` / `dkg:ChatTurn` +
 * custom predicates) are preserved from the pre-v1 adapter for raw
 * persistence. `21_TRI_MODAL_MEMORY.md §3` defines a different target model
 * (markdown Knowledge Assets with YAML frontmatter and structural + semantic
 * extraction). v1 of the openclaw-dkg-primary-memory work intentionally
 * defers that migration; follow-up work tracks it.
 */
const AGENT_CONTEXT_GRAPH = 'agent-context';
const CHAT_TURNS_ASSERTION = 'chat-turns';
const OPENCLAW_LOCAL_SESSION_ID = 'openclaw:dkg-ui';

const CHAT_NS = 'urn:dkg:chat:';
const MEMORY_NS = 'urn:dkg:memory:';
const SCHEMA = 'http://schema.org/';
const DKG_ONT = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const OPENCLAW_LOCAL_SESSION_URI = `${CHAT_NS}session:${OPENCLAW_LOCAL_SESSION_ID}`;
const CHAT_ATTACHMENT_REFS_PREDICATE = `${DKG_ONT}attachmentRefs`;

interface ChatAttachmentRef {
  id?: string;
  fileName: string;
  contextGraphId: string;
  assertionName?: string;
  assertionUri: string;
  fileHash: string;
  detectedContentType?: string;
  extractionStatus?: 'completed' | 'skipped' | 'failed';
  tripleCount?: number;
  rootEntity?: string;
}

function stripRdfLiteral(value: string): string {
  if (!value) return '';
  const typed = value.match(/^"([\s\S]*)"(?:\^\^<[^>]+>)?(?:@[a-z-]+)?$/);
  if (typed) return typed[1];
  return value;
}

function normalizeChatAttachmentRef(raw: unknown): ChatAttachmentRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const fileName = typeof record.fileName === 'string' ? record.fileName.trim() : '';
  const contextGraphId = typeof record.contextGraphId === 'string' ? record.contextGraphId.trim() : '';
  const assertionUri = typeof record.assertionUri === 'string' ? record.assertionUri.trim() : '';
  const fileHash = typeof record.fileHash === 'string' ? record.fileHash.trim() : '';
  if (!fileName || !contextGraphId || !assertionUri || !fileHash) return null;

  const normalized: ChatAttachmentRef = {
    fileName,
    contextGraphId,
    assertionUri,
    fileHash,
  };
  if (typeof record.id === 'string' && record.id.trim()) normalized.id = record.id.trim();
  if (typeof record.assertionName === 'string' && record.assertionName.trim()) normalized.assertionName = record.assertionName.trim();
  if (typeof record.detectedContentType === 'string' && record.detectedContentType.trim()) {
    normalized.detectedContentType = record.detectedContentType.trim();
  }
  if (record.extractionStatus === 'completed' || record.extractionStatus === 'skipped' || record.extractionStatus === 'failed') {
    normalized.extractionStatus = record.extractionStatus;
  }
  if (typeof record.tripleCount === 'number' && Number.isFinite(record.tripleCount) && record.tripleCount >= 0) {
    normalized.tripleCount = record.tripleCount;
  }
  if (typeof record.rootEntity === 'string' && record.rootEntity.trim()) normalized.rootEntity = record.rootEntity.trim();
  return normalized;
}

function normalizeChatAttachmentRefs(raw: unknown): ChatAttachmentRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const refs = raw
    .map((entry) => normalizeChatAttachmentRef(entry))
    .filter((entry): entry is ChatAttachmentRef => entry != null);
  return refs.length > 0 ? refs : undefined;
}

function parseNestedJsonLiteral(value: string): unknown {
  let current: unknown = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== 'string') return current;
    const trimmed = current.trim();
    if (!trimmed) return undefined;
    try {
      current = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  return current;
}

function parseAttachmentRefsLiteral(value: string): ChatAttachmentRef[] | undefined {
  const candidates = [value, stripRdfLiteral(value)]
    .map((candidate) => candidate.trim())
    .filter((candidate, index, all) => candidate.length > 0 && all.indexOf(candidate) === index);

  for (const candidate of candidates) {
    const parsed = parseNestedJsonLiteral(candidate) ?? parseNestedJsonLiteral(JSON.stringify(candidate));
    const normalized = normalizeChatAttachmentRefs(parsed);
    if (normalized?.length) return normalized;
  }
  return undefined;
}

function parseRdfInt(value: string): number {
  if (!value) return 0;
  const match = value.match(/^"(\d+)"/);
  if (match) return parseInt(match[1], 10);
  const n = parseInt(value, 10);
  return isNaN(n) ? 0 : n;
}

function sumBindingValues(bindings: Array<Record<string, string>> | undefined, key: string): number {
  if (!bindings?.length) return 0;
  return bindings.reduce((sum, b) => sum + parseRdfInt(b[key] ?? '0'), 0);
}


function buildSessionRootPattern(sessionUri: string): string {
  const clauses = [
    `{ <${sessionUri}> ?sessionP ?sessionO . BIND(<${sessionUri}> AS ?s) }`,
    `{ ?s <${SCHEMA}isPartOf> <${sessionUri}> }`,
    `{
      ?msg <${SCHEMA}isPartOf> <${sessionUri}> .
      ?msg <${DKG_ONT}usedTool> ?s .
    }`,
    `{
      ?msg <${SCHEMA}isPartOf> <${sessionUri}> .
      ?s <${DKG_ONT}mentionedIn> ?msg .
    }`,
    `{ ?s <${DKG_ONT}extractedFrom> <${sessionUri}> }`,
  ];

  return `{
    ${clauses.join('\n    UNION ')}
  }`;
}

const MENTION_EXTRACTION_PROMPT = `Extract named entities mentioned in the following text. Output ONLY a JSON array of objects with "name" and "type" fields.

Rules:
- "name" is the canonical label (proper casing, e.g. "Porsche", "Bitcoin", "Berlin")
- "type" is one of: Person, Organization, Place, Product, Event, Technology, Concept
- Only extract concrete, specific entities — skip vague words like "car", "company", "city"
- If no entities found, output: []
- Do NOT wrap in markdown code fences

Example output:
[{"name":"Porsche","type":"Organization"},{"name":"Berlin","type":"Place"}]

Text:`;

const KG_EXTRACTION_PROMPT = `Extract structured knowledge from the following conversation exchange. Output ONLY valid N-Triples (one per line, no blank lines). Use URIs for subjects/predicates and proper RDF syntax.

Rules:
- Subject URIs: use urn:dkg:entity:{slug} where slug is a lowercase-kebab-case identifier for the entity
- Use schema.org predicates where possible (e.g. <http://schema.org/name>, <http://schema.org/description>, <http://schema.org/knows>, <http://schema.org/about>)
- Use <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> for types
- String literals use "value" syntax; typed literals use "value"^^<datatype>
- Each triple must end with " ."
- Only extract factual, meaningful entities and relationships — skip conversational filler
- If no meaningful knowledge can be extracted, output exactly: NONE

Example output:
<urn:dkg:entity:alice> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://schema.org/Person> .
<urn:dkg:entity:alice> <http://schema.org/name> "Alice Johnson" .
<urn:dkg:entity:alice> <http://schema.org/worksFor> <urn:dkg:entity:acme-corp> .

Conversation:`;

const MEMORY_PARSE_PROMPT = `Parse the following exported AI memories into individual structured items. Each memory is a discrete fact, preference, or piece of context the user previously shared with an AI assistant.

Output ONLY a valid JSON array. Each item should have:
- "text": the memory content as a clear sentence
- "category": one of "preference", "fact", "context", "instruction", "relationship"

Rules:
- Split compound memories into separate items when they contain distinct facts
- Normalize formatting: remove bullet markers, numbering, markdown artifacts
- Preserve the original meaning faithfully
- Skip metadata lines like "Here are your memories:" or "Last updated:"
- If no valid memories can be extracted, output: []
- Do NOT wrap in markdown code fences

Example input:
"- Prefers dark mode in all apps
- Works at Acme Corp as a senior engineer
- Has a dog named Max"

Example output:
[{"text":"Prefers dark mode in all apps","category":"preference"},{"text":"Works at Acme Corp as a senior engineer","category":"fact"},{"text":"Has a dog named Max","category":"fact"}]

Memories to parse:`;

const MEMORY_KG_PROMPT = `Extract structured knowledge from the following personal memory items. These are facts/preferences a user previously stored with an AI assistant. Output ONLY valid N-Triples (one per line).

Rules:
- Subject URIs: use urn:dkg:entity:{slug} where slug is a lowercase-kebab-case identifier
- Use schema.org predicates where possible (e.g. <http://schema.org/name>, <http://schema.org/description>, <http://schema.org/knows>)
- Use <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> for types
- String literals use "value" syntax
- Each triple must end with " ."
- Focus on extracting entities (people, organizations, tools, places) and their relationships
- If no meaningful knowledge can be extracted, output exactly: NONE

Memory items:`;

const SEMANTIC_RECALL_SYSTEM = `You are a SPARQL query generator. Output ONLY a valid SPARQL SELECT query.

IMPORTANT: Always use full URI syntax with angle brackets — NEVER use prefix shortcuts.

Available patterns:
- Sessions: ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://schema.org/Conversation>
- Messages: ?m <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://schema.org/Message>
  - ?m <http://schema.org/text> ?text
  - ?m <http://schema.org/author> <urn:dkg:chat:actor:user> or <urn:dkg:chat:actor:agent>
  - ?m <http://schema.org/isPartOf> ?session
  - ?m <http://schema.org/dateCreated> ?ts
- Entities: ?e <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?type . FILTER(STRSTARTS(STR(?e), "urn:dkg:entity:"))
  - ?e <http://schema.org/name> ?name
  - ?e <http://schema.org/worksFor> ?org
- Memory links: ?m <http://dkg.io/ontology/contains> ?entity
- Entity mentions: ?entity <http://dkg.io/ontology/mentionedIn> ?message

Always include LIMIT (default 50). Use FILTER with regex or CONTAINS for text search.`;

export class ChatMemoryManager {
  private initialized = false;
  private knownSessions = new Set<string>();
  private readonly llmClient = new LlmClient();
  private readonly agentContextGraph: string;
  private readonly chatTurnsAssertion: string;
  private readonly assertionEnsured = new Set<string>();
  readonly agentAddress: string | undefined;

  constructor(
    private tools: MemoryToolContext,
    private llmConfig: LlmConfig,
    options?: ChatMemoryManagerOptions,
  ) {
    this.agentAddress = options?.agentAddress;
    this.agentContextGraph = options?.contextGraphId ?? AGENT_CONTEXT_GRAPH;
    this.chatTurnsAssertion = options?.assertionName ?? CHAT_TURNS_ASSERTION;
  }

  get contextGraphId(): string {
    return this.agentContextGraph;
  }

  updateConfig(llmConfig: LlmConfig): void {
    this.llmConfig = llmConfig;
  }

  /**
   * Build the read options block used for every WM query issued by this
   * manager. Reads must match the layer writes land in — mixing SWM-writes
   * with WM-reads produces silent empty results.
   */
  private wmReadOpts(overrides?: { assertionName?: string }): {
    contextGraphId: string;
    view: 'working-memory';
    agentAddress?: string;
    assertionName: string;
  } {
    return {
      contextGraphId: this.agentContextGraph,
      view: 'working-memory',
      agentAddress: this.agentAddress,
      assertionName: overrides?.assertionName ?? this.chatTurnsAssertion,
    };
  }

  /**
   * Lazy creation of the chat-turn context graph + assertion. Runs on the
   * first `storeChatExchange` / `ensureInitialized` call and is idempotent
   * thereafter.
   */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    // (1) Create the context graph. Uses the `#156` free-CG flow —
    // `createContextGraph` defaults to unregistered, local-only, no chain
    // cost. `private: true` prevents gossip subscription / broadcast.
    try {
      const contextGraphs = await this.tools.listContextGraphs();
      const exists = contextGraphs.some(
        (p: any) => p.id === this.agentContextGraph || p.contextGraphId === this.agentContextGraph,
      );
      if (!exists) {
        await this.tools.createContextGraph({
          id: this.agentContextGraph,
          name: 'Agent Context',
          description: 'Chat-turn working memory for local agent integrations.',
          private: true,
        });
      }
    } catch (err: any) {
      if (!err.message?.includes('already exists')) throw err;
    }

    // (2) Create the chat-turns Working Memory assertion graph. Idempotent
    // via `createAssertion`'s client-side "already exists" handling.
    const assertionKey = `${this.agentContextGraph}::${this.chatTurnsAssertion}`;
    if (!this.assertionEnsured.has(assertionKey)) {
      try {
        await this.tools.createAssertion(this.agentContextGraph, this.chatTurnsAssertion);
        this.assertionEnsured.add(assertionKey);
      } catch (err: any) {
        if (err?.message?.includes('already exists')) {
          this.assertionEnsured.add(assertionKey);
        } else {
          throw err;
        }
      }
    }

    // (3) Pre-populate known sessions so subsequent writes to existing
    // sessions don't re-declare the session entity (DKG Rule 4). Reads
    // target the WM assertion to stay consistent with writes.
    try {
      const result = await this.tools.query(
        `SELECT ?sid WHERE { ?s <${RDF_TYPE}> <${SCHEMA}Conversation> . ?s <${DKG_ONT}sessionId> ?sid }`,
        this.wmReadOpts(),
      );
      for (const b of result.bindings ?? []) {
        const sid = stripRdfLiteral(b.sid ?? '');
        if (sid) this.knownSessions.add(sid);
      }
    } catch { /* best-effort */ }

    this.initialized = true;
  }

  async storeChatExchange(
    sessionId: string,
    userMessage: string,
    assistantReply: string,
    toolCalls?: Array<{ name: string; args: Record<string, unknown>; result: unknown }>,
    opts?: {
      turnId?: string;
      persistenceState?: 'stored' | 'failed' | 'pending';
      failureReason?: string | null;
      attachmentRefs?: ChatAttachmentRef[];
    },
  ): Promise<void> {
    await this.ensureInitialized();
    const userTs = new Date();
    const agentTs = new Date(userTs.getTime() + 1);
    const sessionUri = `${CHAT_NS}session:${sessionId}`;
    const userMsgId = crypto.randomUUID().slice(0, 8);
    const assistantMsgId = crypto.randomUUID().slice(0, 8);
    const userMsgUri = `${CHAT_NS}msg:${userMsgId}`;
    const assistantMsgUri = `${CHAT_NS}msg:${assistantMsgId}`;
    const turnId = opts?.turnId?.trim();
    const persistenceState = opts?.persistenceState ?? 'stored';
    const failureReason = typeof opts?.failureReason === 'string'
      ? opts.failureReason.trim()
      : (opts?.failureReason === null ? null : undefined);
    const turnUri = turnId ? `${CHAT_NS}turn:${turnId}` : undefined;

    const isNewSession = !this.knownSessions.has(sessionId);

    const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];

    // Only declare the session entity on the first exchange to avoid
    // DKG Rule 4 (entity exclusivity) rejecting subsequent writes.
    if (isNewSession) {
      quads.push(
        { subject: sessionUri, predicate: RDF_TYPE, object: `${SCHEMA}Conversation`, graph: '' },
        { subject: sessionUri, predicate: `${DKG_ONT}sessionId`, object: `"${sessionId}"`, graph: '' },
      );
    }

    quads.push(
      { subject: userMsgUri, predicate: RDF_TYPE, object: `${SCHEMA}Message`, graph: '' },
      { subject: userMsgUri, predicate: `${SCHEMA}isPartOf`, object: sessionUri, graph: '' },
      { subject: userMsgUri, predicate: `${SCHEMA}author`, object: `${CHAT_NS}actor:user`, graph: '' },
      { subject: userMsgUri, predicate: `${SCHEMA}dateCreated`, object: `"${userTs.toISOString()}"^^<${XSD_DATETIME}>`, graph: '' },
      { subject: userMsgUri, predicate: `${SCHEMA}text`, object: JSON.stringify(userMessage), graph: '' },
      { subject: assistantMsgUri, predicate: RDF_TYPE, object: `${SCHEMA}Message`, graph: '' },
      { subject: assistantMsgUri, predicate: `${SCHEMA}isPartOf`, object: sessionUri, graph: '' },
      { subject: assistantMsgUri, predicate: `${SCHEMA}author`, object: `${CHAT_NS}actor:agent`, graph: '' },
      { subject: assistantMsgUri, predicate: `${SCHEMA}dateCreated`, object: `"${agentTs.toISOString()}"^^<${XSD_DATETIME}>`, graph: '' },
      { subject: assistantMsgUri, predicate: `${SCHEMA}text`, object: JSON.stringify(assistantReply), graph: '' },
      { subject: assistantMsgUri, predicate: `${DKG_ONT}replyTo`, object: userMsgUri, graph: '' },
    );

    if (turnId && turnUri) {
      quads.push(
        { subject: turnUri, predicate: RDF_TYPE, object: `${DKG_ONT}ChatTurn`, graph: '' },
        { subject: turnUri, predicate: `${SCHEMA}isPartOf`, object: sessionUri, graph: '' },
        { subject: turnUri, predicate: `${DKG_ONT}turnId`, object: JSON.stringify(turnId), graph: '' },
        { subject: turnUri, predicate: `${SCHEMA}dateCreated`, object: `"${userTs.toISOString()}"^^<${XSD_DATETIME}>`, graph: '' },
        { subject: turnUri, predicate: `${DKG_ONT}hasUserMessage`, object: userMsgUri, graph: '' },
        { subject: turnUri, predicate: `${DKG_ONT}hasAssistantMessage`, object: assistantMsgUri, graph: '' },
        { subject: turnUri, predicate: `${DKG_ONT}persistenceState`, object: JSON.stringify(persistenceState), graph: '' },
        ...(persistenceState === 'failed' && failureReason
          ? [{ subject: turnUri, predicate: `${DKG_ONT}failureReason`, object: JSON.stringify(failureReason), graph: '' }]
          : []),
        { subject: userMsgUri, predicate: `${DKG_ONT}turnId`, object: JSON.stringify(turnId), graph: '' },
        { subject: assistantMsgUri, predicate: `${DKG_ONT}turnId`, object: JSON.stringify(turnId), graph: '' },
      );
    }

    const normalizedAttachmentRefs = normalizeChatAttachmentRefs(opts?.attachmentRefs ?? []);
    if (normalizedAttachmentRefs?.length) {
      quads.push({
        subject: userMsgUri,
        predicate: CHAT_ATTACHMENT_REFS_PREDICATE,
        object: JSON.stringify(JSON.stringify(normalizedAttachmentRefs)),
        graph: '',
      });
    }

    if (toolCalls?.length) {
      for (const tc of toolCalls) {
        const tcUri = `${CHAT_NS}tool:${crypto.randomUUID().slice(0, 8)}`;
        quads.push(
          { subject: tcUri, predicate: RDF_TYPE, object: `${DKG_ONT}ToolInvocation`, graph: '' },
          { subject: tcUri, predicate: `${DKG_ONT}toolName`, object: `"${tc.name}"`, graph: '' },
          { subject: tcUri, predicate: `${DKG_ONT}toolArgs`, object: JSON.stringify(JSON.stringify(tc.args)), graph: '' },
          { subject: assistantMsgUri, predicate: `${DKG_ONT}usedTool`, object: tcUri, graph: '' },
        );
      }
    }

    await this.tools.writeAssertion(this.agentContextGraph, this.chatTurnsAssertion, quads);
    this.knownSessions.add(sessionId);

    // Fire-and-forget: extract entity mentions and write them as separate triples
    if (this.llmConfig?.apiKey) {
      this.extractAndWriteMentions(userMsgUri, userMessage, assistantMsgUri, assistantReply)
        .catch(() => {/* best-effort */});
    }
  }

  private async extractAndWriteMentions(
    userMsgUri: string,
    userMessage: string,
    assistantMsgUri: string,
    assistantReply: string,
  ): Promise<void> {
    const allText = `User: ${userMessage}\nAssistant: ${assistantReply}`;
    const entities = await this.callMentionExtraction(allText);
    if (entities.length === 0) return;

    const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];
    const MENTIONED_IN = `${DKG_ONT}mentionedIn`;
    const seen = new Set<string>();

    for (const ent of entities) {
      const slug = ent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);

      const entityUri = `urn:dkg:entity:${slug}`;
      const schemaType = `${SCHEMA}${ent.type}`;

      quads.push(
        { subject: entityUri, predicate: RDF_TYPE, object: schemaType, graph: '' },
        { subject: entityUri, predicate: `${SCHEMA}name`, object: JSON.stringify(ent.name), graph: '' },
      );

      // Use entity as subject to avoid re-declaring message entities (DKG Rule 4)
      const userLower = userMessage.toLowerCase();
      const assistantLower = assistantReply.toLowerCase();
      const nameLower = ent.name.toLowerCase();

      if (userLower.includes(nameLower)) {
        quads.push({ subject: entityUri, predicate: MENTIONED_IN, object: userMsgUri, graph: '' });
      }
      if (assistantLower.includes(nameLower)) {
        quads.push({ subject: entityUri, predicate: MENTIONED_IN, object: assistantMsgUri, graph: '' });
      }
      if (!userLower.includes(nameLower) && !assistantLower.includes(nameLower)) {
        quads.push({ subject: entityUri, predicate: MENTIONED_IN, object: userMsgUri, graph: '' });
        quads.push({ subject: entityUri, predicate: MENTIONED_IN, object: assistantMsgUri, graph: '' });
      }
    }

    if (quads.length > 0) {
      await this.tools.writeAssertion(this.agentContextGraph, this.chatTurnsAssertion, quads);
    }
  }

  private async callMentionExtraction(text: string): Promise<Array<{ name: string; type: string }>> {
    if (!this.llmConfig.apiKey) return [];
    try {
      const completion = await this.llmClient.complete({
        config: this.llmConfig,
        request: {
          messages: [
            { role: 'system', content: MENTION_EXTRACTION_PROMPT },
            { role: 'user', content: text },
          ],
          temperature: 0,
          maxTokens: 512,
          stream: false,
        },
      });
      let output = completion.message.content?.trim() ?? '';
      output = output.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
      const parsed = JSON.parse(output);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((e: any) => e.name && e.type);
    } catch {
      return [];
    }
  }

  async extractKnowledge(
    sessionId: string,
    userMessage: string,
    assistantReply: string,
  ): Promise<number> {
    await this.ensureInitialized();
    const exchange = `User: ${userMessage}\nAssistant: ${assistantReply}`;
    if (!this.llmConfig.apiKey) return 0;
    let output = '';
    try {
      const completion = await this.llmClient.complete({
        config: this.llmConfig,
        request: {
          messages: [
            { role: 'system', content: KG_EXTRACTION_PROMPT },
            { role: 'user', content: exchange },
          ],
          temperature: 0.1,
          maxTokens: 1024,
          stream: false,
        },
      });
      output = completion.message.content?.trim() ?? '';
    } catch {
      return 0;
    }
    if (!output || output === 'NONE') return 0;

    const triples = this.parseNTriples(output);
    if (triples.length === 0) return 0;

    const sessionUri = `${CHAT_NS}session:${sessionId}`;
    const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];
    for (const t of triples) {
      quads.push({ ...t, graph: '' });
    }
    const rootEntities = new Set(triples.map(t => t.subject));
    for (const entity of rootEntities) {
      const memUri = `${MEMORY_NS}${crypto.randomUUID().slice(0, 8)}`;
      quads.push(
        { subject: memUri, predicate: RDF_TYPE, object: `${DKG_ONT}Memory`, graph: '' },
        { subject: memUri, predicate: `${DKG_ONT}extractedFrom`, object: sessionUri, graph: '' },
        { subject: memUri, predicate: `${DKG_ONT}contains`, object: entity, graph: '' },
        { subject: memUri, predicate: `${SCHEMA}dateCreated`, object: `"${new Date().toISOString()}"^^<${XSD_DATETIME}>`, graph: '' },
      );
    }
    await this.tools.writeAssertion(this.agentContextGraph, this.chatTurnsAssertion, quads);
    return triples.length;
  }

  async recall(sparql: string): Promise<any> {
    await this.ensureInitialized();
    return this.tools.query(sparql, this.wmReadOpts());
  }

  async semanticRecall(question: string): Promise<{ sparql: string; result: any }> {
    if (!this.llmConfig.apiKey) throw new Error('LLM not configured');
    const completion = await this.llmClient.complete({
      config: this.llmConfig,
      request: {
        messages: [
          { role: 'system', content: SEMANTIC_RECALL_SYSTEM },
          { role: 'user', content: question },
        ],
        temperature: 0.1,
        maxTokens: 512,
        stream: false,
      },
    });
    let sparql = completion.message.content?.trim() ?? '';
    sparql = sparql.replace(/^```(?:sparql)?\n?/i, '').replace(/\n?```$/i, '').trim();

    const result = await this.recall(sparql);
    return { sparql, result };
  }

  async getStats(): Promise<MemoryStats> {
    await this.ensureInitialized();
    const base: MemoryStats = {
      contextGraphId: this.agentContextGraph,
      initialized: true,
      messageCount: 0,
      knowledgeTriples: 0,
      totalTriples: 0,
      sessionCount: 0,
      entityCount: 0,
    };
    try {
      const total = await this.tools.query(
        `SELECT (COUNT(*) AS ?c) WHERE { ?s ?p ?o }`,
        this.wmReadOpts(),
      );
      base.totalTriples = sumBindingValues(total.bindings, 'c');

      const sessions = await this.tools.query(
        `SELECT (COUNT(DISTINCT ?s) AS ?c) WHERE { ?s <${RDF_TYPE}> <${SCHEMA}Conversation> }`,
        this.wmReadOpts(),
      );
      base.sessionCount = sumBindingValues(sessions.bindings, 'c');

      const msgs = await this.tools.query(
        `SELECT (COUNT(*) AS ?c) WHERE { ?s <${RDF_TYPE}> <${SCHEMA}Message> }`,
        this.wmReadOpts(),
      );
      base.messageCount = sumBindingValues(msgs.bindings, 'c');

      const chatRelatedTriples = await this.tools.query(
        `SELECT (COUNT(*) AS ?c) WHERE {
          { ?s <${RDF_TYPE}> <${SCHEMA}Message> . ?s ?p ?o }
          UNION
          { ?s <${RDF_TYPE}> <${SCHEMA}Conversation> . ?s ?p ?o }
          UNION
          { ?s <${RDF_TYPE}> <${DKG_ONT}ToolInvocation> . ?s ?p ?o }
        }`,
        this.wmReadOpts(),
      );
      const chatTripleCount = sumBindingValues(chatRelatedTriples.bindings, 'c');

      const entities = await this.tools.query(
        `SELECT (COUNT(DISTINCT ?e) AS ?c) WHERE { ?e <${RDF_TYPE}> ?t . FILTER(STRSTARTS(STR(?e), "urn:dkg:entity:")) }`,
        this.wmReadOpts(),
      );
      base.entityCount = sumBindingValues(entities.bindings, 'c');

      base.knowledgeTriples = Math.max(0, base.totalTriples - chatTripleCount);
    } catch { /* stats are best-effort */ }
    return base;
  }

  async getEntities(limit = 50): Promise<MemoryEntity[]> {
    await this.ensureInitialized();
    try {
      const result = await this.tools.query(
        `SELECT DISTINCT ?e ?type ?label WHERE {
          ?e <${RDF_TYPE}> ?type .
          OPTIONAL { ?e <${SCHEMA}name> ?label }
          FILTER(STRSTARTS(STR(?e), "urn:dkg:entity:"))
        } LIMIT ${limit}`,
        this.wmReadOpts(),
      );
      const entities: MemoryEntity[] = [];
      for (const b of result.bindings ?? []) {
        const uri = b.e;
        const propsResult = await this.tools.query(
          `SELECT ?p ?o WHERE { <${uri}> ?p ?o } LIMIT 20`,
          this.wmReadOpts(),
        );
        entities.push({
          uri,
          type: b.type ?? '',
          label: b.label ?? uri.split(':').pop() ?? uri,
          properties: (propsResult.bindings ?? []).map((pb: any) => ({
            predicate: pb.p,
            object: pb.o,
          })),
        });
      }
      return entities;
    } catch {
      return [];
    }
  }

  async getSession(
    sessionId: string,
    opts: {
      limit?: number;
      order?: 'asc' | 'desc';
    } = {},
  ): Promise<{
    session: string;
    messages: Array<{
      uri: string;
      author: string;
      text: string;
      ts: string;
      turnId?: string;
      persistStatus?: 'pending' | 'in_progress' | 'stored' | 'failed' | 'skipped';
      failureReason?: string | null;
      attachmentRefs?: ChatAttachmentRef[];
    }>;
  } | null> {
    await this.ensureInitialized();
    try {
      const requestedLimit = typeof opts.limit === 'number' && Number.isInteger(opts.limit) && opts.limit > 0
        ? opts.limit
        : null;
      const limit = requestedLimit != null
        ? Math.min(requestedLimit, 500)
        : 500;
      const order = opts.order === 'desc' ? 'DESC' : 'ASC';
      const sessionUri = `${CHAT_NS}session:${sessionId}`;
      const msgsResult = await this.tools.query(
        `SELECT ?m ?author ?text ?ts ?turnId ?persistenceState ?attachmentRefs ?failureReason ?headlessAssistantFlag WHERE {
          ?m <${SCHEMA}isPartOf> <${sessionUri}> .
          ?m <${SCHEMA}author> ?author .
          ?m <${SCHEMA}text> ?text .
          ?m <${SCHEMA}dateCreated> ?ts
          OPTIONAL { ?m <${DKG_ONT}turnId> ?turnId }
          OPTIONAL { ?m <${CHAT_ATTACHMENT_REFS_PREDICATE}> ?attachmentRefs }
          OPTIONAL { ?m <${DKG_ONT}headlessAssistantMessage> ?headlessAssistantFlag }
          OPTIONAL {
            ?turn <${RDF_TYPE}> <${DKG_ONT}ChatTurn> .
            ?turn <${SCHEMA}isPartOf> <${sessionUri}> .
            ?turn <${DKG_ONT}turnId> ?turnId .
            ?turn <${DKG_ONT}persistenceState> ?persistenceState .
            OPTIONAL { ?turn <${DKG_ONT}failureReason> ?failureReason }
          }
        } ORDER BY ${order}(?ts) LIMIT ${limit}`,
        this.wmReadOpts(),
      );
      const bindings = msgsResult.bindings ?? [];
      if (bindings.length === 0) return null;
      type RawMessage = {
        uri: string;
        author: 'user' | 'agent';
        text: string;
        ts: string;
        turnId: string | undefined;
        attachmentRefs: ChatAttachmentRef[] | undefined;
        persistStatus: 'pending' | 'in_progress' | 'stored' | 'failed' | 'skipped' | undefined;
        failureReason: string | undefined;
        isHeadlessAssistant: boolean;
      };
      const rawMessages: RawMessage[] = bindings.map((mb: any): RawMessage => {
        const turnIdLiteral = stripRdfLiteral(mb.turnId ?? '') || undefined;
        const headlessFlag = stripRdfLiteral(mb.headlessAssistantFlag ?? '').trim();
        return {
          uri: String(mb.m ?? '').replace(/[<>]/g, ''),
          author: mb.author?.includes('user') ? 'user' : 'agent',
          text: stripRdfLiteral(mb.text ?? ''),
          ts: stripRdfLiteral(mb.ts ?? ''),
          turnId: turnIdLiteral,
          attachmentRefs: parseAttachmentRefsLiteral(String(mb.attachmentRefs ?? '')),
          persistStatus: (() => {
            const status = stripRdfLiteral(mb.persistenceState ?? '').trim();
            if (status === 'pending' || status === 'in_progress' || status === 'stored' || status === 'failed' || status === 'skipped') {
              return status;
            }
            return undefined;
          })(),
          failureReason: (() => {
            const reason = stripRdfLiteral(mb.failureReason ?? '').trim();
            return reason.length > 0 ? reason : undefined;
          })(),
          // r31-5 (PR #229 bot review — actions.ts:1173): used ONLY by
          // the dedupe pass below, then stripped from the public shape.
          // `true` iff the writer tagged the message
          // `dkg:headlessAssistantMessage "true"` (i.e. it came from
          // the proactive/recovery headless reply path, not the
          // canonical user-first turn).
          isHeadlessAssistant: headlessFlag === 'true',
        };
      });
      // PR #229 bot review (r31-5 — actions.ts:1173): when both a
      // headless assistant message (`msg:agent-headless:K`,
      // `dkg:turnId "headless:K"`, marked
      // `dkg:headlessAssistantMessage "true"`) AND a canonical
      // assistant message (`msg:agent:K`, `dkg:turnId "K"`) exist for
      // the same logical turn, the SPARQL above returns both because
      // their URIs differ — chat history would render the same reply
      // twice. Group by the canonical turn key (strip the `headless:`
      // literal prefix off `dkg:turnId`) and, when a non-headless
      // message exists in a group, drop the headless variant. Headless
      // replies that have NO canonical counterpart (the standard
      // proactive-agent / recovery case) are kept untouched — dedupe
      // activates only when both variants are present.
      const HEADLESS_PREFIX = 'headless:';
      const canonicalTurnKey = (turnId: string | undefined): string | null => {
        if (!turnId) return null;
        return turnId.startsWith(HEADLESS_PREFIX)
          ? turnId.slice(HEADLESS_PREFIX.length)
          : turnId;
      };
      const groupHasNonHeadless = new Map<string, boolean>();
      for (const m of rawMessages) {
        const key = canonicalTurnKey(m.turnId);
        if (key === null) continue;
        if (!m.isHeadlessAssistant) groupHasNonHeadless.set(key, true);
      }
      const dedupedMessages = rawMessages
        .filter((m) => {
          if (!m.isHeadlessAssistant) return true;
          const key = canonicalTurnKey(m.turnId);
          if (key === null) return true;
          return !groupHasNonHeadless.get(key);
        })
        .map(({ isHeadlessAssistant: _ignored, ...publicShape }) => publicShape);
      return {
        session: sessionId,
        messages: dedupedMessages,
      };
    } catch {
      return null;
    }
  }

  async getRecentChats(limit = 20): Promise<Array<{ session: string; messages: Array<{ author: string; text: string; ts: string }> }>> {
    await this.ensureInitialized();
    try {
      const expandedLimit = Math.max(limit, Math.min(limit * 4, 400));
      const sessionsResult = await this.tools.query(
        `SELECT ?s ?sid (MAX(?mts) AS ?latest) WHERE {
          ?s <${RDF_TYPE}> <${SCHEMA}Conversation> .
          ?s <${DKG_ONT}sessionId> ?sid .
          OPTIONAL { ?m <${SCHEMA}isPartOf> ?s . ?m <${SCHEMA}dateCreated> ?mts }
        } GROUP BY ?s ?sid ORDER BY DESC(?latest) LIMIT ${expandedLimit}`,
        this.wmReadOpts(),
      );
      const sessionBindings = sessionsResult.bindings ?? [];
      if (sessionBindings.length === 0) return [];

      const seenSessionIds = new Set<string>();
      const sessionEntries: Array<{ sessionUri: string; sessionId: string }> = [];
      for (const sb of sessionBindings) {
        const sessionUri = String(sb.s ?? '').replace(/[<>]/g, '');
        const sid = stripRdfLiteral(sb.sid ?? sb.s);
        const sessionId = sid || sessionUri;
        if (!sessionUri || !sessionId) continue;
        if (!isSafeIri(sessionUri)) continue;
        if (seenSessionIds.has(sessionId)) continue;
        seenSessionIds.add(sessionId);
        sessionEntries.push({ sessionUri, sessionId });
        if (sessionEntries.length >= limit) break;
      }

      if (sessionEntries.length === 0) return [];

      const values = sessionEntries
        .map((entry: { sessionUri: string; sessionId: string }) => `<${entry.sessionUri}>`)
        .join(' ');

      const allMsgs = await this.tools.query(
        `SELECT ?session ?author ?text ?ts WHERE {
          VALUES ?session { ${values} }
          ?m <${SCHEMA}isPartOf> ?session .
          ?m <${SCHEMA}author> ?author .
          ?m <${SCHEMA}text> ?text .
          ?m <${SCHEMA}dateCreated> ?ts
        } ORDER BY ?session ?ts`,
        this.wmReadOpts(),
      );

      const bySession = new Map<string, Array<{ author: string; text: string; ts: string }>>();
      for (const row of allMsgs.bindings ?? []) {
        const sessionUri = String(row.session ?? '').replace(/[<>]/g, '');
        if (!sessionUri) continue;
        if (!bySession.has(sessionUri)) bySession.set(sessionUri, []);
        const msgs = bySession.get(sessionUri)!;
        if (msgs.length >= 100) continue;
        msgs.push({
          author: row.author?.includes('user') ? 'user' : 'agent',
          text: stripRdfLiteral(row.text ?? ''),
          ts: stripRdfLiteral(row.ts ?? ''),
        });
      }

      return sessionEntries.map((entry: { sessionUri: string; sessionId: string }) => ({
        session: entry.sessionId,
        messages: bySession.get(entry.sessionUri) ?? [],
      }));
    } catch {
      return [];
    }
  }

  async getSessionGraphDelta(
    sessionId: string,
    turnId: string,
    opts?: { baseTurnId?: string | null },
  ): Promise<SessionGraphDeltaResult> {
    await this.ensureInitialized();
    const sessionUri = `${CHAT_NS}session:${sessionId}`;
    const baseTurnId = opts?.baseTurnId?.trim() || null;
    const countResult = await this.tools.query(
      `SELECT (COUNT(*) AS ?c) WHERE {
        ?turn <${RDF_TYPE}> <${DKG_ONT}ChatTurn> .
        ?turn <${SCHEMA}isPartOf> <${sessionUri}> .
      }`,
      this.wmReadOpts(),
    );
    const turnCount = sumBindingValues(countResult.bindings, 'c');
    if (turnCount === 0) {
      return {
        mode: 'full_refresh_required',
        reason: 'session_empty',
        sessionId,
        turnId,
        watermark: {
          baseTurnId,
          previousTurnId: null,
          appliedTurnId: null,
          latestTurnId: null,
          turnIndex: 0,
          turnCount: 0,
        },
        triples: [],
      };
    }

    // PR #229 bot review (r30-8 — adapter-elizaos/src/actions.ts:965).
    // The adapter's writer emits two URI shapes for the canonical
    // `dkg:ChatTurn` envelope:
    //
    //   1. `${CHAT_NS}turn:${turnKey}` — normal user-first turn (the
    //      `onChatTurn → onAssistantReply` chain or the local
    //      `chat-memory.ts` writer at line 517 above);
    //   2. `${CHAT_NS}headless-turn:${turnKey}` — assistant-only
    //      headless turn (assistant-reply hook fires without a
    //      matching user-turn, e.g. the prior `onChatTurn` write
    //      failed, the hook was disabled, or a reconnect replayed
    //      only the reply). The writer routes these onto a distinct
    //      URI so a stub `dkg:hasUserMessage` doesn't collide with
    //      a real one already stamped on the canonical turn.
    //
    // Pre-r30-8 this reader hard-coded `${CHAT_NS}turn:${turnId}` and
    // therefore could not find headless-turn quads at all — every
    // assistant-only turn round-tripped as `turn_not_found` even
    // though its triples lived in the WM. We now resolve the actual
    // turn URI by joining on the `dkg:turnId` literal inside the
    // session, which matches BOTH URI shapes uniformly. The writer
    // contract still uses `${CHAT_NS}turn:` for the cache-friendly
    // delta path (CONSTRUCT subjectSet below), but the lookup itself
    // is now URI-agnostic.
    // PR #229 bot review (r31-3 — adapter-elizaos/src/actions.ts:622).
    // The writer now stamps a DISTINCT `dkg:turnId = "headless:${turnKey}"`
    // literal on headless envelopes (the canonical user-first turn
    // continues to use the bare `turnKey`). That keeps the
    // `LIMIT 1` lookup-by-id deterministic when both turns exist
    // for the same `turnKey`, but it changes the call contract
    // for callers that previously used the bare `turnKey` to
    // address either kind: now `?turn dkg:turnId "K"` only matches
    // the canonical turn.
    //
    // To preserve the old "find whatever exists for this id"
    // behaviour for callers that don't know whether a canonical
    // user-first turn ever arrived (the common case for an
    // assistant-only `onAssistantReply` flow), we fall back to the
    // `headless:` prefixed literal if the bare lookup returns no
    // binding. The fallback is order-preserving: canonical turns
    // ALWAYS win when both exist (because we try the bare literal
    // first), so the disambiguation the writer change introduced
    // is still in force.
    const tryResolveTurn = async (literal: string): Promise<{
      uri: string;
      ts: string;
      // PR #229 bot review (r31-4 — chat-memory.ts:1091).
      // The actual `dkg:turnId` literal that joined this row. For the
      // bare-literal lookup this is just the input `turnId`; for the
      // headless fallback it's `"headless:<turnId>"`. Downstream
      // previous-turn / turn-index queries MUST use this literal
      // (not the caller's `turnId`) because they compare the stored
      // `dkg:turnId` values in WM, which for headless turns are
      // always prefixed.
      literal: string;
    } | null> => {
      const sparqlLit = JSON.stringify(literal);
      const result = await this.tools.query(
        `SELECT ?turn ?ts WHERE {
          ?turn <${RDF_TYPE}> <${DKG_ONT}ChatTurn> .
          ?turn <${SCHEMA}isPartOf> <${sessionUri}> .
          ?turn <${DKG_ONT}turnId> ${sparqlLit} .
          OPTIONAL { ?turn <${SCHEMA}dateCreated> ?ts }
        } LIMIT 1`,
        this.wmReadOpts(),
      );
      const row = (result.bindings ?? [])[0];
      const uri = String(row?.turn ?? '').replace(/[<>]/g, '');
      if (!uri || !isSafeIri(uri)) return null;
      return {
        uri,
        ts: stripRdfLiteral(row?.ts ?? '').trim(),
        literal,
      };
    };
    // Try the bare literal first (canonical user-first turn).
    let resolution = await tryResolveTurn(turnId);
    // Fallback: try the `headless:` prefixed literal so callers
    // that pass the original `userMessageId` (without knowing
    // whether the canonical user-turn ever made it to disk) still
    // discover the headless envelope. Skip the fallback when the
    // input already starts with `headless:` to avoid the redundant
    // `headless:headless:K` lookup.
    if (!resolution && !turnId.startsWith('headless:')) {
      resolution = await tryResolveTurn(`headless:${turnId}`);
    }
    const resolvedTurnUri = resolution?.uri ?? '';
    const turnUri = resolvedTurnUri || `${CHAT_NS}turn:${turnId}`;
    // The caller's lookup key is preserved in `currentTurnId` for
    // downstream watermark / cache-key purposes — even if the
    // resolved URI was found via the headless fallback. This keeps
    // the watermark contract stable across replays where the same
    // logical turn id might map to canonical OR headless.
    const currentTurnId = resolvedTurnUri ? turnId : '';
    const currentTurnTs = resolution?.ts ?? '';
    // PR #229 bot review (r31-4 — chat-memory.ts:1091).
    // Use the resolved `dkg:turnId` literal for SPARQL comparisons
    // against stored `dkg:turnId` values, NOT the caller's bare
    // `turnId`. For canonical turns these are equal (`"t2"`); for
    // headless turns the resolved literal is `"headless:t2"` and
    // the bare-literal comparison would have returned the wrong
    // previous-turn / turn-index because the WM stores the prefixed
    // form. The caller-facing `currentTurnId` (above) stays as the
    // input `turnId` so the watermark / result.turnId contracts are
    // unchanged.
    const resolvedTurnIdLiteral = resolution?.literal ?? currentTurnId;
    const latestTurnResult = await this.tools.query(
      `SELECT ?latestTurnId ?latestTs WHERE {
        ?latestTurn <${RDF_TYPE}> <${DKG_ONT}ChatTurn> .
        ?latestTurn <${SCHEMA}isPartOf> <${sessionUri}> .
        ?latestTurn <${DKG_ONT}turnId> ?latestTurnId .
        OPTIONAL { ?latestTurn <${SCHEMA}dateCreated> ?latestTs }
      } ORDER BY DESC(?latestTs) DESC(?latestTurnId) LIMIT 1`,
      this.wmReadOpts(),
    );
    const latestTurnId = stripRdfLiteral((latestTurnResult.bindings ?? [])[0]?.latestTurnId ?? '').trim() || null;
    if (!currentTurnId || currentTurnId !== turnId) {
      return {
        mode: 'full_refresh_required',
        reason: 'turn_not_found',
        sessionId,
        turnId,
        watermark: {
          baseTurnId,
          previousTurnId: latestTurnId,
          appliedTurnId: null,
          latestTurnId,
          turnIndex: 0,
          turnCount,
        },
        triples: [],
      };
    }

    const currentTurnIdLiteral = JSON.stringify(resolvedTurnIdLiteral);
    const currentTsLiteral = currentTurnTs
      ? `"${currentTurnTs}"^^<${XSD_DATETIME}>`
      : null;
    const previousTurnQuery = currentTsLiteral
      ? `SELECT ?previousTurnId WHERE {
          ?previousTurn <${RDF_TYPE}> <${DKG_ONT}ChatTurn> .
          ?previousTurn <${SCHEMA}isPartOf> <${sessionUri}> .
          ?previousTurn <${DKG_ONT}turnId> ?previousTurnId .
          ?previousTurn <${SCHEMA}dateCreated> ?previousTs .
          FILTER(
            ?previousTs < ${currentTsLiteral}
            || (?previousTs = ${currentTsLiteral} && ?previousTurnId < ${currentTurnIdLiteral})
          )
        } ORDER BY DESC(?previousTs) DESC(?previousTurnId) LIMIT 1`
      : `SELECT ?previousTurnId WHERE {
          ?previousTurn <${RDF_TYPE}> <${DKG_ONT}ChatTurn> .
          ?previousTurn <${SCHEMA}isPartOf> <${sessionUri}> .
          ?previousTurn <${DKG_ONT}turnId> ?previousTurnId .
          FILTER(?previousTurnId < ${currentTurnIdLiteral})
        } ORDER BY DESC(?previousTurnId) LIMIT 1`;
    const previousTurnResult = await this.tools.query(
      previousTurnQuery,
      this.wmReadOpts(),
    );
    const previousTurnId = stripRdfLiteral((previousTurnResult.bindings ?? [])[0]?.previousTurnId ?? '').trim() || null;
    const turnIndexResult = currentTsLiteral
      ? await this.tools.query(
          `SELECT (COUNT(*) AS ?c) WHERE {
            ?turn <${RDF_TYPE}> <${DKG_ONT}ChatTurn> .
            ?turn <${SCHEMA}isPartOf> <${sessionUri}> .
            ?turn <${DKG_ONT}turnId> ?tid .
            ?turn <${SCHEMA}dateCreated> ?ts .
            FILTER(
              ?ts < ${currentTsLiteral}
              || (?ts = ${currentTsLiteral} && ?tid <= ${currentTurnIdLiteral})
            )
          }`,
          this.wmReadOpts(),
        )
      : { bindings: [{ c: String(previousTurnId ? 2 : 1) }] };
    const turnIndex = Math.max(0, sumBindingValues(turnIndexResult.bindings, 'c'));

    if (previousTurnId && !baseTurnId) {
      return {
        mode: 'full_refresh_required',
        reason: 'missing_watermark',
        sessionId,
        turnId,
        watermark: {
          baseTurnId,
          previousTurnId,
          appliedTurnId: null,
          latestTurnId,
          turnIndex,
          turnCount,
        },
        triples: [],
      };
    }
    if (
      (previousTurnId && baseTurnId !== previousTurnId)
      || (!previousTurnId && baseTurnId != null)
    ) {
      return {
        mode: 'full_refresh_required',
        reason: 'watermark_mismatch',
        sessionId,
        turnId,
        watermark: {
          baseTurnId,
          previousTurnId,
          appliedTurnId: null,
          latestTurnId,
          turnIndex,
          turnCount,
        },
        triples: [],
      };
    }

    const turnMessagesResult = await this.tools.query(
      `SELECT ?user ?assistant WHERE {
        <${turnUri}> <${SCHEMA}isPartOf> <${sessionUri}> .
        <${turnUri}> <${DKG_ONT}hasUserMessage> ?user .
        <${turnUri}> <${DKG_ONT}hasAssistantMessage> ?assistant .
      } LIMIT 1`,
      this.wmReadOpts(),
    );
    const turnMessages = (turnMessagesResult.bindings ?? [])[0];
    const userMsgUri = String(turnMessages?.user ?? '').replace(/[<>]/g, '');
    const assistantMsgUri = String(turnMessages?.assistant ?? '').replace(/[<>]/g, '');
    if (!userMsgUri || !assistantMsgUri || !isSafeIri(userMsgUri) || !isSafeIri(assistantMsgUri)) {
      return {
        mode: 'full_refresh_required',
        reason: 'turn_not_found',
        sessionId,
        turnId,
        watermark: {
          baseTurnId,
          previousTurnId,
          appliedTurnId: null,
          latestTurnId,
          turnIndex,
          turnCount,
        },
        triples: [],
      };
    }

    const relatedSubjectsResult = await this.tools.query(
      `SELECT DISTINCT ?s WHERE {
        VALUES ?msg { <${userMsgUri}> <${assistantMsgUri}> }
        { BIND(<${sessionUri}> AS ?s) }
        UNION { BIND(<${turnUri}> AS ?s) }
        UNION { BIND(?msg AS ?s) }
        UNION { <${assistantMsgUri}> <${DKG_ONT}usedTool> ?s }
        UNION { ?s <${DKG_ONT}mentionedIn> ?msg }
        UNION {
          ?entity <${DKG_ONT}mentionedIn> ?msg .
          ?s <${DKG_ONT}contains> ?entity .
          ?s <${DKG_ONT}extractedFrom> <${sessionUri}> .
        }
      } LIMIT 5000`,
      this.wmReadOpts(),
    );
    const subjectSet = new Set<string>([sessionUri, turnUri, userMsgUri, assistantMsgUri]);
    for (const b of relatedSubjectsResult.bindings ?? []) {
      const iri = String(b.s ?? '').replace(/[<>]/g, '');
      if (!iri || !isSafeIri(iri)) continue;
      subjectSet.add(iri);
    }
    const values = [...subjectSet]
      .map((iri) => `<${iri}>`)
      .join(' ');
    const deltaResult = await this.tools.query(
      `CONSTRUCT { ?s ?p ?o } WHERE {
        VALUES ?s { ${values} }
        ?s ?p ?o .
      }`,
      this.wmReadOpts(),
    );

    const quads = Array.isArray(deltaResult?.quads) ? deltaResult.quads : [];
    const triples = quads.map((q: any) => ({
      subject: String(q.subject ?? ''),
      predicate: String(q.predicate ?? ''),
      object: stripRdfLiteral(String(q.object ?? '')),
    }));

    return {
      mode: 'delta',
      sessionId,
      turnId,
      watermark: {
        baseTurnId,
        previousTurnId,
        appliedTurnId: turnId,
        latestTurnId,
        turnIndex,
        turnCount,
      },
      triples,
    };
  }

  // TODO(openclaw-dkg-primary-memory v1 follow-up): the publish-session flow
  // assumes chat turns live in SWM so they can be promoted to VM on-chain.
  // Under v1, chat turns are written through Working Memory assertion routes
  // instead — they never reach SWM automatically. These methods remain
  // compilable but will typically return an `empty` publication scope. A
  // future version should reimplement session promotion via
  // `agent.assertion.promote` against the `chat-turns` WM assertion.
  async getSessionPublicationStatus(sessionId: string): Promise<SessionPublicationStatus> {
    await this.ensureInitialized();
    const sessionUri = `${CHAT_NS}session:${sessionId}`;
    const rootPattern = buildSessionRootPattern(sessionUri);
    const countQuery = `SELECT (COUNT(*) AS ?c) WHERE {
      {
        SELECT DISTINCT ?s WHERE ${rootPattern} LIMIT 5000
      }
      ?s ?p ?o
    }`;
    const swmCountResult = await this.tools.query(countQuery, {
      contextGraphId: this.agentContextGraph,
      graphSuffix: '_shared_memory',
    });
    const dataCountResult = await this.tools.query(countQuery, {
      contextGraphId: this.agentContextGraph,
    });

    const rootEntityResult = await this.tools.query(
      `SELECT DISTINCT ?s WHERE ${rootPattern} LIMIT 5000`,
      { contextGraphId: this.agentContextGraph, graphSuffix: '_shared_memory' },
    );

    const sharedMemoryTripleCount = sumBindingValues(swmCountResult.bindings, 'c');
    const dataTripleCount = sumBindingValues(dataCountResult.bindings, 'c');
    const rootEntityCount = (rootEntityResult.bindings ?? []).length;
    const scope: SessionPublicationStatus['scope'] =
      dataTripleCount > 0
        ? (
          sharedMemoryTripleCount > dataTripleCount
            ? 'published_with_pending'
            : 'published'
        )
        : sharedMemoryTripleCount > 0
          ? 'shared_memory_only'
          : 'empty';

    return {
      sessionId,
      sharedMemoryTripleCount,
      dataTripleCount,
      scope,
      rootEntityCount,
    };
  }

  async getSessionRootEntities(sessionId: string): Promise<string[]> {
    await this.ensureInitialized();
    const sessionUri = `${CHAT_NS}session:${sessionId}`;
    const rootPattern = buildSessionRootPattern(sessionUri);
    const result = await this.tools.query(
      `SELECT DISTINCT ?s WHERE ${rootPattern} LIMIT 5000`,
      { contextGraphId: this.agentContextGraph, graphSuffix: '_shared_memory' },
    );

    const roots = new Set<string>();
    for (const b of result.bindings ?? []) {
      const iri = String(b.s ?? '').replace(/[<>]/g, '');
      if (!iri || !isSafeIri(iri)) continue;
      roots.add(iri);
    }
    return [...roots];
  }

  async publishSession(
    sessionId: string,
    opts?: { rootEntities?: string[]; clearSharedMemoryAfter?: boolean },
  ): Promise<SessionPublishResult> {
    await this.ensureInitialized();
    const sessionRoots = await this.getSessionRootEntities(sessionId);
    if (sessionRoots.length === 0) {
      throw new Error(`No shared memory entities found for session ${sessionId}`);
    }
    const sessionRootSet = new Set(sessionRoots);
    const requestedRoots = (opts?.rootEntities ?? [])
      .map((r) => String(r).trim())
      .filter((r) => isSafeIri(r));
    const rootEntities = requestedRoots.length > 0
      ? [...new Set(requestedRoots.filter((r) => sessionRootSet.has(r)))]
      : sessionRoots;
    if (rootEntities.length === 0) {
      throw new Error(`Selected root entities are not part of session ${sessionId}`);
    }
    const published = await this.publishFromSwm(
      { rootEntities },
      { clearSharedMemoryAfter: opts?.clearSharedMemoryAfter ?? false },
    );
    const publication = await this.getSessionPublicationStatus(sessionId);
    return {
      ...published,
      sessionId,
      rootEntityCount: rootEntities.length,
      publication,
    };
  }

  // importMemories / parseMemoriesWithLlm / parseMemoriesHeuristic /
  // extractKnowledgeFromImport are retired as part of the openclaw-dkg-primary-memory
  // work. /api/memory/import is a V9 relic that required LLM API keys on the
  // node and wrote dkg:ImportedMemory / dkg:MemoryImport ad-hoc types into a
  // throwaway sidecar graph. v1 replaces it with the assertion-route write
  // path inside the adapter (DkgMemoryPlugin.dkg_memory_import), which
  // targets the 'memory' WM assertion of a resolved project context graph.

  async publishFromSwm(
    selection: 'all' | { rootEntities: string[] } = 'all',
    opts?: { clearSharedMemoryAfter?: boolean },
  ): Promise<PublishFromSwmResult> {
    await this.ensureInitialized();
    const result = await this.tools.publishFromSharedMemory(this.agentContextGraph, selection, {
      clearSharedMemoryAfter: opts?.clearSharedMemoryAfter ?? false,
    });
    return {
      kcId: result?.kcId,
      ual: result?.ual,
      status: result?.status ?? 'confirmed',
      tripleCount: result?.publicQuads?.length ?? 0,
    };
  }

  private parseNTriples(text: string): Array<{ subject: string; predicate: string; object: string }> {
    const triples: Array<{ subject: string; predicate: string; object: string }> = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(
        /^<([^>]+)>\s+<([^>]+)>\s+(?:<([^>]+)>|("(?:[^"\\]|\\.)*"(?:\^\^<[^>]+>)?(?:@[a-z-]+)?))\s*\.?\s*$/,
      );
      if (match) {
        const subject = match[1]!;
        const predicate = match[2]!;
        const object = match[3] ? match[3] : match[4]!;
        triples.push({ subject, predicate, object });
      }
    }
    return triples;
  }
}
