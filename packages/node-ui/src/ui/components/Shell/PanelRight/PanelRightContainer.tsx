import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useJourneyStore } from '../../../stores/journey.js';
import { useProjectsStore } from '../../../stores/projects.js';
import {
  importFile,
  type AgentIdentity,
  type LocalAgentChatAttachmentRef,
  type LocalAgentIntegration,
  type LocalAgentStreamEvent,
  type MemorySession,
  connectLocalAgentIntegration,
  disconnectLocalAgentIntegration,
  fetchAgents,
  fetchConnections,
  getDefaultLocalAgentSessionId,
  fetchLocalAgentHistory,
  fetchLocalAgentIntegrations,
  persistLocalAgentChatFailure,
  refreshLocalAgentIntegration,
  streamLocalAgentChat,
} from '../../../api.js';
import { api } from '../../../api-wrapper.js';
import { computeSelectableProjects, toSidebarIdentity } from '../../../lib/contextGraphSidebar.js';
import { useCurrentAgent as useSharedCurrentAgentRaw } from '../../../hooks/useCurrentAgent.js';
import { useVisibilityPolling } from '../../../hooks/useVisibilityPolling.js';
import { buildAttachmentImportResultRefs, buildAttachmentImportSummary, buildAttachmentTurnSummary, draftToAttachmentRef, isSendableAttachmentDraft } from './attachments.js';
import { buildChatContextEntries } from './chat-context.js';
import { ADD_AGENT_TAB_ID, STATIC_DEFAULT_LOCAL_AGENT_HISTORY_INTEGRATIONS } from './constants.js';
import { formatLocalTimestamp, toIsoTimestamp } from './format.js';
import { formatLocalAgentErrorMessage } from './local-agent-errors.js';
import {
  adoptLocalAgentTurnId,
  buildLiveFailedTurnDisplay,
  mapHistoryMessage,
  mergeLocalAgentMessages,
} from './messages.js';
import { ConnectedAgentsTab } from './ConnectedAgentsTab.js';
import { NetworkTab } from './NetworkTab.js';
import { SessionsTab } from './SessionsTab.js';
import {
  compareLocalAgentIntegrations,
  getLocalAgentConversationStateKey,
  markLocalAgentIntegrationDisconnected,
  resolveLocalAgentConversation,
  resolveLocalAgentSelectionState,
  shouldPreserveSelectedLocalAgentTab,
  shouldPreserveSessionOnReconnect,
  summarizeLocalAgentSessions,
  upsertLocalAgentIntegrationState,
} from './selection.js';
import type { AgentInfo, ConnectionRow, LocalAgentAttachmentDraft, LocalAgentAttachmentStatus, LocalAgentMessage, LocalAgentSessionSummary } from './types.js';

function useSharedCurrentAgent(): AgentIdentity | null {
  return useSharedCurrentAgentRaw().data;
}

