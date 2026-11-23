import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProjectsStore } from '../../../stores/projects.js';
import { useContextGraphInventory } from '../../../hooks/useContextGraphInventory.js';
import {
  type LocalAgentIntegration,
  type MemorySession,
  connectLocalAgentIntegration,
  clearLocalLlmSession,
  disconnectLocalAgentIntegration,
  fetchAgents,
  fetchConnections,
  getDefaultLocalAgentSessionId,
  fetchLocalAgentIntegrations,
  refreshLocalAgentIntegration,
} from '../../../api.js';
import { api } from '../../../api-wrapper.js';
import { computeSelectableProjects, toSidebarIdentity } from '../../../lib/contextGraphSidebar.js';
import { useVisibilityPolling } from '../../../hooks/useVisibilityPolling.js';
import { buildChatContextEntries } from './chat-context.js';
import { ADD_AGENT_TAB_ID, STATIC_DEFAULT_LOCAL_AGENT_HISTORY_INTEGRATIONS } from './constants.js';
import { ConnectedAgentsTab } from './ConnectedAgentsTab.js';
import { NetworkTab } from './NetworkTab.js';
import { SessionsTab } from './SessionsTab.js';
import {
  compareLocalAgentIntegrations,
  markLocalAgentIntegrationDisconnected,
  resolveLocalAgentConversation,
  resolveLocalAgentSelectionState,
  shouldPreserveSelectedLocalAgentTab,
  shouldPreserveSessionOnReconnect,
  summarizeLocalAgentSessions,
  upsertLocalAgentIntegrationState,
} from './selection.js';
import type { AgentInfo, ConnectionRow, LocalAgentSessionSummary } from './types.js';
import {
  conversationActions,
  messagesByConversation,
  useAgentConversations,
  useConversation,
} from '../../../stores/agentConversations.js';
import { useLayoutStore } from '../../../stores/layout.js';
import { Maximize2, Minimize2 } from 'lucide-react';

