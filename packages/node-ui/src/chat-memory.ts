import { isSafeIri } from '@origintrail-official/dkg-core';
import { LlmClient } from './llm/client.js';
import type { LlmConfig } from './llm/types.js';

export interface MemoryToolContext {
  query: (sparql: string, opts?: { contextGraphId?: string; graphSuffix?: '_shared_memory'; includeSharedMemory?: boolean }) => Promise<any>;
  share: (contextGraphId: string, quads: any[], opts?: { localOnly?: boolean }) => Promise<{ shareOperationId: string }>;
  publishFromSharedMemory: (
    contextGraphId: string,
    selection: 'all' | { rootEntities: string[] },
    opts?: { clearSharedMemoryAfter?: boolean },
  ) => Promise<any>;
  createContextGraph: (opts: { id: string; name: string; description?: string; private?: boolean }) => Promise<void>;
  listContextGraphs: () => Promise<any[]>;
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

export const IMPORT_SOURCES = ['claude', 'chatgpt', 'gemini', 'other'] as const;
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

const MEMORY_CONTEXT_GRAPH = 'agent-memory';
const OPENCLAW_LOCAL_SESSION_ID = 'openclaw:dkg-ui';

const CHAT_NS = 'urn:dkg:chat:';
const MEMORY_NS = 'urn:dkg:memory:';
const SCHEMA = 'http://schema.org/';
const DKG_ONT = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const OPENCLAW_LOCAL_SESSION_URI = `${CHAT_NS}session:${OPENCLAW_LOCAL_SESSION_ID}`;

function stripRdfLiteral(value: string): string {
  if (!value) return '';
  const typed = value.match(/^"([\s\S]*)"(?:\^\^<[^>]+>)?(?:@[a-z-]+)?$/);
  if (typed) return typed[1];
  return value;
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

  if (sessionUri === OPENCLAW_LOCAL_SESSION_URI) {
    clauses.push(
      `{ ?s <${RDF_TYPE}> <${DKG_ONT}ImportedMemory> }`,
      `{ ?s <${RDF_TYPE}> <${DKG_ONT}MemoryImport> }`,
      `{
      ?s <${DKG_ONT}extractedFrom> ?batch .
      ?batch <${RDF_TYPE}> <${DKG_ONT}MemoryImport> .
      }`,
    );
  }

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

  constructor(
    private tools: MemoryToolContext,
    private llmConfig: LlmConfig,
  ) {}

  get contextGraphId(): string {
    return MEMORY_CONTEXT_GRAPH;
  }

  updateConfig(llmConfig: LlmConfig): void {
    this.llmConfig = llmConfig;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    try {
      const contextGraphs = await this.tools.listContextGraphs();
      const exists = contextGraphs.some(
        (p: any) => p.id === MEMORY_CONTEXT_GRAPH || p.contextGraphId === MEMORY_CONTEXT_GRAPH,
      );
      if (!exists) {
        await this.tools.createContextGraph({
          id: MEMORY_CONTEXT_GRAPH,
          name: 'Agent Memory',
          description: 'Local private memory for agent chat conversations and extracted knowledge.',
          private: true,
        });
      }
    } catch (err: any) {
      if (!err.message?.includes('already exists')) throw err;
    }

    // Pre-populate known sessions so subsequent writes to existing
    // sessions don't re-declare the session entity (DKG Rule 4).
    try {
      const result = await this.tools.query(
        `SELECT ?sid WHERE { ?s <${RDF_TYPE}> <${SCHEMA}Conversation> . ?s <${DKG_ONT}sessionId> ?sid }`,
        { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
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
    opts?: { turnId?: string; persistenceState?: 'stored' | 'failed' | 'pending' },
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
        { subject: userMsgUri, predicate: `${DKG_ONT}turnId`, object: JSON.stringify(turnId), graph: '' },
        { subject: assistantMsgUri, predicate: `${DKG_ONT}turnId`, object: JSON.stringify(turnId), graph: '' },
      );
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

    await this.tools.share(MEMORY_CONTEXT_GRAPH, quads, { localOnly: true });
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
      await this.tools.share(MEMORY_CONTEXT_GRAPH, quads, { localOnly: true });
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
    await this.tools.share(MEMORY_CONTEXT_GRAPH, quads, { localOnly: true });
    return triples.length;
  }

  async recall(sparql: string): Promise<any> {
    await this.ensureInitialized();
    return this.tools.query(sparql, { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true });
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
      contextGraphId: MEMORY_CONTEXT_GRAPH,
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
        { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
      );
      base.totalTriples = sumBindingValues(total.bindings, 'c');

      const sessions = await this.tools.query(
        `SELECT (COUNT(DISTINCT ?s) AS ?c) WHERE { ?s <${RDF_TYPE}> <${SCHEMA}Conversation> }`,
        { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
      );
      base.sessionCount = sumBindingValues(sessions.bindings, 'c');

      const msgs = await this.tools.query(
        `SELECT (COUNT(*) AS ?c) WHERE { ?s <${RDF_TYPE}> <${SCHEMA}Message> }`,
        { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
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
        { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
      );
      const chatTripleCount = sumBindingValues(chatRelatedTriples.bindings, 'c');

      const entities = await this.tools.query(
        `SELECT (COUNT(DISTINCT ?e) AS ?c) WHERE { ?e <${RDF_TYPE}> ?t . FILTER(STRSTARTS(STR(?e), "urn:dkg:entity:")) }`,
        { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
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
        { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
      );
      const entities: MemoryEntity[] = [];
      for (const b of result.bindings ?? []) {
        const uri = b.e;
        const propsResult = await this.tools.query(
          `SELECT ?p ?o WHERE { <${uri}> ?p ?o } LIMIT 20`,
          { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
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
  ): Promise<{
    session: string;
    messages: Array<{
      author: string;
      text: string;
      ts: string;
      turnId?: string;
      persistStatus?: 'pending' | 'in_progress' | 'stored' | 'failed' | 'skipped';
    }>;
  } | null> {
    await this.ensureInitialized();
    try {
      const sessionUri = `${CHAT_NS}session:${sessionId}`;
      const msgsResult = await this.tools.query(
        `SELECT ?author ?text ?ts ?turnId ?persistenceState WHERE {
          ?m <${SCHEMA}isPartOf> <${sessionUri}> .
          ?m <${SCHEMA}author> ?author .
          ?m <${SCHEMA}text> ?text .
          ?m <${SCHEMA}dateCreated> ?ts
          OPTIONAL { ?m <${DKG_ONT}turnId> ?turnId }
          OPTIONAL {
            ?turn <${RDF_TYPE}> <${DKG_ONT}ChatTurn> .
            ?turn <${SCHEMA}isPartOf> <${sessionUri}> .
            ?turn <${DKG_ONT}turnId> ?turnId .
            ?turn <${DKG_ONT}persistenceState> ?persistenceState .
          }
        } ORDER BY ?ts LIMIT 500`,
        { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
      );
      const bindings = msgsResult.bindings ?? [];
      if (bindings.length === 0) return null;
      return {
        session: sessionId,
        messages: bindings.map((mb: any) => ({
          author: mb.author?.includes('user') ? 'user' : 'agent',
          text: stripRdfLiteral(mb.text ?? ''),
          ts: stripRdfLiteral(mb.ts ?? ''),
          turnId: stripRdfLiteral(mb.turnId ?? '') || undefined,
          persistStatus: (() => {
            const status = stripRdfLiteral(mb.persistenceState ?? '').trim();
            if (status === 'pending' || status === 'in_progress' || status === 'stored' || status === 'failed' || status === 'skipped') {
              return status;
            }
            return undefined;
          })(),
        })),
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
        { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
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
        { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
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
      { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
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

    const turnUri = `${CHAT_NS}turn:${turnId}`;
    const currentTurnResult = await this.tools.query(
      `SELECT ?tid ?ts WHERE {
        <${turnUri}> <${RDF_TYPE}> <${DKG_ONT}ChatTurn> .
        <${turnUri}> <${SCHEMA}isPartOf> <${sessionUri}> .
        <${turnUri}> <${DKG_ONT}turnId> ?tid .
        OPTIONAL { <${turnUri}> <${SCHEMA}dateCreated> ?ts }
      } LIMIT 1`,
      { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
    );
    const currentTurn = (currentTurnResult.bindings ?? [])[0];
    const currentTurnId = stripRdfLiteral(currentTurn?.tid ?? '').trim();
    const currentTurnTs = stripRdfLiteral(currentTurn?.ts ?? '').trim();
    const latestTurnResult = await this.tools.query(
      `SELECT ?latestTurnId ?latestTs WHERE {
        ?latestTurn <${RDF_TYPE}> <${DKG_ONT}ChatTurn> .
        ?latestTurn <${SCHEMA}isPartOf> <${sessionUri}> .
        ?latestTurn <${DKG_ONT}turnId> ?latestTurnId .
        OPTIONAL { ?latestTurn <${SCHEMA}dateCreated> ?latestTs }
      } ORDER BY DESC(?latestTs) DESC(?latestTurnId) LIMIT 1`,
      { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
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

    const currentTurnIdLiteral = JSON.stringify(currentTurnId);
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
      { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
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
          { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
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
      { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
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
      { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
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
      { contextGraphId: MEMORY_CONTEXT_GRAPH, includeSharedMemory: true },
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
      contextGraphId: MEMORY_CONTEXT_GRAPH,
      graphSuffix: '_shared_memory',
    });
    const dataCountResult = await this.tools.query(countQuery, {
      contextGraphId: MEMORY_CONTEXT_GRAPH,
    });

    const rootEntityResult = await this.tools.query(
      `SELECT DISTINCT ?s WHERE ${rootPattern} LIMIT 5000`,
      { contextGraphId: MEMORY_CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
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
      { contextGraphId: MEMORY_CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
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

  async importMemories(
    rawText: string,
    source: ImportSource = 'other',
    opts: { useLlm?: boolean } = {},
  ): Promise<ImportResult> {
    await this.ensureInitialized();
    const batchId = crypto.randomUUID();
    const batchUri = `${MEMORY_NS}import:${batchId}`;
    const now = new Date().toISOString();

    const llmEnabled = opts.useLlm === true && !!this.llmConfig?.apiKey;
    const warnings: string[] = [];

    let memories = llmEnabled
      ? await this.parseMemoriesWithLlm(rawText)
      : this.parseMemoriesHeuristic(rawText);

    if (memories.length === 0 && llmEnabled) {
      memories = this.parseMemoriesHeuristic(rawText);
    }

    if (memories.length === 0) {
      return { batchId: null, source, memoryCount: 0, tripleCount: 0, entityCount: 0, quads: [] };
    }

    const MAX_MEMORY_ITEMS = 5000;
    if (memories.length > MAX_MEMORY_ITEMS) {
      warnings.push(`Input contained ${memories.length} items; truncated to ${MAX_MEMORY_ITEMS}`);
      memories = memories.slice(0, MAX_MEMORY_ITEMS);
    }

    const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];

    quads.push(
      { subject: batchUri, predicate: RDF_TYPE, object: `${DKG_ONT}MemoryImport`, graph: '' },
      { subject: batchUri, predicate: `${DKG_ONT}importSource`, object: `"${source}"`, graph: '' },
      { subject: batchUri, predicate: `${SCHEMA}dateCreated`, object: `"${now}"^^<${XSD_DATETIME}>`, graph: '' },
      { subject: batchUri, predicate: `${DKG_ONT}itemCount`, object: `"${memories.length}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: '' },
    );

    for (const mem of memories) {
      const memUri = `${MEMORY_NS}item:${crypto.randomUUID()}`;
      quads.push(
        { subject: memUri, predicate: RDF_TYPE, object: `${DKG_ONT}ImportedMemory`, graph: '' },
        { subject: memUri, predicate: `${SCHEMA}text`, object: JSON.stringify(mem.text), graph: '' },
        { subject: memUri, predicate: `${DKG_ONT}category`, object: `"${mem.category}"`, graph: '' },
        { subject: memUri, predicate: `${SCHEMA}dateCreated`, object: `"${now}"^^<${XSD_DATETIME}>`, graph: '' },
        { subject: memUri, predicate: `${DKG_ONT}importBatch`, object: batchUri, graph: '' },
        { subject: memUri, predicate: `${DKG_ONT}importSource`, object: `"${source}"`, graph: '' },
      );
    }

    await this.tools.share(MEMORY_CONTEXT_GRAPH, quads, { localOnly: true });

    let entityCount = 0;
    let extractionTripleCount = 0;
    const allQuads = quads.map(q => ({ subject: q.subject, predicate: q.predicate, object: q.object }));
    if (llmEnabled) {
      try {
        const extraction = await this.extractKnowledgeFromImport(batchUri, memories);
        entityCount = extraction.entityCount;
        extractionTripleCount = extraction.tripleCount;
        allQuads.push(...extraction.quads);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.warn(`[ChatMemoryManager] Knowledge extraction failed for batch ${batchId}: ${msg}`);
        warnings.push(`Knowledge extraction failed: ${msg}`);
      }
    }

    const QUAD_PREVIEW_LIMIT = 500;
    const result: ImportResult = {
      batchId,
      source,
      memoryCount: memories.length,
      tripleCount: quads.length + extractionTripleCount,
      entityCount,
      quads: allQuads.slice(0, QUAD_PREVIEW_LIMIT),
      quadsTruncated: allQuads.length > QUAD_PREVIEW_LIMIT,
    };
    if (warnings.length > 0) result.warnings = warnings;
    return result;
  }

  private async parseMemoriesWithLlm(
    rawText: string,
  ): Promise<Array<{ text: string; category: string }>> {
    const { apiKey, model = 'gpt-5-mini', baseURL = 'https://api.openai.com/v1' } = this.llmConfig;
    if (!apiKey) return this.parseMemoriesHeuristic(rawText);

    const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;
    try {
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: 'system', content: MEMORY_PARSE_PROMPT },
          { role: 'user', content: rawText },
        ],
      };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) return this.parseMemoriesHeuristic(rawText);
      const data = (await res.json()) as any;
      let output = data.choices?.[0]?.message?.content?.trim() ?? '';
      output = output.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
      const parsed = JSON.parse(output);
      if (!Array.isArray(parsed)) return this.parseMemoriesHeuristic(rawText);
      const extractText = (m: any): string =>
        (typeof m.text === 'string' && m.text.trim()) ||
        (typeof m.memory === 'string' && m.memory.trim()) ||
        (typeof m.content === 'string' && m.content.trim()) ||
        '';
      const results = parsed
        .filter((m: any) => extractText(m).length > 0)
        .map((m: any) => ({
          text: extractText(m),
          category: ['preference', 'fact', 'context', 'instruction', 'relationship'].includes(m.category)
            ? m.category
            : 'fact',
        }));
      if (results.length === 0) return this.parseMemoriesHeuristic(rawText);
      return results;
    } catch {
      return this.parseMemoriesHeuristic(rawText);
    }
  }

  parseMemoriesHeuristic(rawText: string): Array<{ text: string; category: string }> {
    const lines = rawText
      .split(/\n/)
      .map(l => l.replace(/^\s*(?:[-•*]\s+|\d+[.)]\s)\s*/, '').trim())
      .filter(l =>
        l.length > 3 &&
        !l.match(/^(here are|last updated|memories|---)/i) &&
        !l.match(/^```/),
      );
    return lines.map(text => ({ text, category: 'fact' }));
  }

  private async extractKnowledgeFromImport(
    batchUri: string,
    memories: Array<{ text: string; category: string }>,
  ): Promise<{ entityCount: number; tripleCount: number; quads: Array<{ subject: string; predicate: string; object: string }> }> {
    const empty = { entityCount: 0, tripleCount: 0, quads: [] };
    const combined = memories.map((m, i) => `${i + 1}. ${m.text}`).join('\n');
    const { apiKey, model = 'gpt-5-mini', baseURL = 'https://api.openai.com/v1' } = this.llmConfig;
    const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;

    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: MEMORY_KG_PROMPT },
        { role: 'user', content: combined },
      ],
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });

    if (!res.ok) return empty;
    const data = (await res.json()) as any;
    const output = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!output || output === 'NONE') return empty;

    const triples = this.parseNTriples(output);
    if (triples.length === 0) return empty;

    const quads: Array<{ subject: string; predicate: string; object: string; graph: string }> = [];
    for (const t of triples) {
      quads.push({ ...t, graph: '' });
    }
    const rootEntities = new Set(triples.map(t => t.subject));
    for (const entity of rootEntities) {
      quads.push(
        { subject: entity, predicate: `${DKG_ONT}extractedFrom`, object: batchUri, graph: '' },
      );
    }
    await this.tools.share(MEMORY_CONTEXT_GRAPH, quads, { localOnly: true });
    return {
      entityCount: rootEntities.size,
      tripleCount: quads.length,
      quads: quads.map(q => ({ subject: q.subject, predicate: q.predicate, object: q.object })),
    };
  }

  async publishFromSwm(
    selection: 'all' | { rootEntities: string[] } = 'all',
    opts?: { clearSharedMemoryAfter?: boolean },
  ): Promise<PublishFromSwmResult> {
    await this.ensureInitialized();
    const result = await this.tools.publishFromSharedMemory(MEMORY_CONTEXT_GRAPH, selection, {
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
