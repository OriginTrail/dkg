import { create } from 'zustand';
import { randomUUID } from '../lib/randomUUID.js';
import {
  fetchLocalAgentHistory,
  importFile,
  persistLocalAgentChatFailure,
  streamLocalAgentChat,
  type LocalAgentChatAttachmentRef,
  type LocalAgentChatContextEntry,
  type LocalAgentIntegration,
} from '../api.js';
import {
  buildAttachmentImportResultRefs,
  buildAttachmentImportSummary,
  buildAttachmentTurnSummary,
  draftToAttachmentRef,
  isSendableAttachmentDraft,
} from '../components/Shell/PanelRight/attachments.js';
import { formatLocalTimestamp, toIsoTimestamp } from '../components/Shell/PanelRight/format.js';
import { formatLocalAgentErrorMessage } from '../components/Shell/PanelRight/local-agent-errors.js';
import {
  adoptLocalAgentTurnId,
  buildLiveFailedTurnDisplay,
  mapHistoryMessage,
  mergeLocalAgentMessages,
} from '../components/Shell/PanelRight/message-model.js';
import { resolveLocalAgentConversation } from '../components/Shell/PanelRight/selection.js';
import type {
  LocalAgentAttachmentDraft,
  LocalAgentAttachmentStatus,
  LocalAgentMessage,
} from '../components/Shell/PanelRight/types.js';
import { useJourneyStore } from './journey.js';

/**
 * The agent panel's conversations, keyed by conversation. They live outside
 * the panel, and so do the requests that change them: the panel can unmount
 * when it's closed (stopping its polling and listeners) while drafts, queued
 * files and replies in flight carry on here, and are there when it opens.
 */
export interface Conversation {
  messages: LocalAgentMessage[];
  /** The composer's draft. */
  input: string;
  sending: boolean;
  historyLoaded: boolean;
  /** Files queued in the composer, and their upload state. */
  attachments: LocalAgentAttachmentDraft[];
}

interface AgentConversationsState {
  conversations: Record<string, Conversation>;
  /**
   * Goes up when the node may have a new or changed session (history loaded,
   * a turn sent or a failure saved), so a mounted panel reloads its list.
   */
  sessionsRevision: number;
}

const EMPTY_CONVERSATION: Conversation = {
  messages: [],
  input: '',
  sending: false,
  historyLoaded: false,
  attachments: [],
};

export const useAgentConversations = create<AgentConversationsState>(() => ({
  conversations: {},
  sessionsRevision: 0,
}));

/** One conversation, or an empty one while there's none. */
export function useConversation(conversationKey: string | null): Conversation {
  return useAgentConversations((s) =>
    (conversationKey ? s.conversations[conversationKey] : undefined) ?? EMPTY_CONVERSATION);
}

/** Each conversation's messages, the shape the panel's selection rules read. */
export function messagesByConversation(conversations: Record<string, Conversation>): Record<string, LocalAgentMessage[]> {
  const result: Record<string, LocalAgentMessage[]> = {};
  for (const [key, conversation] of Object.entries(conversations)) result[key] = conversation.messages;
  return result;
}

const read = (conversationKey: string): Conversation =>
  useAgentConversations.getState().conversations[conversationKey] ?? EMPTY_CONVERSATION;

function update(conversationKey: string, change: (conversation: Conversation) => Partial<Conversation>) {
  useAgentConversations.setState((s) => {
    const current = s.conversations[conversationKey] ?? EMPTY_CONVERSATION;
    return { conversations: { ...s.conversations, [conversationKey]: { ...current, ...change(current) } } };
  });
}

const updateMessages = (conversationKey: string, change: (messages: LocalAgentMessage[]) => LocalAgentMessage[]) =>
  update(conversationKey, (c) => ({ messages: change(c.messages) }));

const updateAttachments = (
  conversationKey: string,
  change: (drafts: LocalAgentAttachmentDraft[]) => LocalAgentAttachmentDraft[],
) => update(conversationKey, (c) => ({ attachments: change(c.attachments) }));

const replaceAttachment = (conversationKey: string, draft: LocalAgentAttachmentDraft) =>
  updateAttachments(conversationKey, (drafts) => drafts.map((item) => (item.id === draft.id ? draft : item)));

const sessionsChanged = () => useAgentConversations.setState((s) => ({ sessionsRevision: s.sessionsRevision + 1 }));

/**
 * The request controller of each conversation's reply in flight, so Stop
 * aborts that conversation's reply and no other, even from a reopened panel.
 */
