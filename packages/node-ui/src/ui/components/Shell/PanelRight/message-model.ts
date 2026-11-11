import type { LocalAgentHistoryMessage } from '../../../api.js';
import { buildAttachmentSummary } from './attachments.js';
import { formatLocalTimestamp, toIsoTimestamp } from './format.js';
import type { LocalAgentMessage } from './types.js';

// Pure message transformations, shared by the conversation store and the
// panel. Rendering lives in messages.tsx.

let localMessageId = 0;

/**
 * NOTE: a UI-side helper used to live here that tried to un-escape
 * literal backslash-n in history-loaded text so markdown would render
 * after a refresh. Codex (CLWmd → CNGB8 → CSI-f → CSqGa) caught
 * progressively narrower false-positives across four rounds — the
 * UI simply cannot reliably distinguish "agent intended a literal
 * `\\n`" from "persistence encoded a newline as `\\n`" without a
 * richer signal. Removed; see the comment block in
 * `mapHistoryMessage` below for the known issue + proper fix path.
 *
 */

function isPersistedFailureNotice(text: string, failureContent: string, failureReason?: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed === failureContent) return true;
  return failureReason === 'Request cancelled.' && trimmed === failureReason;
}

function buildFailedTurnDisplay(
  text: string,
  failureContent: string,
  failureReason: string | undefined,
  integrationId: string,
): Pick<LocalAgentMessage, 'content' | 'failureNotice' | 'synthesized'> {
  if (text && isPersistedFailureNotice(text, failureContent, failureReason)) {
    return { content: text, synthesized: true };
  }
  if (text) {
    return integrationId === 'hermes'
      ? { content: text, failureNotice: failureContent, synthesized: false }
      : { content: text, synthesized: false };
  }
  return { content: '', failureNotice: failureContent, synthesized: true };
}

/**
 * Build the terminal display for a failure observed by the live stream.
 *
 * A failure before the first token used to leave the assistant row dependent
 * on the optional `failureNotice` side channel. Keeping the actionable error
 * as the row's primary synthetic content makes the terminal state durable
 * across re-renders, integration refreshes, and renderers that only consume
 * `content`. Partial real output still keeps markdown and gets a separate
 * plaintext failure notice.
 */
export function buildLiveFailedTurnDisplay(
  partialText: string,
  failureContent: string,
): Pick<LocalAgentMessage, 'content' | 'failureNotice' | 'synthesized'> {
  return partialText
    ? { content: partialText, failureNotice: failureContent, synthesized: false }
    : { content: failureContent, synthesized: true };
}

export function mapHistoryMessage(message: LocalAgentHistoryMessage, integrationId = ''): LocalAgentMessage {
  const author = message.author.toLowerCase();
  const role: LocalAgentMessage['role'] = author.includes('assistant') || author.includes('agent') ? 'assistant' : 'user';
  const failedReason = typeof message.failureReason === 'string' && message.failureReason.trim()
    ? message.failureReason.trim()
    : undefined;
  const failed = role === 'assistant' && (message.persistStatus === 'failed' || Boolean(failedReason));
  const failureContent = `Error: ${failedReason ?? 'The local agent turn failed.'}`;
  const failedDisplay = failed
    ? buildFailedTurnDisplay(message.text, failureContent, failedReason, integrationId)
    : null;
  const content = failedDisplay?.content
    ?? (message.text || buildAttachmentSummary(message.attachmentRefs ?? []));
  // KNOWN ISSUE — persisted messages whose newlines were escape-
  // encoded by the DKG-memory persistence layer (stored as literal
  // backslash-n, two characters, not real newline characters)
  // display with their literal backslash-n visible on history-reload.
  // Markdown blocks like paragraphs, code fences, and tables won't
  // render structurally until the message is re-streamed live.
  //
  // History across PR4: rounds 2-5 of Codex review on PR #516 walked
  // a UI-side decode through four progressively narrower heuristics
  // (blanket → no-real-newlines gate → markdown-marker gate →
  // boundary-only decode). Codex CLWmd, CNGB8, CSI-f, and CSqGa each
  // caught a new false-positive corruption case — JSON samples,
  // prompts discussing escape sequences, code-inside-fence payloads,
  // short text containing markdown-looking patterns like
  // `{"pattern":"\\n- item"}`. The fundamental issue is that the UI
  // cannot reliably distinguish "agent intended a literal `\\n`"
  // from "persistence encoded a newline as `\\n`" without a richer
  // signal.
  //
  // Proper fix is daemon-side: the persistence path should round-
  // trip strings faithfully — emit raw UTF-8 with real newlines
  // instead of escape-encoding them, or carry an explicit "escaped"
  // marker on encoded payloads so the UI can decode only confirmed-
  // escaped content. Tracked as a follow-up.
  const hasAgentText = Boolean(message.text);
  return {
    id: message.uri || `local-history:${++localMessageId}`,
    uri: message.uri,
    turnId: message.turnId,
    role,
    content,
    ts: formatLocalTimestamp(message.ts),
    tsRaw: toIsoTimestamp(message.ts),
    attachments: message.attachmentRefs,
    failureNotice: failedDisplay?.failureNotice,
    // Attachment summaries and exact persisted failure notices are UI-generated
    // strings. Mark them synthesized so the renderer skips markdown; real agent
    // partial text keeps markdown enabled even when the turn failed.
    synthesized: failedDisplay?.synthesized ?? !hasAgentText,
  };
}

function localMessageKey(message: LocalAgentMessage): string {
  return message.turnId
    ? `turn:${message.turnId}:${message.role}`
    : message.uri
    ?? `${message.role}:${message.ts ?? ''}:${message.content}`;
}

export function mergeLocalAgentMessages(existing: LocalAgentMessage[], incoming: LocalAgentMessage[]): LocalAgentMessage[] {
  const seen = new Set<string>();
  const merged: LocalAgentMessage[] = [];
  for (const message of [...incoming, ...existing]) {
    const key = localMessageKey(message);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(message);
  }
  return merged;
}

export function adoptLocalAgentTurnId(
  messages: LocalAgentMessage[],
  correlationId: string,
  turnId?: string,
): LocalAgentMessage[] {
  const stableTurnId = typeof turnId === 'string' && turnId.trim() ? turnId.trim() : correlationId;
  if (!stableTurnId || stableTurnId === correlationId) return messages;
  return messages.map((message) =>
    message.turnId === correlationId ? { ...message, turnId: stableTurnId } : message);
}
