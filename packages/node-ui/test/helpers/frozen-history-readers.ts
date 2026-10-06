// SPDX-License-Identifier: Apache-2.0
/**
 * FROZEN COPY of the two chat-history readers of `ChatMemoryManager`
 * (`getSession` and `getRecentChats`, with the private helpers they call) as
 * they were right after testnet-canary was merged into the persist-turn dedupe
 * branch, before the message-assembly refactor. The
 * differential tests run this reader and the current `ChatMemoryManager` over
 * the same rows and require the same output, so that refactor is shown to
 * change nothing. Do NOT "fix" or modernize anything below the marker: its
 * whole value is that it does not follow `src/chat-memory.ts`.
 *
 * Everything between the two markers is copied verbatim from
 * `packages/node-ui/src/chat-memory.ts` as of that merge, query texts included (the
 * differential compares them). The methods sit in a small class that supplies
 * what they reach through `this`: `tools`, a no-op `ensureInitialized` (the
 * manager's own initialisation is not a history read) and `wmReadOpts`, the
 * options object the manager builds for its default assertion. The turn-subject
 * pattern (`chatTurnSubjectPattern`) is imported, not copied: it is not part of
 * the refactor and the readers' queries embed it.
 */
import { isSafeIri } from '@origintrail-official/dkg-core';
import { chatTurnSubjectPattern } from '../../src/chat-turn-subject.js';
import { decodeRdfStringLiteral } from '../../src/rdf-literal.js';

const CHAT_NS = 'urn:dkg:chat:';
const SCHEMA = 'http://schema.org/';
const DKG_ONT = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const CHAT_ATTACHMENT_REFS_PREDICATE = `${DKG_ONT}attachmentRefs`;
const CHAT_TURN_PERSISTENCE_TRANSITION_TYPE = `${DKG_ONT}ChatTurnPersistenceTransition`;
const CHAT_TURN_PERSISTENCE_TRANSITION_PREDICATE = `${DKG_ONT}updatesTurn`;

type ChatTurnPersistenceDisplayState = 'pending' | 'in_progress' | 'stored' | 'failed' | 'skipped';
const PERSISTENCE_STATUS_RANK: Record<ChatTurnPersistenceDisplayState, number> = {
  skipped: 1,
  pending: 2,
  in_progress: 3,
  failed: 4,
  stored: 5,
};

// ---- BEGIN verbatim copy from src/chat-memory.ts (as of the merge of testnet-canary) ----

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

interface ChatToolCall {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

function stripRdfLiteral(value: string): string {
  if (!value) return '';
  const typed = value.match(/^"([\s\S]*)"(?:\^\^<[^>]+>)?(?:@[a-z-]+)?$/);
  if (typed) return typed[1];
  return value;
}

function normalizePersistenceStatus(value: string): ChatTurnPersistenceDisplayState | undefined {
  const status = stripRdfLiteral(value).trim();
  if (status === 'pending' || status === 'in_progress' || status === 'stored' || status === 'failed' || status === 'skipped') {
    return status;
  }
  return undefined;
}

function choosePersistenceStatus(
  current: ChatTurnPersistenceDisplayState | undefined,
  candidate: ChatTurnPersistenceDisplayState | undefined,
): ChatTurnPersistenceDisplayState | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  return PERSISTENCE_STATUS_RANK[candidate] > PERSISTENCE_STATUS_RANK[current] ? candidate : current;
}

/**
 * The reply a turn's agent message shows once the turn completed, or `undefined`
 * when this row does not complete it.
 *
 * A turn that first reported `pending` or `failed` and completed later is not
 * written a second time: a `stored` transition records the completion and
 * carries the final reply, and the assistant Message keeps the `schema:text`
 * of the first report. Every reader that returns a turn's reply has to resolve
 * it through here, so `getSession` and `getRecentChats` cannot disagree about
 * which reply a turn ended with. `row` is one result row of a query that joins
 * a turn to its transitions.
 *
 * The transition's `assistantReply` is written with `JSON.stringify`, exactly
 * like the base `schema:text`, so it needs the same decode. Without it a
 * stored turn (the dominant path on reload) would replace the correctly decoded
 * base text with a literal-`\n` string and markdown would break after a refresh.
 */