export function PanelRight() {
  const [mode, setMode] = useState<'agents' | 'network' | 'sessions'>('agents');

  const [memorySessions, setMemorySessions] = useState<MemorySession[]>([]);
  const [peerAgents, setPeerAgents] = useState<AgentInfo[]>([]);
  const [connections, setConnections] = useState<{ total: number; direct: number; relayed: number; rows: ConnectionRow[] }>({ total: 0, direct: 0, relayed: 0, rows: [] });
  const [peerLoading, setPeerLoading] = useState(true);
  // Inventory composes the same shared identity used by Header (BUG-007).
  const { contextGraphs: availableProjects, loading: projectsLoading,
    identity: { data: currentAgent } } = useContextGraphInventory();

  const [integrations, setIntegrations] = useState<LocalAgentIntegration[]>([]);
  const [selectedIntegrationId, setSelectedIntegrationId] = useState('openclaw');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    () => getDefaultLocalAgentSessionId('openclaw'),
  );
  const [connectBusyId, setConnectBusyId] = useState<string | null>(null);
  const [connectNotice, setConnectNotice] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [refreshBusyId, setRefreshBusyId] = useState<string | null>(null);
  const [clearBusyId, setClearBusyId] = useState<string | null>(null);

  // Conversations, and the replies in flight that change them, live in a
  // store: the panel unmounts when it's closed, and they carry on without it.
  const conversations = useAgentConversations((s) => s.conversations);
  const sessionsRevision = useAgentConversations((s) => s.sessionsRevision);
  const localMessagesByConversation = useMemo(() => messagesByConversation(conversations), [conversations]);

  const autoFocusedLocalAgentRef = useRef(false);
  const localChatEndRef = useRef<HTMLDivElement>(null);
  const memorySessionsRef = useRef<MemorySession[]>([]);
  const selectedIntegrationIdRef = useRef('openclaw');
  const selectedSessionIdRef = useRef<string | null>(getDefaultLocalAgentSessionId('openclaw'));
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
  const {
    messages: selectedLocalMessages,
    historyLoaded: selectedLocalHistoryLoaded,
    input: localInput,
    sending: localSending,
    attachments: selectedAttachmentDrafts,
  } = useConversation(selectedConversationKey);
  const scrollLocalChatToBottom = useCallback(() => {
    localChatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(scrollLocalChatToBottom, [selectedConversationKey, selectedLocalMessages, scrollLocalChatToBottom]);

  useEffect(() => {
    memorySessionsRef.current = memorySessions;
  }, [memorySessions]);

  useEffect(() => {
    selectedIntegrationIdRef.current = selectedIntegrationId;
  }, [selectedIntegrationId]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

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
        localMessagesByConversation: messagesByConversation(useAgentConversations.getState().conversations),
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

  useEffect(() => {
    loadSessions();
    refreshPeers();
    refreshLocalIntegrations();
  }, [loadSessions, refreshPeers, refreshLocalIntegrations]);

  // The store says when the node's sessions may have changed (history
  // loaded, a turn sent or a failure saved); the mount effect above has
  // already loaded them once.
  const seenSessionsRevisionRef = useRef(sessionsRevision);
  useEffect(() => {
    if (sessionsRevision === seenSessionsRevisionRef.current) return;
    seenSessionsRevisionRef.current = sessionsRevision;
    loadSessions();
  }, [loadSessions, sessionsRevision]);

  // Mount-time hydrate stable local-agent sessions so chat history paints
  // before bridge probes complete (issue #255).
  useEffect(() => {
    for (const integrationId of STATIC_DEFAULT_LOCAL_AGENT_HISTORY_INTEGRATIONS) {
      void conversationActions.loadHistory({ integrationId, sessionId: getDefaultLocalAgentSessionId(integrationId) });
    }
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
      if (selectedConversationKey) conversationActions.markHistoryUnloaded(selectedConversationKey);
      return;
    }
    void conversationActions.loadHistory({
      integrationId: selectedIntegration.id,
      sessionId: selectedConversation?.sessionId ?? null,
      defaultSessionId: selectedIntegration.defaultSessionId ?? null,
    });
  }, [
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
    if (!integration || !conversation) return;
    // The store runs the turn, so it finishes even if the panel closes;
    // what's left here is what the panel shows about it.
    const pending = conversationActions.send({
      integration,
      sessionId: conversation.sessionId,
      contextEntries: buildChatContextEntries(availableProjects, activeProjectId, currentAgent),
      contextGraphId: activeProjectId,
    });
    if (!pending) return;
    setConnectError(null);
    const outcome = await pending;
    if (outcome.status === 'failed') {
      // Failures before the turn shows still need saying; the composer keeps its text.
      if (!outcome.inConversation) setConnectError(outcome.reason);
      void refreshLocalIntegrations();
      return;
    }
    if (
      outcome.status === 'sent'
      && outcome.sessionId
      && selectedIntegrationIdRef.current === integration.id
      && selectedSessionIdRef.current === conversation.sessionId
    ) {
      // Prime restarted and the store moved the transcript; follow it if this chat is still showing.
      setSelectedIntegration(integration.id, { sessionId: outcome.sessionId });
      setConnectNotice(`${integration.name} restarted; switched chat to the live session.`);
    }
  }, [
    activeProjectId,
    availableProjects,
    currentAgent,
    refreshLocalIntegrations,
    selectedConversation,
    selectedIntegration,
    setSelectedIntegration,
  ]);

  const stopLocalStream = useCallback(() => {
    if (selectedConversationKey) conversationActions.stop(selectedConversationKey);
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
    const [[refreshOutcome], history] = await Promise.all([
      Promise.allSettled([refreshLocalAgentIntegration(integrationId)]),
      conversationActions.loadHistory({
        integrationId,
        sessionId: selectedIntegrationId === integrationId ? selectedSessionIdRef.current : null,
        defaultSessionId: integrations.find((item) => item.id === integrationId)?.defaultSessionId,
      }, { refresh: true }),
    ]);
    try {
      if (refreshOutcome.status === 'fulfilled') {
        setIntegrations((prev) => upsertLocalAgentIntegrationState(prev, refreshOutcome.value.integration));
        if (refreshOutcome.value.notice) {
          setConnectNotice(refreshOutcome.value.notice);
        }
        if (!history.ok) {
          setConnectError((history.error as Error)?.message ?? 'Failed to refresh conversation.');
        }
      } else {
        setConnectError((refreshOutcome.reason as Error)?.message ?? 'Failed to refresh integration.');
      }
    } finally {
      setRefreshBusyId(null);
    }
  }, [integrations, refreshBusyId, selectedIntegrationId]);

  const clearIntegrationSession = useCallback(async (integrationId: string) => {
    if (integrationId !== 'local-llm' || clearBusyId) return;
    setClearBusyId(integrationId);
    setConnectError(null);
    setConnectNotice(null);
    try {
      await clearLocalLlmSession();
      const conversation = resolveLocalAgentConversation({
        integrationId,
        sessionId: getDefaultLocalAgentSessionId(integrationId),
      });
      conversationActions.clear(conversation.stateKey);
      setConnectNotice('DKG Local LLM session cleared. You can now select a different context graph.');
      await refreshLocalIntegrations();
    } catch (err: any) {
      setConnectError(err?.message ?? 'Failed to clear the local LLM session.');
    } finally {
      setClearBusyId(null);
    }
  }, [clearBusyId, refreshLocalIntegrations]);

  const openSession = useCallback((session: LocalAgentSessionSummary) => {
    setSelectedIntegration(session.integrationId, { sessionId: session.sessionId });
    setMode('agents');
  }, [setSelectedIntegration]);

  const handleSelectProject = useCallback((projectId: string) => {
    setActiveProject(projectId || null);
  }, [setActiveProject]);

  const handleAddAttachments = useCallback((files: FileList | File[]) => {
    if (!selectedConversationKey || !activeProjectId) return;
    conversationActions.addAttachments(selectedConversationKey, files, activeProjectId);
  }, [activeProjectId, selectedConversationKey]);

  const handleRemoveAttachment = useCallback((attachmentId: string) => {
    if (!selectedConversationKey) return;
    conversationActions.removeAttachment(selectedConversationKey, attachmentId);
  }, [selectedConversationKey]);

  const rightExpanded = useLayoutStore((s) => s.rightExpanded);
  const setRightExpanded = useLayoutStore((s) => s.setRightExpanded);

  return (
    <div className="v10-panel-right">
      <div className="v10-agent-mode-tabs">
        <div className="ds-seg" role="group" aria-label="Panel view">
          {(['agents', 'network', 'sessions'] as const).map((m) => (
            <button key={m} aria-pressed={mode === m} className={`v10-agent-mode-tab ds-seg-item ${mode === m ? 'active' : ''}`} onClick={() => setMode(m)}>
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="v10-panel-expand ds-btn ds-ghost ds-sm ds-icon"
          aria-label={rightExpanded ? 'Collapse agents panel' : 'Expand agents panel'}
          title={rightExpanded ? 'Collapse panel' : 'Expand panel'}
          onClick={() => setRightExpanded(!rightExpanded)}
        >
          {rightExpanded ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
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
          onClearIntegrationSession={clearIntegrationSession}
          connectBusyId={connectBusyId}
          refreshBusyId={refreshBusyId}
          clearBusyId={clearBusyId}
          connectNotice={connectNotice}
          connectError={connectError}
          localMessages={selectedLocalMessages}
          localHistoryLoaded={selectedLocalHistoryLoaded}
          localChatEndRef={localChatEndRef}
          localInput={localInput}
          onLocalInputChange={(value) => { if (selectedConversationKey) conversationActions.setInput(selectedConversationKey, value); }}
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
