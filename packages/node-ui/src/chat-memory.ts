import type { LlmConfig } from './chat-assistant.js';

export interface MemoryToolContext {
  query: (sparql: string, opts?: { paranetId?: string; graphSuffix?: '_workspace'; includeWorkspace?: boolean }) => Promise<any>;
  writeToWorkspace: (paranetId: string, quads: any[], opts?: { localOnly?: boolean }) => Promise<{ workspaceOperationId: string }>;
  enshrineFromWorkspace: (
    paranetId: string,
    selection: 'all' | { rootEntities: string[] },
    opts?: { clearWorkspaceAfter?: boolean },
  ) => Promise<any>;
  createParanet: (opts: { id: string; name: string; description?: string; private?: boolean }) => Promise<void>;
  listParanets: () => Promise<any[]>;
}

export interface MemoryStats {
  paranetId: string;
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

export interface EnshrineResult {
  kcId?: bigint;
  ual?: string;
  status: string;
  tripleCount: number;
}

const MEMORY_PARANET = 'agent-memory';

const CHAT_NS = 'urn:dkg:chat:';
const MEMORY_NS = 'urn:dkg:memory:';
const SCHEMA = 'http://schema.org/';
const DKG_ONT = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

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

  constructor(
    private tools: MemoryToolContext,
    private llmConfig: LlmConfig,
  ) {}

  get paranetId(): string {
    return MEMORY_PARANET;
  }

