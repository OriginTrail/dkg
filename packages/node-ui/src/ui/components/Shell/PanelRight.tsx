import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useJourneyStore } from '../../stores/journey.js';
import {
  type LocalAgentIntegration,
  type LocalAgentHistoryMessage,
  type LocalAgentStreamEvent,
  type MemorySession,
  connectLocalAgentIntegration,
  disconnectLocalAgentIntegration,
  fetchAgents,
  fetchConnections,
  getDefaultLocalAgentSessionId,
  fetchLocalAgentHistory,
  fetchLocalAgentIntegrations,
  streamLocalAgentChat,
} from '../../api.js';
import { api } from '../../api-wrapper.js';

interface LocalAgentMessage {
  id: string;
  uri?: string;
  turnId?: string;
  role: 'user' | 'assistant';
  content: string;
  ts?: string;
  streaming?: boolean;
}

interface AgentInfo {
  agentUri: string;
  name: string;
  peerId: string;
  framework?: string;
  nodeRole?: string;
  connectionStatus?: string;
  connectionTransport?: string;
  connectionDirection?: string;
  lastSeen?: number;
  latencyMs?: number;
}

interface LocalAgentSessionSummary {
  sessionId: string;
  integrationId: string;
  integrationName: string;
  preview: string;
  messageCount: number;
  lastTs?: string;
}

const OPENCLAW_DOCS_URL = 'https://docs.openclaw.ai/';
const OPENCLAW_RELEASE_URL = 'https://github.com/openclaw/openclaw/releases';
const ADD_AGENT_TAB_ID = '__add_agent__';

let localMessageId = 0;