export function PanelRight() {
  const { stage, advance } = useJourneyStore();
  const [mode, setMode] = useState<'agents' | 'network' | 'sessions'>('agents');

  const [memorySessions, setMemorySessions] = useState<MemorySession[]>([]);
  const [peerAgents, setPeerAgents] = useState<AgentInfo[]>([]);
  const [connections, setConnections] = useState<{ total: number; direct: number; relayed: number; rows: ConnectionRow[] }>({ total: 0, direct: 0, relayed: 0, rows: [] });
  const [peerLoading, setPeerLoading] = useState(true);
  // Mirror Header — use the dedup'd shared hook so the panel doesn't
  // race-fetch its own copy of the current agent on every mount
  // (BUG-007). The boolean `loading` flag is intentionally ignored;
  // callers below already null-check `currentAgent`.
  const currentAgent = useSharedCurrentAgent();

  const [integrations, setIntegrations] = useState<LocalAgentIntegration[]>([]);
  const [selectedIntegrationId, setSelectedIntegrationId] = useState('openclaw');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    () => getDefaultLocalAgentSessionId('openclaw'),
  );
  const [connectBusyId, setConnectBusyId] = useState<string | null>(null);
  const [connectNotice, setConnectNotice] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [refreshBusyId, setRefreshBusyId] = useState<string | null>(null);

  const [localMessagesByConversation, setLocalMessagesByConversation] = useState<Record<string, LocalAgentMessage[]>>({});
  const [localInputByConversation, setLocalInputByConversation] = useState<Record<string, string>>({});
  const [localSendingByConversation, setLocalSendingByConversation] = useState<Record<string, boolean>>({});
  const [localHistoryLoadedByConversation, setLocalHistoryLoadedByConversation] = useState<Record<string, boolean>>({});
  const [attachmentDraftsByConversation, setAttachmentDraftsByConversation] = useState<Record<string, LocalAgentAttachmentDraft[]>>({});

  // AbortControllers keyed by `conversationKey` so the stop-button on
  // conversation A always aborts A's in-flight request and never B's.
  // Earlier code used a single shared ref, which was overwritten when a
  // user switched conversations mid-stream and started a send in the
  // new one — clicking Stop in the original conversation would then
  // abort the wrong request. Codex CIV4a / CIcaM / CIlg0.
  const localAbortRef = useRef<Map<string, AbortController>>(new Map());
  const autoFocusedLocalAgentRef = useRef(false);
  const localChatEndRef = useRef<HTMLDivElement>(null);
  const memorySessionsRef = useRef<MemorySession[]>([]);
  const localMessagesByConversationRef = useRef<Record<string, LocalAgentMessage[]>>({});
  const selectedIntegrationIdRef = useRef('openclaw');
  const selectedSessionIdRef = useRef<string | null>(getDefaultLocalAgentSessionId('openclaw'));
  const availableProjects = useProjectsStore((state) => state.contextGraphs);
  const projectsLoading = useProjectsStore((state) => state.loading);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const setActiveProject = useProjectsStore((state) => state.setActiveProject);

  // The project picker must mirror the left sidebar's "My projects"
  // *membership* (created/joined), not the full context-graph list —
  // same `belongsInMyProjectsSidebar` predicate PanelLeft uses. The
  // local "hidden from sidebar" dismissal is intentionally NOT applied
  // here: hiding a project from the sidebar must not stop you posting
  // chat to it. Other `availableProjects` consumers
  // (getProjectDisplayName, buildChatContextEntries) deliberately keep
  // the full list — only the picker is membership-scoped.
  const selectableProjects = useMemo(
    () => computeSelectableProjects(
      availableProjects,
      currentAgent ? toSidebarIdentity(currentAgent) : null,
      activeProjectId,
    ),
    [availableProjects, currentAgent, activeProjectId],
  );

  const localSessions = summarizeLocalAgentSessions(memorySessions, integrations);
  const {
    sortedIntegrations,
    connectedIntegrations,
    selectedIntegration,
    selectedConversation,
    selectedHasConversation,
    selectedIntegrationHasAnyConversation,
  } = resolveLocalAgentSelectionState({
    integrations,
    selectedIntegrationId,
    selectedSessionId,
    localMessagesByConversation,
    sessions: localSessions,
  });
  const selectedConversationKey = selectedConversation?.stateKey ?? null;
  const selectedLocalMessages = selectedConversationKey
    ? (localMessagesByConversation[selectedConversationKey] ?? [])
    : [];
  const selectedLocalHistoryLoaded = selectedConversationKey
    ? (localHistoryLoadedByConversation[selectedConversationKey] ?? false)
    : false;
  const localInput = selectedConversationKey
    ? (localInputByConversation[selectedConversationKey] ?? '')
    : '';
  const localSending = selectedConversationKey
    ? (localSendingByConversation[selectedConversationKey] ?? false)
    : false;
  const selectedAttachmentDrafts = selectedConversationKey
    ? (attachmentDraftsByConversation[selectedConversationKey] ?? [])
    : [];
  const scrollLocalChatToBottom = useCallback(() => {
    localChatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(scrollLocalChatToBottom, [selectedConversationKey, selectedLocalMessages, scrollLocalChatToBottom]);

  useEffect(() => {
    memorySessionsRef.current = memorySessions;
  }, [memorySessions]);

  useEffect(() => {
    localMessagesByConversationRef.current = localMessagesByConversation;
  }, [localMessagesByConversation]);

  useEffect(() => {
    selectedIntegrationIdRef.current = selectedIntegrationId;
  }, [selectedIntegrationId]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  const updateLocalMessages = useCallback((
    conversationKey: string,
    updater: (messages: LocalAgentMessage[]) => LocalAgentMessage[],
  ) => {
    setLocalMessagesByConversation((prev) => ({
      ...prev,
      [conversationKey]: updater(prev[conversationKey] ?? []),
    }));
  }, []);

  const setLocalInputForConversation = useCallback((conversationKey: string | null, value: string) => {
    if (!conversationKey) return;
    setLocalInputByConversation((prev) => ({
      ...prev,
      [conversationKey]: value,
    }));
  }, []);

  const setLocalSendingForConversation = useCallback((conversationKey: string, value: boolean) => {
    setLocalSendingByConversation((prev) => ({
      ...prev,
      [conversationKey]: value,
    }));
  }, []);

  const updateAttachmentDrafts = useCallback((
    conversationKey: string,
    updater: (drafts: LocalAgentAttachmentDraft[]) => LocalAgentAttachmentDraft[],
  ) => {
    setAttachmentDraftsByConversation((prev) => ({
      ...prev,
      [conversationKey]: updater(prev[conversationKey] ?? []),
    }));
  }, []);

  const addAttachmentsForConversation = useCallback((
    conversationKey: string,
    files: FileList | File[],
    contextGraphId: string,
  ) => {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;

    const existingKeys = new Set(
      (attachmentDraftsByConversation[conversationKey] ?? []).map((draft) =>
        `${draft.contextGraphId}:${draft.file.name}:${draft.file.size}:${draft.file.lastModified}`),
    );
    const uniqueFiles = incoming.filter((file) => {
      const key = `${contextGraphId}:${file.name}:${file.size}:${file.lastModified}`;
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });

    if (uniqueFiles.length === 0) return;

    const drafts = uniqueFiles.map((file) => ({
      id: `${conversationKey}:${file.name}:${file.size}:${file.lastModified}:${crypto.randomUUID()}`,
      file,
      contextGraphId,
      assertionName: `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
      status: 'queued' as const,
    }));

    updateAttachmentDrafts(conversationKey, (prev) => [...prev, ...drafts]);
  }, [attachmentDraftsByConversation, updateAttachmentDrafts]);

  const prepareAttachmentDraftsForSend = useCallback(async (
    conversationKey: string,
    drafts: LocalAgentAttachmentDraft[],
  ): Promise<LocalAgentAttachmentDraft[]> => {
    const processed: LocalAgentAttachmentDraft[] = [];

    for (const draft of drafts) {
      if (draft.status === 'completed' || draft.status === 'skipped') {
        processed.push(draft);
        continue;
      }

      updateAttachmentDrafts(conversationKey, (prev) =>
        prev.map((item) => (item.id === draft.id
          ? { ...item, status: 'uploading', error: undefined }
          : item)),
      );

      try {
        const result = await importFile(draft.assertionName, draft.contextGraphId, draft.file);
        const nextStatus: LocalAgentAttachmentStatus = result.extraction.status === 'completed'
          ? 'completed'
          : result.extraction.status === 'skipped'
            ? 'skipped'
            : 'error';
        const nextDraft: LocalAgentAttachmentDraft = {
          ...draft,
          status: nextStatus,
          result,
          error: result.extraction.error,
        };
        processed.push(nextDraft);
        updateAttachmentDrafts(conversationKey, (prev) =>
          prev.map((item) => (item.id === draft.id ? nextDraft : item)),
        );
      } catch (err: any) {
        const nextDraft: LocalAgentAttachmentDraft = {
          ...draft,
          status: 'error',
          error: err?.message ?? 'Upload failed',
        };
        processed.push(nextDraft);
        updateAttachmentDrafts(conversationKey, (prev) =>
          prev.map((item) => (item.id === draft.id ? nextDraft : item)),
        );
      }
    }

    return processed;
  }, [updateAttachmentDrafts]);

  const removeAttachmentForConversation = useCallback((conversationKey: string, attachmentId: string) => {
    updateAttachmentDrafts(conversationKey, (prev) => prev.filter((draft) => draft.id !== attachmentId));
  }, [updateAttachmentDrafts]);

  const clearCompletedAttachmentsForConversation = useCallback((conversationKey: string, sentAttachmentIds: string[]) => {
    const sent = new Set(sentAttachmentIds);
    updateAttachmentDrafts(conversationKey, (prev) => prev.filter((draft) => !sent.has(draft.id)));
  }, [updateAttachmentDrafts]);

  const setSelectedIntegration = useCallback((
    integrationId: string,
    opts: { preserveSession?: boolean; sessionId?: string | null } = {},
  ) => {
    setSelectedIntegrationId(integrationId);
    if (integrationId === ADD_AGENT_TAB_ID) {
      return;
    }
    if (opts.preserveSession) {
      return;
    }
    setSelectedSessionId(opts.sessionId ?? getDefaultLocalAgentSessionId(integrationId));
  }, []);

  const loadSessions = useCallback(() => {
    api.fetchMemorySessions(50)
      .then(({ sessions: items }: any) => setMemorySessions(items ?? []))
      .catch(() => {});
  }, []);

  const refreshPeers = useCallback(async () => {
    try {
      const [agentData, connData] = await Promise.all([
        fetchAgents().catch(() => ({ agents: [] })),
        fetchConnections().catch(() => ({ total: 0, direct: 0, relayed: 0, connections: [] })),
      ]);
      const agents = (agentData.agents ?? []).filter((agent: AgentInfo) => agent.connectionStatus !== 'self');
      setPeerAgents(agents);
      setConnections({
        total: connData.total ?? 0,
        direct: connData.direct ?? 0,
        relayed: connData.relayed ?? 0,
        // Per-connection rows are the source of truth for the peer
        // axis — grouped by peerId inside NetworkTab's `buildPeers`.
        rows: Array.isArray(connData.connections) ? connData.connections : [],
      });
    } catch {
      // ignore
    }
    setPeerLoading(false);
  }, []);

  const refreshLocalIntegrations = useCallback(async () => {
    try {
      const { integrations: items } = await fetchLocalAgentIntegrations();
      setIntegrations(items);
      const sessionSummaries = summarizeLocalAgentSessions(memorySessionsRef.current, items);
      const connected = [...items].sort(compareLocalAgentIntegrations).filter((item) => item.persistentChat);
      const selectedIntegrationId = selectedIntegrationIdRef.current;
      const selectedSessionId = selectedSessionIdRef.current;
      const selectedItem = items.find((item) => item.id === selectedIntegrationId) ?? null;
      const preserveSelected = shouldPreserveSelectedLocalAgentTab({
        selectedIntegrationId,
        selectedItem,
        selectedSessionId,
        localMessagesByConversation: localMessagesByConversationRef.current,
        sessionSummaries,
      });
      if (!preserveSelected) {
        const next = connected[0];
        setSelectedIntegration(next?.id ?? ADD_AGENT_TAB_ID, { sessionId: next?.defaultSessionId ?? null });
      }
      const preferred = connected[0];
      if (preferred && !autoFocusedLocalAgentRef.current && selectedIntegrationId !== ADD_AGENT_TAB_ID) {
        autoFocusedLocalAgentRef.current = true;
        setSelectedIntegration(preferred.id, { sessionId: preferred.defaultSessionId });
        setMode('agents');
      } else if (!preferred && !preserveSelected) {
        autoFocusedLocalAgentRef.current = false;
        setSelectedIntegration(ADD_AGENT_TAB_ID);
      }
    } catch {
      // Keep the last known integrations in place so transient refresh failures
      // do not collapse an attached agent chat surface back into the add-agent UI.
    }
  }, [setSelectedIntegration]);

  const loadLocalHistory = useCallback(async (
    integrationId: string,
    sessionId: string | null = null,
    defaultSessionId: string | null = null,
  ) => {
    const conversation = resolveLocalAgentConversation({ integrationId, sessionId, defaultSessionId });
    setLocalHistoryLoadedByConversation((prev) => ({
      ...prev,
      [conversation.stateKey]: false,
    }));
    try {
      const history = await fetchLocalAgentHistory(integrationId, 100, {
        sessionId: conversation.sessionId ?? undefined,
      });
      const loaded = history.map((message) => mapHistoryMessage(message, integrationId));
      updateLocalMessages(conversation.stateKey, (prev) => mergeLocalAgentMessages(prev, loaded));
    } catch {
      updateLocalMessages(conversation.stateKey, (prev) => prev);
    } finally {
      setLocalHistoryLoadedByConversation((prev) => ({
        ...prev,
        [conversation.stateKey]: true,
      }));
      loadSessions();
    }
  }, [loadSessions, updateLocalMessages]);

  useEffect(() => {
    loadSessions();
    refreshPeers();
    refreshLocalIntegrations();
  }, [loadSessions, refreshPeers, refreshLocalIntegrations]);

  // Mount-time hydrate stable local-agent sessions so chat history paints
  // before bridge probes complete (issue #255).
  useEffect(() => {
    for (const integrationId of STATIC_DEFAULT_LOCAL_AGENT_HISTORY_INTEGRATIONS) {
      void loadLocalHistory(integrationId, getDefaultLocalAgentSessionId(integrationId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // BUG-007: sessions + peers refresh now goes through the shared
  // visibility-aware poller (was a hand-rolled visibilitychange loop
  // with the same intent). Skip the immediate fire-on-mount because
  // both loadSessions and refreshPeers already ran in the mount-time
  // effect above; otherwise we'd duplicate the network call.
  const refreshChatPanelLive = useCallback(() => {
    loadSessions();
    refreshPeers();
  }, [loadSessions, refreshPeers]);
  useVisibilityPolling(refreshChatPanelLive, 15_000, { runImmediately: false });

  const localIntegrationRefreshMs = integrations.some((integration) =>
    integration.persistentChat && (!integration.chatReady || integration.status === 'connecting'),
  )
    ? 3_000
    : 15_000;

  useEffect(() => {
    const intervalId = setInterval(() => {
      void refreshLocalIntegrations();
    }, localIntegrationRefreshMs);
    return () => clearInterval(intervalId);
  }, [localIntegrationRefreshMs, refreshLocalIntegrations]);

  useEffect(() => {
    if (!selectedIntegration?.chatSupported || (!selectedIntegration.persistentChat && !selectedHasConversation)) {
      if (selectedConversationKey) {
        setLocalHistoryLoadedByConversation((prev) => ({
          ...prev,
          [selectedConversationKey]: false,
        }));
      }
      return;
    }
    let cancelled = false;
    (async () => {
      await loadLocalHistory(
        selectedIntegration.id,
        selectedConversation?.sessionId ?? null,
        selectedIntegration.defaultSessionId ?? null,
      );
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [
    loadLocalHistory,
    selectedConversation?.sessionId,
    selectedConversationKey,
    selectedHasConversation,
    selectedIntegration?.defaultSessionId,
    selectedIntegration?.chatSupported,
    selectedIntegration?.id,
    selectedIntegration?.persistentChat,
  ]);

  const sendLocalMessage = useCallback(async () => {
    const integration = selectedIntegration;
    const conversation = selectedConversation;
    const text = localInput.trim();
    const drafts = selectedAttachmentDrafts;
    const hasSendableDrafts = drafts.some(isSendableAttachmentDraft);
    if (!integration?.chatSupported || !integration.chatReady || localSending || !conversation || (!text && !hasSendableDrafts)) return;
    const integrationId = integration.id;
    const conversationKey = conversation.stateKey;
    setLocalSendingForConversation(conversationKey, true);
    setConnectError(null);
    let controller: AbortController | null = null;
    let assistantId = '';
    let correlationId = '';
    let messageText = '';
    let assistantPartialText = '';
    let failureAttachmentRefs: LocalAgentChatAttachmentRef[] = [];
    // Hoisted so the `catch` path can restore the optimistically-cleared
    // drafts without a TypeScript scope error and without a runtime
    // ReferenceError when send fails before they're assigned.
    let processedDrafts: LocalAgentAttachmentDraft[] = [];
    let deliveredAttachmentIds: string[] = [];

    try {
      processedDrafts = await prepareAttachmentDraftsForSend(conversationKey, drafts);
      const attachments = processedDrafts
        .map((draft) => draftToAttachmentRef(draft))
        .filter((item): item is LocalAgentChatAttachmentRef => item != null);
      const importContext = buildAttachmentImportResultRefs(processedDrafts);
      if (!text && attachments.length === 0 && importContext.results.length === 0) {
        return;
      }

      correlationId = crypto.randomUUID();
      const importSummary = buildAttachmentImportSummary(importContext.results);
      const textWithImportSummary = [text, importSummary].filter((part) => part.length > 0).join('\n\n');
      messageText = text
        ? textWithImportSummary
        : buildAttachmentTurnSummary(attachments, importContext.results);
      const outboundText = text ? textWithImportSummary : '';
      failureAttachmentRefs = attachments;
      const attachmentIds = attachments
        .map((attachment) => attachment.id)
        .filter((attachmentId): attachmentId is string => typeof attachmentId === 'string' && attachmentId.length > 0);
      deliveredAttachmentIds = [...attachmentIds, ...importContext.deliveredDraftIds];
      const userId = `local:${conversationKey}:${correlationId}:user`;
      assistantId = `local:${conversationKey}:${correlationId}:assistant`;
      // Route through `formatLocalTimestamp` so user-send timestamps
      // stay in lockstep with history-loaded ones (date + time format).
      // `nowDate` is captured once and passed to both formatters so the
      // display value and the ISO `tsRaw` reflect the same instant.
      const nowDate = new Date();
      const now = formatLocalTimestamp(nowDate);
      const nowIso = toIsoTimestamp(nowDate);

      updateLocalMessages(conversationKey, (prev) => [
        ...prev,
        { id: userId, turnId: correlationId, role: 'user', content: messageText, ts: now, tsRaw: nowIso, attachments },
        { id: assistantId, turnId: correlationId, role: 'assistant', content: '', ts: now, tsRaw: nowIso, streaming: true },
      ]);
      setLocalInputForConversation(conversationKey, '');
      // Clear composer chips OPTIMISTICALLY as soon as the user-message
      // bubble owns the attachments — keeping them visible until the agent
      // reply makes the attachment look "stuck in queue". If the send fails
      // or is aborted, the `catch` below restores these drafts so the user
      // can retry without re-uploading.
      if (deliveredAttachmentIds.length > 0) {
        clearCompletedAttachmentsForConversation(conversationKey, deliveredAttachmentIds);
      }

      controller = new AbortController();
      // Bind this controller to `conversationKey` rather than a global
      // ref. Multiple conversations can stream concurrently, and the
      // user can switch tabs mid-stream — each Stop button must abort
      // its own request.
      localAbortRef.current.set(conversationKey, controller);
      const contextEntries = [
        ...buildChatContextEntries(availableProjects, activeProjectId, currentAgent),
      ];

      const result = await streamLocalAgentChat(integrationId, outboundText, {
        correlationId,
        signal: controller?.signal,
        sessionId: conversation.sessionId ?? undefined,
        profile: integration.profile,
        persistUserMessage: outboundText ? undefined : messageText,
        attachments,
        attachmentImportResults: importContext.results,
        contextEntries,
        contextGraphId: activeProjectId ?? undefined,
        onEvent: (event: LocalAgentStreamEvent) => {
          if (event.type === 'text_delta') {
            assistantPartialText += event.delta;
            updateLocalMessages(conversationKey, (prev) =>
              prev.map((message) =>
                message.id === assistantId ? { ...message, content: message.content + event.delta } : message,
              ),
            );
          }
        },
      });

      // Captured once so the display string and the ISO `tsRaw`
      // reflect the same instant.
      const completedAt = new Date();
      updateLocalMessages(conversationKey, (prev) =>
        adoptLocalAgentTurnId(prev, correlationId, result.turnId).map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: result.text || message.content,
                turnId: result.turnId?.trim() || message.turnId,
                streaming: false,
                // `result.text` is the real agent-authored content; the
                // fallback path keeps whatever's already in `message.content`
                // (which is either earlier streamed agent text or — empty).
                // Only mark synthesized when neither is true.
                synthesized: !result.text && !message.content ? true : message.synthesized,
                // Same helper as user-send + history paths for a single
                // consistent date+time timestamp format across all sources.
                ts: formatLocalTimestamp(completedAt),
                tsRaw: toIsoTimestamp(completedAt),
              }
            : message,
        ),
      );
      const resolvedPrimeSessionId = integrationId === 'prime-agent'
        ? result.sessionId?.trim()
        : undefined;
      if (
        resolvedPrimeSessionId
        && resolvedPrimeSessionId !== conversation.sessionId
        && selectedIntegrationIdRef.current === integrationId
        && selectedSessionIdRef.current === conversation.sessionId
      ) {
        const nextConversationKey = getLocalAgentConversationStateKey(
          integrationId,
          resolvedPrimeSessionId,
        );
        // Preserve the just-finished transcript while moving the routing pin
        // to the replacement Prime session. The API retries only the explicit
        // PRIME_AGENT_NO_SESSION miss, which is a pre-delivery failure, so this
        // migration cannot duplicate an executed turn.
        setLocalMessagesByConversation((prev) => ({
          ...prev,
          [nextConversationKey]: mergeLocalAgentMessages(
            prev[nextConversationKey] ?? [],
            prev[conversationKey] ?? [],
          ),
        }));
        setLocalHistoryLoadedByConversation((prev) => ({
          ...prev,
          [nextConversationKey]: prev[conversationKey] ?? true,
        }));
        setSelectedIntegration(integrationId, { sessionId: resolvedPrimeSessionId });
        setConnectNotice(`${integration.name} restarted; switched chat to the live session.`);
      }
      loadSessions();
      if (stage === 0) advance();
    } catch (err: any) {
      const isUserAbort = err?.name === 'AbortError';
      const failureReason = isUserAbort ? 'Request cancelled.' : formatLocalAgentErrorMessage(integration, err);
      const failureContent = isUserAbort ? failureReason : `Error: ${failureReason}`;
      if (assistantId) {
        const failedDisplay = buildLiveFailedTurnDisplay(assistantPartialText, failureContent);
        updateLocalMessages(conversationKey, (prev) =>
          prev.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  ...failedDisplay,
                  streaming: false,
                }
              : message,
          ),
        );
      }
      if (!isUserAbort && integrationId === 'hermes' && assistantId && messageText) {
        void (async () => {
          try {
            const persisted = await persistLocalAgentChatFailure(integrationId, {
              sessionId: conversation.sessionId ?? undefined,
              correlationId: correlationId || undefined,
              userMessage: messageText,
              assistantReply: assistantPartialText,
              failureReason,
              profile: integration.profile,
              attachments: failureAttachmentRefs,
              contextGraphId: activeProjectId ?? undefined,
            });
            if (persisted.turnId) {
              updateLocalMessages(conversationKey, (prev) =>
                adoptLocalAgentTurnId(prev, correlationId, persisted.turnId),
              );
            }
            loadSessions();
          } catch {
            // The in-memory error bubble remains useful even if durable failure
            // persistence is temporarily unavailable.
          }
        })();
      }
      // Restore the attachment drafts we optimistically cleared so the user
      // can retry the same files without re-uploading. Merge instead of
      // overwriting in case the user has queued NEW drafts during the
      // in-flight request — keep those, prepend the failed ones.
      if (deliveredAttachmentIds.length > 0 && processedDrafts.length > 0) {
        setAttachmentDraftsByConversation((prev) => {
          const current = prev[conversationKey] ?? [];
          const existingIds = new Set(current.map((d) => d.id));
          const restored = processedDrafts.filter((d) => !existingIds.has(d.id));
          if (restored.length === 0) return prev;
          return { ...prev, [conversationKey]: [...restored, ...current] };
        });
      }
      void refreshLocalIntegrations();
    } finally {
      setLocalSendingForConversation(conversationKey, false);
      // Only clear THIS conversation's controller — leave any other
      // in-flight conversation's entry alone. Compare-and-delete so a
      // late `finally` from a previous send can't accidentally wipe a
      // newer entry under the same key after a quick retry.
      if (localAbortRef.current.get(conversationKey) === controller) {
        localAbortRef.current.delete(conversationKey);
      }
    }
  }, [
    activeProjectId,
    advance,
    availableProjects,
    currentAgent,
    loadSessions,
    localInput,
    localSending,
    prepareAttachmentDraftsForSend,
    selectedAttachmentDrafts,
    refreshLocalIntegrations,
    selectedConversation,
    selectedIntegration,
    clearCompletedAttachmentsForConversation,
    setLocalInputForConversation,
    setLocalSendingForConversation,
    setSelectedIntegration,
    stage,
    updateLocalMessages,
  ]);

  const stopLocalStream = useCallback(() => {
    // Aborts ONLY the currently-selected conversation's in-flight
    // request. With the per-conversation abort-controller map,
    // clicking Stop in conversation A can no longer accidentally
    // abort B's stream — even if B started later, B's controller
    // lives under B's key. The existing `sendLocalMessage`
    // `catch (err: any)` block already handles `err?.name ===
    // 'AbortError'` by replacing the assistant bubble content with
    // "Request cancelled." and dropping `streaming: false`, so a
    // single `.abort()` here is enough — no additional teardown.
    if (!selectedConversationKey) return;
    const controller = localAbortRef.current.get(selectedConversationKey);
    controller?.abort();
  }, [selectedConversationKey]);

  const connectIntegration = useCallback(async (integrationId: string) => {
    setConnectBusyId(integrationId);
    setConnectError(null);
    setConnectNotice(null);
    try {
      const result = await connectLocalAgentIntegration(integrationId);
      setIntegrations((prev) => upsertLocalAgentIntegrationState(prev, result.integration));
      await refreshLocalIntegrations();
      const nextIntegrations = upsertLocalAgentIntegrationState(integrations, result.integration);
      const preserveSession = shouldPreserveSessionOnReconnect({
        integrationId,
        selectedSessionId,
        integrations: nextIntegrations,
      });
      setSelectedIntegration(integrationId, {
        preserveSession,
        sessionId: result.integration.defaultSessionId,
      });
      autoFocusedLocalAgentRef.current = true;
      setConnectNotice(
        result.notice
          ?? (result.integration.chatReady
            ? `${result.integration.name} is connected and chat-ready.`
            : `${result.integration.name} attach is in progress. The node will keep checking for a live bridge.`),
      );
      setMode('agents');
    } catch (err: any) {
      await refreshLocalIntegrations();
      setConnectError(err.message);
    } finally {
      setConnectBusyId(null);
    }
  }, [integrations, refreshLocalIntegrations, selectedSessionId, setSelectedIntegration]);

  const disconnectIntegration = useCallback(async (integrationId: string) => {
    setConnectError(null);
    setConnectNotice(null);
    try {
      await disconnectLocalAgentIntegration(integrationId);
      setIntegrations((prev) => markLocalAgentIntegrationDisconnected(prev, integrationId));
      autoFocusedLocalAgentRef.current = false;
      setSelectedIntegration(integrationId, { preserveSession: selectedIntegrationId === integrationId });
      setConnectNotice('The local agent was disconnected from this node. Session history remains available here.');
      setMode('agents');
      await refreshLocalIntegrations();
    } catch (err: any) {
      setConnectError(err.message);
    }
  }, [refreshLocalIntegrations, selectedIntegrationId, setSelectedIntegration]);

  const refreshIntegration = useCallback(async (integrationId: string) => {
    if (refreshBusyId === integrationId) return;
    setRefreshBusyId(integrationId);
    setConnectError(null);
    setConnectNotice(null);
    const conversation = resolveLocalAgentConversation({
      integrationId,
      sessionId: selectedIntegrationId === integrationId ? selectedSessionIdRef.current : null,
      defaultSessionId: integrations.find((item) => item.id === integrationId)?.defaultSessionId,
    });
    const [refreshOutcome, historyOutcome] = await Promise.allSettled([
      refreshLocalAgentIntegration(integrationId),
      fetchLocalAgentHistory(integrationId, 100, {
        sessionId: conversation.sessionId ?? undefined,
      }),
    ]);
    try {
      if (refreshOutcome.status === 'fulfilled') {
        setIntegrations((prev) => upsertLocalAgentIntegrationState(prev, refreshOutcome.value.integration));
        if (refreshOutcome.value.notice) {
          setConnectNotice(refreshOutcome.value.notice);
        }
      } else {
        setConnectError((refreshOutcome.reason as Error)?.message ?? 'Failed to refresh integration.');
      }
      if (historyOutcome.status === 'fulfilled') {
        const loaded = historyOutcome.value.map((message) => mapHistoryMessage(message, integrationId));
        updateLocalMessages(conversation.stateKey, (prev) => mergeLocalAgentMessages(prev, loaded));
        setLocalHistoryLoadedByConversation((prev) => ({
          ...prev,
          [conversation.stateKey]: true,
        }));
      } else if (refreshOutcome.status === 'fulfilled') {
        setConnectError((historyOutcome.reason as Error)?.message ?? 'Failed to refresh conversation.');
      }
    } finally {
      setRefreshBusyId(null);
    }
  }, [integrations, refreshBusyId, selectedIntegrationId, updateLocalMessages]);

  const openSession = useCallback((session: LocalAgentSessionSummary) => {
    setSelectedIntegration(session.integrationId, { sessionId: session.sessionId });
    setMode('agents');
  }, [setSelectedIntegration]);

  const handleSelectProject = useCallback((projectId: string) => {
    setActiveProject(projectId || null);
  }, [setActiveProject]);

  const handleAddAttachments = useCallback((files: FileList | File[]) => {
    if (!selectedConversationKey || !activeProjectId) return;
    void addAttachmentsForConversation(selectedConversationKey, files, activeProjectId);
  }, [activeProjectId, addAttachmentsForConversation, selectedConversationKey]);

  const handleRemoveAttachment = useCallback((attachmentId: string) => {
    if (!selectedConversationKey) return;
    removeAttachmentForConversation(selectedConversationKey, attachmentId);
  }, [removeAttachmentForConversation, selectedConversationKey]);

  return (
    <div className="v10-panel-right">
      <div className="v10-agent-mode-tabs">
        <button
          className={`v10-agent-mode-tab ${mode === 'agents' ? 'active' : ''}`}
          onClick={() => setMode('agents')}
        >
          Agents
        </button>
        <button
          className={`v10-agent-mode-tab ${mode === 'network' ? 'active' : ''}`}
          onClick={() => setMode('network')}
        >
          Network
        </button>
        <button
          className={`v10-agent-mode-tab ${mode === 'sessions' ? 'active' : ''}`}
          onClick={() => setMode('sessions')}
        >
          Sessions
        </button>
      </div>

      {mode === 'agents' && (
        <ConnectedAgentsTab
          integrations={integrations}
          selectedIntegrationId={selectedIntegrationId}
          selectedIntegration={selectedIntegration}
          selectedSessionId={selectedSessionId}
          selectedHasConversation={selectedHasConversation}
          selectedIntegrationHasAnyConversation={selectedIntegrationHasAnyConversation}
          onSelectIntegration={setSelectedIntegration}
          onConnectIntegration={connectIntegration}
          onDisconnectIntegration={disconnectIntegration}
          onRefreshIntegration={refreshIntegration}
          connectBusyId={connectBusyId}
          refreshBusyId={refreshBusyId}
          connectNotice={connectNotice}
          connectError={connectError}
          localMessages={selectedLocalMessages}
          localHistoryLoaded={selectedLocalHistoryLoaded}
          localChatEndRef={localChatEndRef}
          localInput={localInput}
          onLocalInputChange={(value) => setLocalInputForConversation(selectedConversationKey, value)}
          onSendLocalMessage={sendLocalMessage}
          onStopLocalStream={stopLocalStream}
          localSending={localSending}
          activeProjectId={activeProjectId}
          availableProjects={availableProjects}
          selectableProjects={selectableProjects}
          projectsLoading={projectsLoading}
          onSelectProject={handleSelectProject}
          attachments={selectedAttachmentDrafts}
          onAddAttachments={handleAddAttachments}
          onRemoveAttachment={handleRemoveAttachment}
        />
      )}

      {mode === 'network' && (
        <NetworkTab
          peerAgents={peerAgents}
          connections={connections}
          loading={peerLoading}
          onRefresh={refreshPeers}
        />
      )}

      {mode === 'sessions' && (
        <SessionsTab
          sessions={localSessions}
          onOpenSession={openSession}
        />
      )}
    </div>
  );
}
