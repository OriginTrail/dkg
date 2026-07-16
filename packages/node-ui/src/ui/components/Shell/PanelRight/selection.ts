import type { LocalAgentIntegration, MemorySession } from '../../../api.js';
import { getDefaultLocalAgentSessionId } from '../../../api.js';
import { ADD_AGENT_TAB_ID } from './constants.js';
import type { LocalAgentMessage, LocalAgentSessionSummary } from './types.js';

export function getLocalAgentConversationStateKey(
  integrationId: string,
  sessionId: string | null,
): string {
  return sessionId?.trim() || `integration:${integrationId}`;
}

export function resolveLocalAgentConversation(args: {
  integrationId: string;
  sessionId: string | null;
  defaultSessionId?: string | null;
}): { integrationId: string; sessionId: string | null; stateKey: string } {
  const resolvedSessionId = args.sessionId
    ?? args.defaultSessionId
    ?? getDefaultLocalAgentSessionId(args.integrationId);
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

export function shouldPreserveSessionForIntegrationSelection(args: {
  integrationId: string;
  selectedSessionId: string | null;
  integrations: LocalAgentIntegration[];
}): boolean {
  if (args.selectedSessionId == null) return false;
  const integration = args.integrations.find((item) => item.id === args.integrationId);
  if (integrationIdFromSessionId(args.selectedSessionId, args.integrations)?.id !== args.integrationId) {
    return false;
  }
  if (
    integration?.defaultSessionId
    && args.selectedSessionId !== integration.defaultSessionId
    && isGeneratedDefaultLocalAgentSession(args.integrationId, args.selectedSessionId)
  ) {
    return false;
  }
  return true;
}

export function shouldPreserveSessionOnReconnect(args: {
  integrationId: string;
  selectedSessionId: string | null;
  integrations: LocalAgentIntegration[];
}): boolean {
  return shouldPreserveSessionForIntegrationSelection(args);
}

function isGeneratedDefaultLocalAgentSession(integrationId: string, sessionId: string): boolean {
  return sessionId === `${integrationId}:dkg-ui`
    || sessionId.startsWith(`${integrationId}:dkg-ui:profile-`)
    || sessionId.startsWith(`${integrationId}:dkg-ui:home-`)
    || sessionId.startsWith(`${integrationId}:dkg-ui:transport-`);
}

export function summarizeLocalAgentSessions(
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
  defaultSessionId?: string | null,
): boolean {
  const conversation = resolveLocalAgentConversation({
    integrationId,
    sessionId: selectedSessionId,
    defaultSessionId,
  });
  return (localMessagesByConversation[conversation.stateKey]?.length ?? 0) > 0
    || (conversation.sessionId
      ? sessions.some((session) => session.sessionId === conversation.sessionId)
      : false);
}

function hasAnyLocalAgentConversation(
  integrationId: string,
  localMessagesByConversation: Record<string, LocalAgentMessage[]>,
  sessions: LocalAgentSessionSummary[],
): boolean {
  const integrationStateKey = getLocalAgentConversationStateKey(integrationId, null);
  return Object.entries(localMessagesByConversation).some(([stateKey, messages]) =>
    messages.length > 0
      && (stateKey === integrationStateKey || stateKey.startsWith(`${integrationId}:`)))
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
      defaultSessionId: selectedIntegration.defaultSessionId,
    })
    : null;
  const selectedHasConversation = selectedIntegration
    ? hasLocalAgentConversation(
      selectedIntegration.id,
      args.selectedSessionId,
      args.localMessagesByConversation,
      args.sessions,
      selectedIntegration.defaultSessionId,
    )
    : false;
  const selectedIntegrationHasAnyConversation = selectedIntegration
    ? hasAnyLocalAgentConversation(
      selectedIntegration.id,
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
    selectedIntegrationHasAnyConversation,
  };
}

export function resolveConnectedAgentsTabState(args: {
  connectedAgents: LocalAgentIntegration[];
  selectedIntegration: LocalAgentIntegration | null;
  selectedIntegrationId: string;
  selectedHasConversation: boolean;
  selectedIntegrationHasAnyConversation: boolean;
  localHistoryLoaded: boolean;
  localMessagesCount: number;
}) {
  const selected = args.selectedIntegration;
  const showingSessionHistory = Boolean(selected && !selected.persistentChat && args.selectedHasConversation);
  const showingStoredSessions = Boolean(
    selected && !selected.persistentChat && args.selectedIntegrationHasAnyConversation,
  );
  const visibleAgentTabs = showingStoredSessions
    ? [selected!, ...args.connectedAgents.filter((item) => item.id !== selected!.id)]
    : args.connectedAgents;
  const showAddFlow = args.selectedIntegrationId === ADD_AGENT_TAB_ID
    || (!selected && args.connectedAgents.length === 0)
    || Boolean(selected && !selected.persistentChat && !args.selectedIntegrationHasAnyConversation);
  const shouldShowConversationLoader = !args.localHistoryLoaded
    && args.localMessagesCount === 0
    && Boolean(selected?.persistentChat || args.selectedHasConversation);

  return {
    showingSessionHistory,
    showingStoredSessions,
    visibleAgentTabs,
    showAddFlow,
    shouldShowConversationLoader,
  };
}

export function compareLocalAgentIntegrations(a: LocalAgentIntegration, b: LocalAgentIntegration): number {
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

export function shouldPreserveSelectedLocalAgentTab(args: {
  selectedIntegrationId: string;
  selectedItem: LocalAgentIntegration | null;
  selectedSessionId: string | null;
  localMessagesByConversation: Record<string, LocalAgentMessage[]>;
  sessionSummaries: LocalAgentSessionSummary[];
}): boolean {
  const selectedItem = args.selectedItem;
  return args.selectedIntegrationId === ADD_AGENT_TAB_ID
    || (selectedItem != null
      && (selectedItem.persistentChat
        || hasLocalAgentConversation(
          args.selectedIntegrationId,
          args.selectedSessionId,
          args.localMessagesByConversation,
          args.sessionSummaries,
          selectedItem.defaultSessionId,
        )
        || hasAnyLocalAgentConversation(
          args.selectedIntegrationId,
          args.localMessagesByConversation,
          args.sessionSummaries,
        )));
}