  updateConfig(llmConfig: LlmConfig): void {
    this.llmConfig = llmConfig;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    try {
      const paranets = await this.tools.listParanets();
      const exists = paranets.some(
        (p: any) => p.id === MEMORY_PARANET || p.paranetId === MEMORY_PARANET,
      );
      if (!exists) {
        await this.tools.createParanet({
          id: MEMORY_PARANET,
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
        { paranetId: MEMORY_PARANET, includeWorkspace: true },
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
  ): Promise<void> {
    await this.ensureInitialized();
    const userTs = new Date();
    const agentTs = new Date(userTs.getTime() + 1);
    const sessionUri = `${CHAT_NS}session:${sessionId}`;
    const userMsgId = crypto.randomUUID().slice(0, 8);
    const assistantMsgId = crypto.randomUUID().slice(0, 8);
    const userMsgUri = `${CHAT_NS}msg:${userMsgId}`;
    const assistantMsgUri = `${CHAT_NS}msg:${assistantMsgId}`;

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
    );

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

    await this.tools.writeToWorkspace(MEMORY_PARANET, quads, { localOnly: true });
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
      await this.tools.writeToWorkspace(MEMORY_PARANET, quads, { localOnly: true });
    }
  }

  private async callMentionExtraction(text: string): Promise<Array<{ name: string; type: string }>> {
    const { apiKey, model = 'gpt-4o-mini', baseURL = 'https://api.openai.com/v1' } = this.llmConfig;
    if (!apiKey) return [];

    const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: MENTION_EXTRACTION_PROMPT },
            { role: 'user', content: text },
          ],
          temperature: 0,
          max_tokens: 512,
        }),
      });
      if (!res.ok) return [];
      const data = await res.json() as any;
      let output = data.choices?.[0]?.message?.content?.trim() ?? '';
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
    const { apiKey, model = 'gpt-4o-mini', baseURL = 'https://api.openai.com/v1' } = this.llmConfig;
    const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: KG_EXTRACTION_PROMPT },
          { role: 'user', content: exchange },
        ],
        temperature: 0.1,
        max_tokens: 1024,
      }),
    });

    if (!res.ok) return 0;
    const data = await res.json() as any;
    const output = data.choices?.[0]?.message?.content?.trim() ?? '';
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
    await this.tools.writeToWorkspace(MEMORY_PARANET, quads, { localOnly: true });
    return triples.length;
  }

  async recall(sparql: string): Promise<any> {
    await this.ensureInitialized();
    return this.tools.query(sparql, { paranetId: MEMORY_PARANET, includeWorkspace: true });
  }

  async semanticRecall(question: string): Promise<{ sparql: string; result: any }> {
    const { apiKey, model = 'gpt-4o-mini', baseURL = 'https://api.openai.com/v1' } = this.llmConfig;
    const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SEMANTIC_RECALL_SYSTEM },
          { role: 'user', content: question },
        ],
        temperature: 0.1,
        max_tokens: 512,
      }),
    });

    if (!res.ok) throw new Error(`LLM API ${res.status}`);
    const data = await res.json() as any;
    let sparql = data.choices?.[0]?.message?.content?.trim() ?? '';
    sparql = sparql.replace(/^```(?:sparql)?\n?/i, '').replace(/\n?```$/i, '').trim();

    const result = await this.recall(sparql);
    return { sparql, result };
  }

  async getStats(): Promise<MemoryStats> {
    await this.ensureInitialized();
    const base: MemoryStats = {
      paranetId: MEMORY_PARANET,
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
        { paranetId: MEMORY_PARANET, includeWorkspace: true },
      );
      base.totalTriples = sumBindingValues(total.bindings, 'c');

      const sessions = await this.tools.query(
        `SELECT (COUNT(DISTINCT ?s) AS ?c) WHERE { ?s <${RDF_TYPE}> <${SCHEMA}Conversation> }`,
        { paranetId: MEMORY_PARANET, includeWorkspace: true },
      );
      base.sessionCount = sumBindingValues(sessions.bindings, 'c');

      const msgs = await this.tools.query(
        `SELECT (COUNT(*) AS ?c) WHERE { ?s <${RDF_TYPE}> <${SCHEMA}Message> }`,
        { paranetId: MEMORY_PARANET, includeWorkspace: true },
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
        { paranetId: MEMORY_PARANET, includeWorkspace: true },
      );
      const chatTripleCount = sumBindingValues(chatRelatedTriples.bindings, 'c');

      const entities = await this.tools.query(
        `SELECT (COUNT(DISTINCT ?e) AS ?c) WHERE { ?e <${RDF_TYPE}> ?t . FILTER(STRSTARTS(STR(?e), "urn:dkg:entity:")) }`,
        { paranetId: MEMORY_PARANET, includeWorkspace: true },
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
        { paranetId: MEMORY_PARANET, includeWorkspace: true },
      );
      const entities: MemoryEntity[] = [];
      for (const b of result.bindings ?? []) {
        const uri = b.e;
        const propsResult = await this.tools.query(
          `SELECT ?p ?o WHERE { <${uri}> ?p ?o } LIMIT 20`,
          { paranetId: MEMORY_PARANET, includeWorkspace: true },
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

  async getSession(sessionId: string): Promise<{ session: string; messages: Array<{ author: string; text: string; ts: string }> } | null> {
    await this.ensureInitialized();
    try {
      const sessionUri = `${CHAT_NS}session:${sessionId}`;
      const msgsResult = await this.tools.query(
        `SELECT ?author ?text ?ts WHERE {
          ?m <${SCHEMA}isPartOf> <${sessionUri}> .
          ?m <${SCHEMA}author> ?author .
          ?m <${SCHEMA}text> ?text .
          ?m <${SCHEMA}dateCreated> ?ts
        } ORDER BY ?ts LIMIT 500`,
        { paranetId: MEMORY_PARANET, includeWorkspace: true },
      );
      const bindings = msgsResult.bindings ?? [];
      if (bindings.length === 0) return null;
      return {
        session: sessionId,
        messages: bindings.map((mb: any) => ({
          author: mb.author?.includes('user') ? 'user' : 'agent',
          text: stripRdfLiteral(mb.text ?? ''),
          ts: stripRdfLiteral(mb.ts ?? ''),
        })),
      };
    } catch {
      return null;
    }
  }

  async getRecentChats(limit = 20): Promise<Array<{ session: string; messages: Array<{ author: string; text: string; ts: string }> }>> {
    await this.ensureInitialized();
    try {
      const sessionsResult = await this.tools.query(
        `SELECT ?s ?sid (MAX(?mts) AS ?latest) WHERE {
          ?s <${RDF_TYPE}> <${SCHEMA}Conversation> .
          ?s <${DKG_ONT}sessionId> ?sid .
          OPTIONAL { ?m <${SCHEMA}isPartOf> ?s . ?m <${SCHEMA}dateCreated> ?mts }
        } GROUP BY ?s ?sid ORDER BY DESC(?latest) LIMIT ${limit}`,
        { paranetId: MEMORY_PARANET, includeWorkspace: true },
      );
      const chats: Array<{ session: string; messages: Array<{ author: string; text: string; ts: string }> }> = [];
      for (const sb of sessionsResult.bindings ?? []) {
        const msgsResult = await this.tools.query(
          `SELECT ?author ?text ?ts WHERE {
            ?m <${SCHEMA}isPartOf> <${sb.s}> .
            ?m <${SCHEMA}author> ?author .
            ?m <${SCHEMA}text> ?text .
            ?m <${SCHEMA}dateCreated> ?ts
          } ORDER BY ?ts LIMIT 100`,
          { paranetId: MEMORY_PARANET, includeWorkspace: true },
        );
        const sessionId = stripRdfLiteral(sb.sid ?? sb.s);
        chats.push({
          session: sessionId,
          messages: (msgsResult.bindings ?? []).map((mb: any) => ({
            author: mb.author?.includes('user') ? 'user' : 'agent',
            text: stripRdfLiteral(mb.text ?? ''),
            ts: stripRdfLiteral(mb.ts ?? ''),
          })),
        });
      }
      return chats;
    } catch {
      return [];
    }
  }

  async enshrine(
    selection: 'all' | { rootEntities: string[] } = 'all',
    opts?: { clearWorkspaceAfter?: boolean },
  ): Promise<EnshrineResult> {
    await this.ensureInitialized();
    const result = await this.tools.enshrineFromWorkspace(MEMORY_PARANET, selection, {
      clearWorkspaceAfter: opts?.clearWorkspaceAfter ?? false,
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