function completedTurnReply(row: {
  transitionState?: string;
  persistenceState?: string;
  transitionAssistantReply?: string;
}): string | undefined {
  const status = normalizePersistenceStatus(row.transitionState ?? row.persistenceState ?? '');
  const reply = String(row.transitionAssistantReply ?? '');
  return status === 'stored' && reply ? decodeRdfStringLiteral(reply) : undefined;
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

function normalizeChatToolCall(raw: unknown): ChatToolCall | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'unknown';
  return {
    name,
    args: record.args && typeof record.args === 'object' && !Array.isArray(record.args)
      ? record.args as Record<string, unknown>
      : {},
    result: record.result,
  };
}

function normalizeChatToolCalls(raw: unknown): ChatToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const calls = raw
    .map((entry) => normalizeChatToolCall(entry))
    .filter((entry): entry is ChatToolCall => entry != null);
  return calls.length > 0 ? calls : undefined;
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

function parseToolCallsLiteral(value: string): ChatToolCall[] | undefined {
  const candidates = [value, stripRdfLiteral(value)]
    .map((candidate) => candidate.trim())
    .filter((candidate, index, all) => candidate.length > 0 && all.indexOf(candidate) === index);

  for (const candidate of candidates) {
    const parsed = parseNestedJsonLiteral(candidate) ?? parseNestedJsonLiteral(JSON.stringify(candidate));
    const normalized = normalizeChatToolCalls(parsed);
    if (normalized?.length) return normalized;
  }
  return undefined;
}

// ---- the two methods, inside the class below ----

export class FrozenChatHistoryReaders {
  readonly agentAddress: string | undefined;

  constructor(
    private tools: { query: (sparql: string, opts?: unknown) => Promise<any> },
    agentAddress?: string,
  ) {
    this.agentAddress = agentAddress;
  }

  private async ensureInitialized(): Promise<void> {}