function shortPeerId(peerId: string): string {
  return peerId.length > 12 ? peerId.slice(-8) : peerId;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatLocalTimestamp(value?: string): string {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function mapHistoryMessage(message: LocalAgentHistoryMessage): LocalAgentMessage {
  const author = message.author.toLowerCase();
  return {
    id: message.uri || `local-history:${++localMessageId}`,
    uri: message.uri,
    turnId: message.turnId,
    role: author.includes('assistant') || author.includes('agent') ? 'assistant' : 'user',
    content: message.text,
    ts: formatLocalTimestamp(message.ts),
  };
}

function localMessageKey(message: LocalAgentMessage): string {
  return message.turnId
    ? `turn:${message.turnId}:${message.role}`
    : message.uri
    ?? `${message.role}:${message.ts ?? ''}:${message.content}`;
}

function mergeLocalAgentMessages(existing: LocalAgentMessage[], incoming: LocalAgentMessage[]): LocalAgentMessage[] {
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

export function getLocalAgentConversationStateKey(
  integrationId: string,
  sessionId: string | null,
): string {
  return sessionId?.trim() || `integration:${integrationId}`;
}

function resolveLocalAgentConversation(args: {
  integrationId: string;
  sessionId: string | null;
}): { integrationId: string; sessionId: string | null; stateKey: string } {
  const resolvedSessionId = args.sessionId ?? getDefaultLocalAgentSessionId(args.integrationId);
  return {
    integrationId: args.integrationId,
    sessionId: resolvedSessionId,
    stateKey: getLocalAgentConversationStateKey(args.integrationId, resolvedSessionId),
  };
}

function integrationIdFromSessionId(
  sessionId: string,
  integrations: LocalAgentIntegration[],
): { id: string; name: string } | null {
  for (const integration of integrations) {
    if (sessionId === integration.id || sessionId.startsWith(`${integration.id}:`)) {
      return { id: integration.id, name: integration.name };
    }
  }
  return null;
}

function summarizeLocalAgentSessions(
  sessions: MemorySession[],
  integrations: LocalAgentIntegration[],
): LocalAgentSessionSummary[] {
  const summaries = sessions.flatMap((session) => {
    const integration = integrationIdFromSessionId(session.session, integrations);
    if (!integration) return [];
    const firstUserMessage = session.messages.find((message) => message.author === 'user');
    const lastMessage = session.messages[session.messages.length - 1];
    return [{
      sessionId: session.session,
      integrationId: integration.id,
      integrationName: integration.name,
      preview: firstUserMessage?.text?.slice(0, 60) || session.session,
      messageCount: session.messages.length,
      lastTs: lastMessage?.ts,
    }];
  });

  summaries.sort((a, b) => {
    const aTime = Date.parse(a.lastTs ?? '');
    const bTime = Date.parse(b.lastTs ?? '');
    if (Number.isFinite(aTime) && Number.isFinite(bTime)) return bTime - aTime;
    return String(b.lastTs ?? '').localeCompare(String(a.lastTs ?? ''));
  });
  return summaries;
}

function hasLocalAgentConversation(
  integrationId: string,
  selectedSessionId: string | null,
  localMessagesByConversation: Record<string, LocalAgentMessage[]>,
  sessions: LocalAgentSessionSummary[],
): boolean {
  const conversation = resolveLocalAgentConversation({
    integrationId,
    sessionId: selectedSessionId,
  });
  return (localMessagesByConversation[conversation.stateKey]?.length ?? 0) > 0
    || (conversation.sessionId
      ? sessions.some((session) => session.sessionId === conversation.sessionId)
      : false)
    || sessions.some((session) => session.integrationId === integrationId);
}

export function resolveLocalAgentSelectionState(args: {
  integrations: LocalAgentIntegration[];
  selectedIntegrationId: string;
  selectedSessionId: string | null;
  localMessagesByConversation: Record<string, LocalAgentMessage[]>;
  sessions: LocalAgentSessionSummary[];
}) {
  const sortedIntegrations = [...args.integrations].sort(compareLocalAgentIntegrations);
  const connectedIntegrations = sortedIntegrations.filter((item) => item.persistentChat);
  const selectedIntegration = sortedIntegrations.find((item) => item.id === args.selectedIntegrationId)
    ?? connectedIntegrations[0]
    ?? null;
  const selectedConversation = selectedIntegration
    ? resolveLocalAgentConversation({
      integrationId: selectedIntegration.id,
      sessionId: args.selectedSessionId,
    })
    : null;
  const selectedHasConversation = selectedIntegration
    ? hasLocalAgentConversation(
      selectedIntegration.id,
      args.selectedSessionId,
      args.localMessagesByConversation,
      args.sessions,
    )
    : false;

  return {
    sortedIntegrations,
    connectedIntegrations,
    selectedIntegration,
    selectedConversation,
    selectedHasConversation,
  };
}

function compareLocalAgentIntegrations(a: LocalAgentIntegration, b: LocalAgentIntegration): number {
  const aPriority = a.id === 'openclaw' ? 0 : 1;
  const bPriority = b.id === 'openclaw' ? 0 : 1;
  if (aPriority !== bPriority) return aPriority - bPriority;
  if (a.persistentChat !== b.persistentChat) return a.persistentChat ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export function upsertLocalAgentIntegrationState(
  integrations: LocalAgentIntegration[],
  nextIntegration: LocalAgentIntegration,
): LocalAgentIntegration[] {
  return [...integrations.filter((item) => item.id !== nextIntegration.id), nextIntegration]
    .sort(compareLocalAgentIntegrations);
}

export function markLocalAgentIntegrationDisconnected(
  integrations: LocalAgentIntegration[],
  integrationId: string,
): LocalAgentIntegration[] {
  const existing = integrations.find((item) => item.id === integrationId);
  if (!existing) return integrations;
  const readyToConnect = existing.connectSupported;
  const status = readyToConnect ? 'available' : 'coming_soon';
  const statusLabel = readyToConnect ? 'Ready to connect' : 'Coming next';
  return upsertLocalAgentIntegrationState(integrations, {
    ...existing,
    configured: false,
    detected: false,
    persistentChat: false,
    chatReady: false,
    bridgeOnline: false,
    bridgeStatusLabel: statusLabel,
    status,
    statusLabel,
    detail: readyToConnect
      ? `${existing.name} is no longer attached to this node. Reconnect from the + tab when you want live chat again.`
      : existing.detail,
    error: undefined,
    target: undefined,
  });
}

function bridgeStatusDotClass(integration: LocalAgentIntegration): string {
  if (integration.bridgeOnline) return 'connected';
  if (integration.status === 'connecting') return 'known';
  return 'offline';
}

export function networkPeerCardStatusClass(agent: Pick<AgentInfo, 'connectionStatus'>): 'connected' | 'offline' {
  return agent.connectionStatus === 'connected' ? 'connected' : 'offline';
}

function localAgentToolbarLabel(
  integration: LocalAgentIntegration,
  showingSessionHistory: boolean,
): string {
  if (showingSessionHistory) {
    return 'Session history';
  }
  if (integration.chatReady) {
    return `${integration.name} connected`;
  }
  if (integration.status === 'connecting') {
    return `${integration.name} is connecting…`;
  }
  return `${integration.name} is unavailable`;
}

function formatLocalAgentErrorMessage(
  integration: LocalAgentIntegration,
  err: unknown,
): string {
  const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  if (/OpenClaw bridge unreachable/i.test(message)) {
    return `${integration.name} is unavailable right now.`;
  }
  if (/Agent response timeout/i.test(message)) {
    return `${integration.name} took too long to respond.`;
  }
  if (/Agent returned no text response/i.test(message) || /\(no response\)/i.test(message)) {
    return `${integration.name} did not return a text reply.`;
  }
  return message;
}

function ConnectedAgentsTab(props: {
  integrations: LocalAgentIntegration[];
  selectedIntegrationId: string;
  selectedIntegration: LocalAgentIntegration | null;
  selectedHasConversation: boolean;
  onSelectIntegration: (id: string) => void;
  onConnectIntegration: (id: string) => void;
  onDisconnectIntegration: (id: string) => void;
  onRefreshIntegrations: () => void;
  connectBusyId: string | null;
  connectNotice: string | null;
  connectError: string | null;
  localMessages: LocalAgentMessage[];
  localHistoryLoaded: boolean;
  localChatEndRef: React.RefObject<HTMLDivElement | null>;
  localInput: string;
  onLocalInputChange: (value: string) => void;
  onSendLocalMessage: () => void;
  localSending: boolean;
}) {
  const {
    integrations,
    selectedIntegrationId,
    selectedIntegration,
    selectedHasConversation,
    onSelectIntegration,
    onConnectIntegration,
    onDisconnectIntegration,
    onRefreshIntegrations,
    connectBusyId,
    connectNotice,
    connectError,
    localMessages,
    localHistoryLoaded,
    localChatEndRef,
    localInput,
    onLocalInputChange,
    onSendLocalMessage,
    localSending,
  } = props;

  const sortedIntegrations = [...integrations].sort(compareLocalAgentIntegrations);
  const connectedAgents = sortedIntegrations.filter((item) => item.persistentChat);
  const addableIntegrations = sortedIntegrations.filter((item) => !item.persistentChat);
  const selected = selectedIntegration;
  const showingSessionHistory = Boolean(selected && !selected.persistentChat && selectedHasConversation);
  const visibleAgentTabs = showingSessionHistory
    ? [selected!, ...connectedAgents.filter((item) => item.id !== selected!.id)]
    : connectedAgents;
  const showAddFlow = selectedIntegrationId === ADD_AGENT_TAB_ID
    || (!selected && connectedAgents.length === 0)
    || Boolean(selected && !selected.persistentChat && !selectedHasConversation);
  const inputDisabled = localSending || !selected?.chatReady;

  return (
    <div className="v10-agents-tab">
      <div className="v10-agent-subtabs" role="tablist" aria-label="Integrated agents">
        {visibleAgentTabs.map((integration) => (
          <button
            key={integration.id}
            className={`v10-agent-subtab ${selected?.id === integration.id && !showAddFlow ? 'active' : ''}`}
            onClick={() => onSelectIntegration(integration.id)}
            role="tab"
            aria-selected={selected?.id === integration.id && !showAddFlow}
          >
            <span className={`v10-agents-stat-dot ${bridgeStatusDotClass(integration)}`} />
            <span>{integration.name}</span>
          </button>
        ))}
        <button
          className={`v10-agent-subtab add ${showAddFlow ? 'active' : ''}`}
          onClick={() => onSelectIntegration(ADD_AGENT_TAB_ID)}
          role="tab"
          aria-selected={showAddFlow}
          aria-label="Add another integrated agent"
          title="Add another integrated agent"
        >
          +
        </button>
      </div>

      {showAddFlow ? (
        <div className="v10-agent-add-surface">
          <div className="v10-agents-section-label">Connect Another Agent</div>
          {connectNotice && <div className="v10-local-agent-notice">{connectNotice}</div>}
          {connectError && <div className="v10-local-agent-error">{connectError}</div>}
          <div className="v10-local-agent-list" aria-label="Available agent integrations">
            {addableIntegrations.length === 0 && (
              <div className="v10-agent-empty-state">
                No additional local agent integrations are available yet.
              </div>
            )}
            {addableIntegrations.map((integration) => (
              <div key={integration.id} className="v10-local-agent-detail v10-local-agent-choice">
                <div className="v10-local-agent-detail-head">
                  <div>
                    <div className="v10-local-agent-title">{integration.name}</div>
                    <div className="v10-local-agent-subtitle">{integration.description}</div>
                  </div>
                  <span className={`v10-local-agent-status-pill ${integration.status}`}>
                    {integration.statusLabel}
                  </span>
                </div>
                <p className="v10-local-agent-copy">{integration.detail}</p>
                {integration.id === 'openclaw' && (
                  <>
                    <p className="v10-local-agent-copy">
                      Connect your local OpenClaw once, then this tab becomes the persistent chat surface for that agent. The node can retry the bridge without forcing you back through setup.
                    </p>
                    <div className="v10-local-agent-actions">
                      <button
                        className="v10-agent-send-btn secondary"
                        onClick={() => onConnectIntegration(integration.id)}
                        disabled={connectBusyId === integration.id}
                      >
                        {connectBusyId === integration.id ? 'Connecting...' : 'Connect OpenClaw'}
                      </button>
                      <a className="v10-agent-link-btn" href={OPENCLAW_DOCS_URL} target="_blank" rel="noreferrer">
                        Docs
                      </a>
                      <a className="v10-agent-link-btn" href={OPENCLAW_RELEASE_URL} target="_blank" rel="noreferrer">
                        Release Notes
                      </a>
                    </div>
                  </>
                )}
                {integration.id === 'hermes' && (
                  <p className="v10-local-agent-copy">
                    Hermes will plug into this same local-agent contract next, using the same side-panel chat surface once its runtime bridge is ready.
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        selected && (
          <div className="v10-local-agent-chat-shell">
            <div className="v10-local-agent-chat-toolbar">
              <span className="v10-agents-stat v10-local-agent-chat-toolbar-label">
                <span className={`v10-agents-stat-dot ${bridgeStatusDotClass(selected)}`} />
                {localAgentToolbarLabel(selected, showingSessionHistory)}
              </span>
              <div className="v10-local-agent-chat-actions">
                <button className="v10-agents-refresh" onClick={onRefreshIntegrations} title={`Refresh ${selected.name}`}>
                  Refresh
                </button>
                {selected.persistentChat && (
                <button
                  className="v10-agents-refresh disconnect"
                  onClick={() => onDisconnectIntegration(selected.id)}
                  title={`Disconnect ${selected.name} from this node`}
                >
                  Disconnect
                </button>
                )}
              </div>
            </div>

            {connectNotice && <div className="v10-local-agent-notice">{connectNotice}</div>}
            {connectError && <div className="v10-local-agent-error">{connectError}</div>}

            {!selected.chatReady && (
              <div className={`v10-local-agent-warning ${selected.status === 'connecting' ? 'connecting' : 'offline'}`}>
                {showingSessionHistory
                  ? `${selected.name} is not currently attached to this node. Session history remains available here; reconnect from the + tab when you want live chat again.`
                  : selected.status === 'connecting'
                  ? `${selected.name} is still finishing setup. This chat tab stays in place and will go live automatically when the connection is ready.`
                  : `${selected.name} is temporarily unavailable. Refresh after it recovers to resume chatting here.`}
              </div>
            )}

            <div className="v10-chat-messages v10-local-agent-messages">
              {!localHistoryLoaded && localMessages.length === 0 && (
                <div className="v10-agent-empty-state">
                  Loading the latest conversation from DKG memory...
                </div>
              )}
              {localHistoryLoaded && localMessages.length === 0 && (
                <div className="v10-agent-empty-state">
                  {showingSessionHistory
                    ? `${selected.name} session history is available, but there are no stored turns to show yet.`
                    : selected.chatReady
                    ? `Send a message to start chatting with ${selected.name}.`
                    : `${selected.name} is attached to this node. Your conversation history will stay here even while the bridge reconnects.`}
                </div>
              )}
              {localMessages.map((message) => (
                <div key={message.id} className={`v10-chat-msg ${message.role}`}>
                  <div className={`v10-chat-bubble ${message.role}`}>
                    {message.content}
                    {message.streaming && <span className="v10-chat-cursor" />}
                  </div>
                  {message.ts && (
                    <span className={`v10-local-agent-msg-time ${message.role}`}>
                      {message.ts}
                    </span>
                  )}
                </div>
              ))}
              <div ref={localChatEndRef} />
            </div>
            <div className="v10-agent-input-area">
              <input
                type="text"
                placeholder={
                  showingSessionHistory
                    ? `Reconnect ${selected.name} to resume live chat...`
                    : selected.chatReady
                    ? `Message ${selected.name}...`
                    : selected.status === 'connecting'
                      ? `${selected.name} is still connecting...`
                      : `${selected.name} bridge offline...`
                }
                className="v10-agent-input"
                value={localInput}
                onChange={(e) => onLocalInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    onSendLocalMessage();
                  }
                }}
                disabled={inputDisabled}
              />
              <button className="v10-agent-send-btn" onClick={onSendLocalMessage} disabled={inputDisabled || !localInput.trim()}>
                Send
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
}

function NetworkTab(props: {
  peerAgents: AgentInfo[];
  connections: { total: number; direct: number; relayed: number };
  loading: boolean;
  onRefresh: () => void;
}) {
  const { peerAgents, connections, loading, onRefresh } = props;

  return (
    <div className="v10-agents-tab">
      <div className="v10-agents-summary">
        <span className="v10-agents-stat">
          <span className={`v10-agents-stat-dot ${connections.total > 0 ? 'connected' : 'known'}`} />
          {connections.total} peer{connections.total !== 1 ? 's' : ''}
        </span>
        <span className="v10-agents-stat">{connections.direct} direct / {connections.relayed} relayed</span>
        <button className="v10-agents-refresh" onClick={onRefresh} title="Refresh network peers">
          Refresh
        </button>
      </div>

      <div className="v10-agents-section-label">Network Peers</div>
      {loading && <p className="v10-agents-loading">Loading peers...</p>}
      {peerAgents.length === 0 && !loading && (
        <div className="v10-agent-empty-state">No connected peers yet.</div>
      )}
      {peerAgents.map((agent) => {
        const statusClass = networkPeerCardStatusClass(agent);
        return (
        <div key={agent.peerId} className={`v10-agent-card ${statusClass}`}>
          <div className="v10-agent-card-header">
            <span className={`v10-agent-card-dot ${statusClass}`} />
            <span className="v10-agent-card-name">{agent.name}</span>
            <span className="v10-agent-card-badge">
              {agent.connectionStatus === 'connected'
                ? (agent.connectionTransport ?? 'direct')
                : 'Disconnected'}
            </span>
          </div>
          <div className="v10-agent-card-meta">
            <span>{agent.nodeRole ?? 'core'}</span>
            <span title={agent.peerId}>{shortPeerId(agent.peerId)}</span>
            {agent.latencyMs != null && <span>{agent.latencyMs}ms</span>}
            {agent.lastSeen != null && <span>{formatDuration(Date.now() - agent.lastSeen)} ago</span>}
          </div>
        </div>
        );
      })}
    </div>
  );
}

function SessionsTab(props: {
  sessions: LocalAgentSessionSummary[];
  onOpenSession: (session: LocalAgentSessionSummary) => void;
}) {
  const { sessions, onOpenSession } = props;

  return (
    <div className="v10-agent-content">
      <div className="v10-sessions-list">
        <div className="v10-local-agent-copy" style={{ marginBottom: 12 }}>
          Sessions track DKG-persisted conversations for your integrated agents. The current OpenClaw flow keeps one node-linked session, and separate session threads will expand later.
        </div>
        {sessions.length === 0 ? (
          <p className="v10-agent-empty-state">No integrated-agent sessions yet.</p>
        ) : (
          sessions.map((session) => (
            <button
              key={session.sessionId}
              className="v10-session-item"
              onClick={() => onOpenSession(session)}
            >
              <span className="v10-session-preview">
                {session.integrationName}: {session.preview}
              </span>
              <span className="v10-session-count">
                {session.messageCount} msg{session.messageCount !== 1 ? 's' : ''}
                {session.lastTs ? ` - ${formatLocalTimestamp(session.lastTs)}` : ''}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export function PanelRight() {
  const { stage, advance } = useJourneyStore();
  const [mode, setMode] = useState<'agents' | 'network' | 'sessions'>('agents');

  const [memorySessions, setMemorySessions] = useState<MemorySession[]>([]);
  const [peerAgents, setPeerAgents] = useState<AgentInfo[]>([]);
  const [connections, setConnections] = useState<{ total: number; direct: number; relayed: number }>({ total: 0, direct: 0, relayed: 0 });
  const [peerLoading, setPeerLoading] = useState(true);

  const [integrations, setIntegrations] = useState<LocalAgentIntegration[]>([]);
  const [selectedIntegrationId, setSelectedIntegrationId] = useState('openclaw');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    () => getDefaultLocalAgentSessionId('openclaw'),
  );
  const [connectBusyId, setConnectBusyId] = useState<string | null>(null);
  const [connectNotice, setConnectNotice] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [localMessagesByConversation, setLocalMessagesByConversation] = useState<Record<string, LocalAgentMessage[]>>({});
  const [localInputByConversation, setLocalInputByConversation] = useState<Record<string, string>>({});
  const [localSendingByConversation, setLocalSendingByConversation] = useState<Record<string, boolean>>({});
  const [localHistoryLoadedByConversation, setLocalHistoryLoadedByConversation] = useState<Record<string, boolean>>({});

  const localAbortRef = useRef<AbortController | null>(null);
  const autoFocusedLocalAgentRef = useRef(false);
  const localChatEndRef = useRef<HTMLDivElement>(null);

  const localSessions = summarizeLocalAgentSessions(memorySessions, integrations);
  const {
    sortedIntegrations,
    connectedIntegrations,
    selectedIntegration,
    selectedConversation,
    selectedHasConversation,
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

  const scrollLocalChatToBottom = useCallback(() => {
    localChatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(scrollLocalChatToBottom, [selectedConversationKey, selectedLocalMessages, scrollLocalChatToBottom]);

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

  const setSelectedIntegration = useCallback((
    integrationId: string,
    opts: { preserveSession?: boolean; sessionId?: string | null } = {},
  ) => {
    setSelectedIntegrationId(integrationId);
    if (integrationId === ADD_AGENT_TAB_ID) {
      setSelectedSessionId(null);
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
        fetchConnections().catch(() => ({ total: 0, direct: 0, relayed: 0 })),
      ]);
      const agents = (agentData.agents ?? []).filter((agent: AgentInfo) => agent.connectionStatus !== 'self');
      setPeerAgents(agents);
      setConnections({
        total: connData.total ?? 0,
        direct: connData.direct ?? 0,
        relayed: connData.relayed ?? 0,
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
      const sessionSummaries = summarizeLocalAgentSessions(memorySessions, items);
      const connected = [...items].sort(compareLocalAgentIntegrations).filter((item) => item.persistentChat);
      const selectedItem = items.find((item) => item.id === selectedIntegrationId) ?? null;
      const preserveSelected = selectedIntegrationId === ADD_AGENT_TAB_ID
        || (Boolean(selectedItem)
          && (selectedItem.persistentChat || hasLocalAgentConversation(
            selectedIntegrationId,
            selectedSessionId,
            localMessagesByConversation,
            sessionSummaries,
          )));
      if (!preserveSelected) {
        setSelectedIntegration(connected[0]?.id ?? ADD_AGENT_TAB_ID);
      }
      const preferred = connected[0];
      if (preferred && !autoFocusedLocalAgentRef.current && selectedIntegrationId !== ADD_AGENT_TAB_ID) {
        autoFocusedLocalAgentRef.current = true;
        setSelectedIntegration(preferred.id);
        setMode('agents');
      } else if (!preferred && !preserveSelected) {
        autoFocusedLocalAgentRef.current = false;
        setSelectedIntegration(ADD_AGENT_TAB_ID);
      }
    } catch {
      // Keep the last known integrations in place so transient refresh failures
      // do not collapse an attached agent chat surface back into the add-agent UI.
    }
  }, [localMessagesByConversation, memorySessions, selectedIntegrationId, selectedSessionId, setSelectedIntegration]);

  const loadLocalHistory = useCallback(async (integrationId: string, sessionId: string | null = null) => {
    const conversation = resolveLocalAgentConversation({ integrationId, sessionId });
    setLocalHistoryLoadedByConversation((prev) => ({
      ...prev,
      [conversation.stateKey]: false,
    }));
    try {
      const history = await fetchLocalAgentHistory(integrationId, 100, {
        sessionId: conversation.sessionId ?? undefined,
      });
      const loaded = history.map(mapHistoryMessage);
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

  useEffect(() => {
    const intervalId = setInterval(() => {
      loadSessions();
      refreshPeers();
    }, 15_000);
    return () => clearInterval(intervalId);
  }, [loadSessions, refreshPeers]);

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
      await loadLocalHistory(selectedIntegration.id, selectedConversation?.sessionId ?? null);
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
    selectedIntegration?.chatSupported,
    selectedIntegration?.id,
    selectedIntegration?.persistentChat,
  ]);

  const sendLocalMessage = useCallback(async () => {
    const integration = selectedIntegration;
    const conversation = selectedConversation;
    const text = localInput.trim();
    if (!integration?.chatSupported || !integration.chatReady || !text || localSending || !conversation) return;
    const integrationId = integration.id;
    const conversationKey = conversation.stateKey;
    const correlationId = crypto.randomUUID();

    const userId = `local:${conversationKey}:${correlationId}:user`;
    const assistantId = `local:${conversationKey}:${correlationId}:assistant`;
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    updateLocalMessages(conversationKey, (prev) => [
      ...prev,
      { id: userId, turnId: correlationId, role: 'user', content: text, ts: now },
      { id: assistantId, turnId: correlationId, role: 'assistant', content: '', ts: now, streaming: true },
    ]);
    setLocalInputForConversation(conversationKey, '');
    setLocalSendingForConversation(conversationKey, true);
    setConnectError(null);

    const controller = new AbortController();
    localAbortRef.current = controller;

    try {
      const result = await streamLocalAgentChat(integrationId, text, {
        correlationId,
        signal: controller.signal,
        sessionId: conversation.sessionId ?? undefined,
        onEvent: (event: LocalAgentStreamEvent) => {
          if (event.type === 'text_delta') {
            updateLocalMessages(conversationKey, (prev) =>
              prev.map((message) =>
                message.id === assistantId ? { ...message, content: message.content + event.delta } : message,
              ),
            );
          }
        },
      });

      updateLocalMessages(conversationKey, (prev) =>
        prev.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: result.text || message.content,
                streaming: false,
                ts: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              }
            : message,
        ),
      );
      loadSessions();
      if (stage === 0) advance();
    } catch (err: any) {
      updateLocalMessages(conversationKey, (prev) =>
        prev.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: err?.name === 'AbortError'
                  ? 'Request cancelled.'
                  : `Error: ${formatLocalAgentErrorMessage(integration, err)}`,
                streaming: false,
              }
            : message,
        ),
      );
      void refreshLocalIntegrations();
    } finally {
      setLocalSendingForConversation(conversationKey, false);
      localAbortRef.current = null;
    }
  }, [
    advance,
    loadSessions,
    localInput,
    localSending,
    refreshLocalIntegrations,
    selectedConversation,
    selectedIntegration,
    setLocalInputForConversation,
    setLocalSendingForConversation,
    stage,
    updateLocalMessages,
  ]);

  const connectIntegration = useCallback(async (integrationId: string) => {
    setConnectBusyId(integrationId);
    setConnectError(null);
    setConnectNotice(null);
    try {
      const result = await connectLocalAgentIntegration(integrationId);
      setIntegrations((prev) => upsertLocalAgentIntegrationState(prev, result.integration));
      await refreshLocalIntegrations();
      setSelectedIntegration(integrationId);
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
  }, [refreshLocalIntegrations, setSelectedIntegration]);

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

  const openSession = useCallback((session: LocalAgentSessionSummary) => {
    setSelectedIntegration(session.integrationId, { sessionId: session.sessionId });
    setMode('agents');
  }, [setSelectedIntegration]);

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
          selectedHasConversation={selectedHasConversation}
          onSelectIntegration={setSelectedIntegration}
          onConnectIntegration={connectIntegration}
          onDisconnectIntegration={disconnectIntegration}
          onRefreshIntegrations={refreshLocalIntegrations}
          connectBusyId={connectBusyId}
          connectNotice={connectNotice}
          connectError={connectError}
          localMessages={selectedLocalMessages}
          localHistoryLoaded={selectedLocalHistoryLoaded}
          localChatEndRef={localChatEndRef}
          localInput={localInput}
          onLocalInputChange={(value) => setLocalInputForConversation(selectedConversationKey, value)}
          onSendLocalMessage={sendLocalMessage}
          localSending={localSending}
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