const activeRequests = new Map<string, AbortController>();

const draftKey = (contextGraphId: string, file: File) =>
  `${contextGraphId}:${file.name}:${file.size}:${file.lastModified}`;

/** Upload each queued file, recording its state as it goes. */
async function uploadAttachments(
  conversationKey: string,
  drafts: LocalAgentAttachmentDraft[],
): Promise<LocalAgentAttachmentDraft[]> {
  const processed: LocalAgentAttachmentDraft[] = [];
  for (const draft of drafts) {
    if (draft.status === 'completed' || draft.status === 'skipped') {
      processed.push(draft);
      continue;
    }
    replaceAttachment(conversationKey, { ...draft, status: 'uploading', error: undefined });
    let next: LocalAgentAttachmentDraft;
    try {
      const result = await importFile(draft.assertionName, draft.contextGraphId, draft.file);
      const status: LocalAgentAttachmentStatus = result.extraction.status === 'completed'
        ? 'completed'
        : result.extraction.status === 'skipped' ? 'skipped' : 'error';
      next = { ...draft, status, result, error: result.extraction.error };
    } catch (err: any) {
      next = { ...draft, status: 'error', error: err?.message ?? 'Upload failed' };
    }
    processed.push(next);
    replaceAttachment(conversationKey, next);
  }
  return processed;
}

export interface ConversationTarget {
  integrationId: string;
  sessionId: string | null;
  defaultSessionId?: string | null;
}

export type HistoryResult = { ok: true } | { ok: false; error: unknown };

export interface SendRequest {
  conversationKey: string;
  integration: LocalAgentIntegration;
  sessionId: string | null;
  contextEntries: LocalAgentChatContextEntry[];
  contextGraphId: string | null;
}

export type SendOutcome =
  | { status: 'skipped' }
  /** `sessionId` is set when Prime answered from a different live session. */
  | { status: 'sent'; sessionId?: string }
  /** `inConversation` is false when it failed before the turn was shown. */
  | { status: 'failed'; reason: string; aborted: boolean; inConversation: boolean };