  private wmReadOpts() {
    return {
      contextGraphId: 'agent-context',
      view: 'working-memory' as const,
      agentAddress: this.agentAddress,
      assertionName: 'chat-turns',
    };
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
      toolCalls?: ChatToolCall[];
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
        `SELECT ?m ?author ?text ?ts ?turnId ?persistenceState ?transitionState ?attachmentRefs ?failureReason ?transitionFailureReason ?transitionAssistantReply ?transitionAttachmentRefs ?transitionToolCalls WHERE {
          {
            SELECT ?m ?ts WHERE {
              ?m <${SCHEMA}isPartOf> <${sessionUri}> .
              ?m <${SCHEMA}dateCreated> ?ts
            } ORDER BY ${order}(?ts) LIMIT ${limit}
          }
          ?m <${SCHEMA}isPartOf> <${sessionUri}> .
          ?m <${SCHEMA}author> ?author .
          ?m <${SCHEMA}text> ?text .
          ?m <${SCHEMA}dateCreated> ?ts
          OPTIONAL { ?m <${DKG_ONT}turnId> ?turnId }
          OPTIONAL { ?m <${CHAT_ATTACHMENT_REFS_PREDICATE}> ?attachmentRefs }
          OPTIONAL {
            ${chatTurnSubjectPattern(`<${sessionUri}>`, '?turn', '?turnId')}
            OPTIONAL { ?turn <${DKG_ONT}persistenceState> ?persistenceState }
            OPTIONAL { ?turn <${DKG_ONT}failureReason> ?failureReason }
            OPTIONAL {
              ?transition <${RDF_TYPE}> <${CHAT_TURN_PERSISTENCE_TRANSITION_TYPE}> .
              ?transition <${CHAT_TURN_PERSISTENCE_TRANSITION_PREDICATE}> ?turn .
              ?transition <${DKG_ONT}persistenceState> ?transitionState .
              OPTIONAL { ?transition <${DKG_ONT}failureReason> ?transitionFailureReason }
              OPTIONAL { ?transition <${DKG_ONT}assistantReply> ?transitionAssistantReply }
              OPTIONAL { ?transition <${CHAT_ATTACHMENT_REFS_PREDICATE}> ?transitionAttachmentRefs }
              OPTIONAL { ?transition <${DKG_ONT}toolCalls> ?transitionToolCalls }
            }
          }
        } ORDER BY ${order}(?ts)`,
        this.wmReadOpts(),
      );
      const bindings = msgsResult.bindings ?? [];
      if (bindings.length === 0) return null;
      const messagesByUri = new Map<string, {
        uri: string;
        author: string;
        text: string;
        ts: string;
        turnId?: string;
        persistStatus?: ChatTurnPersistenceDisplayState;
        failureReason?: string | null;
        attachmentRefs?: ChatAttachmentRef[];
        toolCalls?: ChatToolCall[];
      }>();
      for (const mb of bindings) {
        const uri = String(mb.m ?? '').replace(/[<>]/g, '');
        const key = uri || `${String(mb.author ?? '')}:${String(mb.ts ?? '')}:${String(mb.text ?? '')}`;
        let message = messagesByUri.get(key);
        if (!message) {
          message = {
            uri,
            author: mb.author?.includes('user') ? 'user' : 'agent',
            text: decodeRdfStringLiteral(mb.text ?? ''),
            ts: stripRdfLiteral(mb.ts ?? ''),
            turnId: stripRdfLiteral(mb.turnId ?? '') || undefined,
            attachmentRefs: parseAttachmentRefsLiteral(String(mb.attachmentRefs ?? '')),
          };
          messagesByUri.set(key, message);
        }
        const candidateStatus = normalizePersistenceStatus(mb.transitionState ?? mb.persistenceState ?? '');
        const completedReply = completedTurnReply(mb);
        if (message.author === 'agent' && completedReply !== undefined) {
          message.text = completedReply;
        }
        const transitionAttachmentRefs = parseAttachmentRefsLiteral(String(mb.transitionAttachmentRefs ?? ''));
        if (message.author === 'user' && candidateStatus === 'stored' && transitionAttachmentRefs?.length) {
          message.attachmentRefs = transitionAttachmentRefs;
        }
        const transitionToolCalls = parseToolCallsLiteral(String(mb.transitionToolCalls ?? ''));
        if (message.author === 'agent' && candidateStatus === 'stored' && transitionToolCalls?.length) {
          message.toolCalls = transitionToolCalls;
        }
        message.persistStatus = choosePersistenceStatus(message.persistStatus, candidateStatus);
        const candidateReason = stripRdfLiteral(mb.transitionFailureReason ?? mb.failureReason ?? '').trim();
        if (candidateStatus === 'failed' && candidateReason) {
          message.failureReason = candidateReason;
        }
        if (message.persistStatus && message.persistStatus !== 'failed') {
          message.failureReason = undefined;
        }
      }
      return {
        session: sessionId,
        messages: [...messagesByUri.values()],
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

      // One round trip for both: the messages of the listed sessions, and the
      // turns among them that completed by a `stored` transition. Such a turn
      // keeps the reply of its first report on its assistant Message and carries
      // the final one on the transition, so each message is joined to the
      // transitions of the turn it is the assistant Message of (through the
      // turn's `hasAssistantMessage` link), and `completedTurnReply`, the
      // resolver `getSession` uses, decides which reply wins. The turn is matched
      // to its transitions through its own session link, so a turn of another
      // session that reuses the id never contributes.
      //
      // A legacy turn subject that two sessions share links the assistant
      // Message of both, and a transition on it does not say whose completion
      // it is. Such a subject contributes no completion here, so the list keeps
      // each session's reply as it was written and never shows one session the
      // other's (see `chatTurnSubjectPattern`).
      //
      // The completed turns are an independent subquery over the listed
      // sessions' turns, joined to the messages on the assistant Message. The
      // query must not use a UNION: a read of the working-memory view can span
      // more than one graph (a by-name read also includes the assertion's scoped
      // child graphs, and an agent address can have several candidate layer
      // graphs), and the query engine refuses a UNION combined with ORDER BY
      // across graphs, so the whole list would come back empty. An OPTIONAL
      // join of `turnId` onto every message would cost more on this query, and
      // would pair a message that has no `turnId` with the transitions of the
      // session's other turns.
      const allMsgs = await this.tools.query(
        `SELECT ?session ?author ?text ?ts ?m ?transitionState ?transitionAssistantReply WHERE {
          VALUES ?session { ${values} }
          ?m <${SCHEMA}isPartOf> ?session .
          ?m <${SCHEMA}author> ?author .
          ?m <${SCHEMA}text> ?text .
          ?m <${SCHEMA}dateCreated> ?ts
          OPTIONAL {
            {
              SELECT ?m ?transitionState ?transitionAssistantReply ?transitionTs WHERE {
                VALUES ?turnSession { ${values} }
                ?turn <${SCHEMA}isPartOf> ?turnSession .
                ?transition <${CHAT_TURN_PERSISTENCE_TRANSITION_PREDICATE}> ?turn .
                ?turn <${RDF_TYPE}> <${DKG_ONT}ChatTurn> .
                ?transition <${RDF_TYPE}> <${CHAT_TURN_PERSISTENCE_TRANSITION_TYPE}> .
                ?transition <${DKG_ONT}persistenceState> ?transitionState .
                ?transition <${DKG_ONT}assistantReply> ?transitionAssistantReply .
                ?turn <${DKG_ONT}hasAssistantMessage> ?m .
                OPTIONAL { ?transition <${SCHEMA}dateCreated> ?transitionTs }
                FILTER NOT EXISTS {
                  ?turn <${SCHEMA}isPartOf> ?otherSession .
                  FILTER(?otherSession != ?turnSession)
                }
              }
            }
          }
        } ORDER BY ?session ?ts ?transitionTs`,
        this.wmReadOpts(),
      );

      const bySession = new Map<string, Array<{ uri: string; author: string; text: string; ts: string }>>();
      // A message with several transitions comes back once per transition, in
      // transition order (the rows of one message are adjacent and ordered by
      // `transitionTs`), so the first row lists the message and the latest
      // completion wins.
      const listedMessages = new Set<string>();
      const completedReplies = new Map<string, string>();
      for (const row of allMsgs.bindings ?? []) {
        const uri = String(row.m ?? '').replace(/[<>]/g, '');
        if (uri && row.transitionAssistantReply) {
          const reply = completedTurnReply(row);
          if (reply !== undefined) completedReplies.set(uri, reply);
        }
        if (uri && listedMessages.has(uri)) continue;
        if (uri) listedMessages.add(uri);
        const sessionUri = String(row.session ?? '').replace(/[<>]/g, '');
        if (!sessionUri) continue;
        if (!bySession.has(sessionUri)) bySession.set(sessionUri, []);
        const msgs = bySession.get(sessionUri)!;
        if (msgs.length >= 100) continue;
        msgs.push({
          uri,
          author: row.author?.includes('user') ? 'user' : 'agent',
          text: decodeRdfStringLiteral(row.text ?? ''),
          ts: stripRdfLiteral(row.ts ?? ''),
        });
      }
      for (const msgs of bySession.values()) {
        for (const msg of msgs) {
          const completedReply = msg.author === 'agent' ? completedReplies.get(msg.uri) : undefined;
          if (completedReply !== undefined) msg.text = completedReply;
        }
      }

      return sessionEntries.map((entry: { sessionUri: string; sessionId: string }) => ({
        session: entry.sessionId,
        messages: (bySession.get(entry.sessionUri) ?? []).map(({ author, text, ts }) => ({ author, text, ts })),
      }));
    } catch {
      return [];
    }
  }

  // ---- END verbatim copy ----
}
