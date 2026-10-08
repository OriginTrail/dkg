// SPDX-License-Identifier: Apache-2.0
/**
 * Assembly of chat-history messages from the rows a history query returns, for
 * the two readers of `ChatMemoryManager`: `getSession` (one session, every
 * field) and `getRecentChats` (many sessions in one batch, `author`, `text` and
 * `ts` only).
 *
 * Both queries return a message once per transition of its turn. Both readers
 * therefore keep ONE accumulated message per message URI: the row that first
 * names a message creates it (`historyMessageFromRow`), and every row of it,
 * that first one included, folds its transition columns into that same object
 * (`mergeTransitionRow`). A session holds references to those objects, so a
 * later row's completion shows in the session's list without a second pass. The
 * two readers share the creating and the folding helpers and differ only in how
 * they index the messages (`foldSessionRows`, `foldListedRows`).
 */
import { decodeRdfStringLiteral } from './rdf-literal.js';
import {
  choosePersistenceStatus,
  normalizePersistenceStatus,
  parseAttachmentRefsLiteral,
  parseToolCallsLiteral,
  stripRdfLiteral,
  type ChatAttachmentRef,
  type ChatToolCall,
  type ChatTurnPersistenceDisplayState,
} from './chat-literals.js';

/** The most messages the session list returns for one session. */
export const SESSION_LIST_MESSAGE_LIMIT = 100;

type HistoryRow = Record<string, string>;

/** One message of a chat history, as the two history readers accumulate it. */
export interface ChatHistoryMessage {
  uri: string;
  author: string;
  text: string;
  ts: string;
  turnId?: string;
  persistStatus?: ChatTurnPersistenceDisplayState;
  failureReason?: string | null;
  attachmentRefs?: ChatAttachmentRef[];
  toolCalls?: ChatToolCall[];
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
export function completedTurnReply(row: {
  transitionState?: string;
  persistenceState?: string;
  transitionAssistantReply?: string;
}): string | undefined {
  const status = normalizePersistenceStatus(row.transitionState ?? row.persistenceState ?? '');
  const reply = String(row.transitionAssistantReply ?? '');
  return status === 'stored' && reply ? decodeRdfStringLiteral(reply) : undefined;
}

/** The URI a history row names its message by, or `''` when it names none. */
function historyRowUri(row: HistoryRow): string {
  return String(row.m ?? '').replace(/[<>]/g, '');
}

/**
 * A new message from the row that first names it: what the message itself says
 * (author, text, timestamp, and the turn id and attachment refs when the row
 * carries them). What the turn's transitions say about it comes from
 * `mergeTransitionRow`, which the readers apply to every row of the message,
 * this first one included.
 */
function historyMessageFromRow(row: HistoryRow, uri: string): ChatHistoryMessage {
  return {
    uri,
    author: row.author?.includes('user') ? 'user' : 'agent',
    text: decodeRdfStringLiteral(row.text ?? ''),
    ts: stripRdfLiteral(row.ts ?? ''),
    turnId: stripRdfLiteral(row.turnId ?? '') || undefined,
    attachmentRefs: parseAttachmentRefsLiteral(String(row.attachmentRefs ?? '')),
  };
}

/**
 * Fold what one row says about its turn into the message it belongs to: the
 * reply a `stored` transition carries (`completedTurnReply`, the one decoding
 * rule; the later row wins), the attachment refs and tool calls it records, and
 * the persistence status (a transition's when the row names one, else the
 * turn's own) and failure reason. A column a reader's query does not select
 * reads as absent and changes nothing: `getSession` selects every column read
 * here, the session list only `transitionState` and `transitionAssistantReply`,
 * which is all its output needs.
 */
function mergeTransitionRow(message: ChatHistoryMessage, row: HistoryRow): void {
  const candidateStatus = normalizePersistenceStatus(row.transitionState ?? row.persistenceState ?? '');
  const completedReply = completedTurnReply(row);
  if (message.author === 'agent' && completedReply !== undefined) {
    message.text = completedReply;
  }
  const transitionAttachmentRefs = parseAttachmentRefsLiteral(String(row.transitionAttachmentRefs ?? ''));
  if (message.author === 'user' && candidateStatus === 'stored' && transitionAttachmentRefs?.length) {
    message.attachmentRefs = transitionAttachmentRefs;
  }
  const transitionToolCalls = parseToolCallsLiteral(String(row.transitionToolCalls ?? ''));
  if (message.author === 'agent' && candidateStatus === 'stored' && transitionToolCalls?.length) {
    message.toolCalls = transitionToolCalls;
  }
  message.persistStatus = choosePersistenceStatus(message.persistStatus, candidateStatus);
  const candidateReason = stripRdfLiteral(row.transitionFailureReason ?? row.failureReason ?? '').trim();
  if (candidateStatus === 'failed' && candidateReason) {
    message.failureReason = candidateReason;
  }
  if (message.persistStatus && message.persistStatus !== 'failed') {
    message.failureReason = undefined;
  }
}

/**
 * The messages of ONE session from its rows, in the order each message first
 * appears. A row that names no message URI is keyed by its author, timestamp and
 * text, so identical anonymous rows collapse into one message.
 */
export function foldSessionRows(rows: readonly HistoryRow[]): ChatHistoryMessage[] {
  const messagesByUri = new Map<string, ChatHistoryMessage>();
  for (const row of rows) {
    const uri = historyRowUri(row);
    const key = uri || `${String(row.author ?? '')}:${String(row.ts ?? '')}:${String(row.text ?? '')}`;
    let message = messagesByUri.get(key);
    if (!message) {
      message = historyMessageFromRow(row, uri);
      messagesByUri.set(key, message);
    }
    mergeTransitionRow(message, row);
  }
  return [...messagesByUri.values()];
}

/**
 * The listed messages of MANY sessions from one batched query's rows, by session
 * URI, at most `SESSION_LIST_MESSAGE_LIMIT` per session. A message with several
 * transitions comes back once per transition, in transition order within the rows
 * of its message, so the latest completion wins.
 *
 * `null` marks a message that is not listed (its session is already at the cap,
 * or its first row names no session): it is never built, and its later rows are
 * skipped, so the cap counts messages, not rows. A row that names no message URI
 * cannot be tied to a turn (the query joins a turn's transitions through the
 * message), so each such row is its own message and never completes anything.
 */
export function foldListedRows(rows: readonly HistoryRow[]): Map<string, ChatHistoryMessage[]> {
  const messagesByUri = new Map<string, ChatHistoryMessage | null>();
  const bySession = new Map<string, ChatHistoryMessage[]>();
  for (const row of rows) {
    const uri = historyRowUri(row);
    let message = uri ? messagesByUri.get(uri) : undefined;
    if (message === undefined) {
      const sessionUri = String(row.session ?? '').replace(/[<>]/g, '');
      let listed = sessionUri ? bySession.get(sessionUri) : undefined;
      if (sessionUri && !listed) bySession.set(sessionUri, (listed = []));
      message = null;
      if (listed && listed.length < SESSION_LIST_MESSAGE_LIMIT) {
        message = historyMessageFromRow(row, uri);
        listed.push(message);
      }
      if (uri) messagesByUri.set(uri, message);
    }
    if (message && uri) mergeTransitionRow(message, row);
  }
  return bySession;
}