async function runSend(request: SendRequest, text: string, drafts: LocalAgentAttachmentDraft[]): Promise<SendOutcome> {
  const { conversationKey, integration, sessionId, contextGraphId } = request;
  const integrationId = integration.id;
  let controller: AbortController | null = null;
  let assistantId = '';
  let correlationId = '';
  let messageText = '';
  let assistantPartialText = '';
  let attachments: LocalAgentChatAttachmentRef[] = [];
  let processedDrafts: LocalAgentAttachmentDraft[] = [];
  let deliveredAttachmentIds: string[] = [];

  try {
    processedDrafts = await uploadAttachments(conversationKey, drafts);
    attachments = processedDrafts
      .map((draft) => draftToAttachmentRef(draft))
      .filter((item): item is LocalAgentChatAttachmentRef => item != null);
    const importContext = buildAttachmentImportResultRefs(processedDrafts);
    if (!text && attachments.length === 0 && importContext.results.length === 0) {
      return { status: 'skipped' };
    }

    correlationId = randomUUID();
    const importSummary = buildAttachmentImportSummary(importContext.results);
    const textWithImportSummary = [text, importSummary].filter((part) => part.length > 0).join('\n\n');
    messageText = text ? textWithImportSummary : buildAttachmentTurnSummary(attachments, importContext.results);
    const outboundText = text ? textWithImportSummary : '';
    const attachmentIds = attachments
      .map((attachment) => attachment.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    deliveredAttachmentIds = [...attachmentIds, ...importContext.deliveredDraftIds];
    const userId = `local:${conversationKey}:${correlationId}:user`;
    assistantId = `local:${conversationKey}:${correlationId}:assistant`;
    // One instant for the display time and the ISO time, formatted like history.
    const sentAt = new Date();
    const ts = formatLocalTimestamp(sentAt);
    const tsRaw = toIsoTimestamp(sentAt);

    // The turn owns its files from here, so they leave the composer now
    // instead of looking stuck in the queue. A failure puts them back.
    const delivered = new Set(deliveredAttachmentIds);
    update(conversationKey, (c) => ({
      messages: [
        ...c.messages,
        { id: userId, turnId: correlationId, role: 'user', content: messageText, ts, tsRaw, attachments },
        { id: assistantId, turnId: correlationId, role: 'assistant', content: '', ts, tsRaw, streaming: true },
      ],
      input: '',
      attachments: c.attachments.filter((draft) => !delivered.has(draft.id)),
    }));

    controller = new AbortController();
    activeRequests.set(conversationKey, controller);
    const liveSession = integrationId === 'prime-agent'
      ? integration.liveSessions?.find((session) => session.sessionId === sessionId)
      : undefined;

    const result = await streamLocalAgentChat(integrationId, outboundText, {
      correlationId,
      signal: controller.signal,
      sessionId: sessionId ?? undefined,
      liveSession,
      profile: integration.profile,
      persistUserMessage: outboundText ? undefined : messageText,
      attachments,
      attachmentImportResults: importContext.results,
      contextEntries: request.contextEntries,
      contextGraphId: contextGraphId ?? undefined,
      onEvent: (event) => {
        if (event.type !== 'text_delta') return;
        assistantPartialText += event.delta;
        updateMessages(conversationKey, (messages) => messages.map((message) =>
          message.id === assistantId ? { ...message, content: message.content + event.delta } : message));
      },
    });

    const completedAt = new Date();
    updateMessages(conversationKey, (messages) =>
      adoptLocalAgentTurnId(messages, correlationId, result.turnId).map((message) =>
        message.id === assistantId
          ? {
              ...message,
              content: result.text || message.content,
              turnId: result.turnId?.trim() || message.turnId,
              streaming: false,
              // Synthesized only when the agent wrote nothing, streamed or final.
              synthesized: !result.text && !message.content ? true : message.synthesized,
              ts: formatLocalTimestamp(completedAt),
              tsRaw: toIsoTimestamp(completedAt),
              toolCalls: result.toolCalls,
              traceFile: result.traceFile,
              profile: result.profile,
              contextGraphId: result.contextGraphId,
              readOnly: result.readOnly,
            }
          : message));
    sessionsChanged();
    const journey = useJourneyStore.getState();
    if (journey.stage === 0) journey.advance();

    const resolvedPrimeSessionId = integrationId === 'prime-agent' ? result.sessionId?.trim() : undefined;
    return resolvedPrimeSessionId && resolvedPrimeSessionId !== sessionId
      ? { status: 'sent', sessionId: resolvedPrimeSessionId }
      : { status: 'sent' };
  } catch (err: any) {
    const aborted = err?.name === 'AbortError';
    const reason = aborted ? 'Request cancelled.' : formatLocalAgentErrorMessage(integration, err);
    if (assistantId) {
      const failedDisplay = buildLiveFailedTurnDisplay(assistantPartialText, aborted ? reason : `Error: ${reason}`);
      updateMessages(conversationKey, (messages) => messages.map((message) =>
        message.id === assistantId ? { ...message, ...failedDisplay, streaming: false } : message));
    }
    if (!aborted && integrationId === 'hermes' && assistantId && messageText) {
      void persistHermesFailure(request, {
        correlationId,
        userMessage: messageText,
        assistantReply: assistantPartialText,
        failureReason: reason,
        attachments,
      });
    }
    // Put back the files that left the composer, ahead of any queued since.
    if (deliveredAttachmentIds.length > 0 && processedDrafts.length > 0) {
      updateAttachments(conversationKey, (current) => {
        const existingIds = new Set(current.map((draft) => draft.id));
        const restored = processedDrafts.filter((draft) => !existingIds.has(draft.id));
        return restored.length === 0 ? current : [...restored, ...current];
      });
    }
    return { status: 'failed', reason, aborted, inConversation: Boolean(assistantId) };
  } finally {
    update(conversationKey, () => ({ sending: false }));
    // Only forget this request, not a newer one sent under the same key.
    if (controller && activeRequests.get(conversationKey) === controller) activeRequests.delete(conversationKey);
  }
}

/** Hermes keeps failed turns, so a timed-out session survives a refresh. */
async function persistHermesFailure(
  request: SendRequest,
  turn: {
    correlationId: string;
    userMessage: string;
    assistantReply: string;
    failureReason: string;
    attachments: LocalAgentChatAttachmentRef[];
  },
) {
  try {
    const persisted = await persistLocalAgentChatFailure(request.integration.id, {
      sessionId: request.sessionId ?? undefined,
      correlationId: turn.correlationId || undefined,
      userMessage: turn.userMessage,
      assistantReply: turn.assistantReply,
      failureReason: turn.failureReason,
      profile: request.integration.profile,
      attachments: turn.attachments,
      contextGraphId: request.contextGraphId ?? undefined,
    });
    if (persisted.turnId) {
      updateMessages(request.conversationKey, (messages) =>
        adoptLocalAgentTurnId(messages, turn.correlationId, persisted.turnId));
    }
    sessionsChanged();
  } catch {
    // The error bubble is still useful when the failure can't be saved.
  }
}

export const conversationActions = {
  /**
   * Fetch a conversation's history and merge it into what's here. A refresh
   * keeps the current messages showing while it loads, and leaves the loaded
   * state alone when it fails so the caller can say why.
   */
  async loadHistory(target: ConversationTarget, options: { refresh?: boolean } = {}): Promise<HistoryResult> {
    const { integrationId } = target;
    const conversation = resolveLocalAgentConversation(target);
    const key = conversation.stateKey;
    if (!options.refresh) update(key, () => ({ historyLoaded: false }));
    try {
      const history = await fetchLocalAgentHistory(integrationId, 100, { sessionId: conversation.sessionId ?? undefined });
      const loaded = history.map((message) => mapHistoryMessage(message, integrationId));
      update(key, (c) => ({ messages: mergeLocalAgentMessages(c.messages, loaded), historyLoaded: true }));
      return { ok: true };
    } catch (error) {
      if (!options.refresh) update(key, () => ({ historyLoaded: true }));
      return { ok: false, error };
    } finally {
      if (!options.refresh) sessionsChanged();
    }
  },

  /** The panel can't load this conversation (its agent can't chat). */
  markHistoryUnloaded(conversationKey: string) {
    update(conversationKey, () => ({ historyLoaded: false }));
  },

  setInput(conversationKey: string, input: string) {
    update(conversationKey, () => ({ input }));
  },

  /** Queue files for the next turn, skipping ones already queued. */
  addAttachments(conversationKey: string, files: FileList | File[], contextGraphId: string) {
    const existing = new Set(read(conversationKey).attachments.map((draft) => draftKey(draft.contextGraphId, draft.file)));
    const drafts: LocalAgentAttachmentDraft[] = [];
    for (const file of Array.from(files)) {
      const key = draftKey(contextGraphId, file);
      if (existing.has(key)) continue;
      existing.add(key);
      drafts.push({
        id: `${conversationKey}:${file.name}:${file.size}:${file.lastModified}:${randomUUID()}`,
        file,
        contextGraphId,
        assertionName: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
        status: 'queued',
      });
    }
    if (drafts.length > 0) updateAttachments(conversationKey, (current) => [...current, ...drafts]);
  },

  removeAttachment(conversationKey: string, attachmentId: string) {
    updateAttachments(conversationKey, (current) => current.filter((draft) => draft.id !== attachmentId));
  },

  /**
   * Send the composer's text and queued files, streaming the reply into the
   * conversation. Returns null, synchronously, when there's nothing to send
   * or the agent can't take it; otherwise how the turn ended.
   */
  send(request: SendRequest): Promise<SendOutcome> | null {
    const { conversationKey, integration } = request;
    const conversation = read(conversationKey);
    const text = conversation.input.trim();
    const drafts = conversation.attachments;
    const hasSendableDrafts = drafts.some(isSendableAttachmentDraft);
    if (!integration.chatSupported || !integration.chatReady || conversation.sending) return null;
    if (!text && !hasSendableDrafts) return null;
    update(conversationKey, () => ({ sending: true }));
    return runSend(request, text, drafts);
  },

  /** Abort this conversation's reply in flight; the turn then shows as cancelled. */
  stop(conversationKey: string) {
    activeRequests.get(conversationKey)?.abort();
  },

  /** Empty a conversation after its agent's session was cleared. */
  clear(conversationKey: string) {
    update(conversationKey, () => ({ messages: [], input: '', attachments: [], historyLoaded: true }));
  },

  /**
   * Carry a conversation over to the session that answered it (Prime after a
   * restart). Only an explicit no-session miss is retried, and that runs
   * nothing, so the merged transcript can't hold a turn twice.
   */
  migrateSession(fromKey: string, toKey: string) {
    const from = read(fromKey);
    update(toKey, (c) => ({
      messages: mergeLocalAgentMessages(c.messages, from.messages),
      historyLoaded: from.historyLoaded,
    }));
  },
};

/** For tests: start with no conversations. */
export const resetAgentConversations = () => {
  activeRequests.clear();
  useAgentConversations.setState({ conversations: {}, sessionsRevision: 0 });
};
