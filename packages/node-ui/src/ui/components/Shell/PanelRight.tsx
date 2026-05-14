import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useJourneyStore } from '../../stores/journey.js';
import { useProjectsStore, type ContextGraph } from '../../stores/projects.js';
import {
  importFile,
  type AgentIdentity,
  type ImportFileResult,
  type LocalAgentChatAttachmentImportResult,
  type LocalAgentChatAttachmentRef,
  type LocalAgentChatContextEntry,
  type LocalAgentIntegration,
  type LocalAgentHistoryMessage,
  type LocalAgentStreamEvent,
  type MemorySession,
  connectLocalAgentIntegration,
  disconnectLocalAgentIntegration,
  fetchAgents,
  fetchConnections,
  fetchCurrentAgent,
  getDefaultLocalAgentSessionId,
  fetchLocalAgentHistory,
  fetchLocalAgentIntegrations,
  refreshLocalAgentIntegration,
  streamLocalAgentChat,
} from '../../api.js';
import { api } from '../../api-wrapper.js';
import TextareaAutosize from 'react-textarea-autosize';
import { useDropzone } from 'react-dropzone';
import { ArrowUp, Ban, ChevronDown, MoreHorizontal, Paperclip, Upload, X } from 'lucide-react';
import { Select } from '../common/Select.js';

export interface LocalAgentMessage {
  id: string;
  uri?: string;
  turnId?: string;
  role: 'user' | 'assistant';
  content: string;
  ts?: string;
  streaming?: boolean;
  attachments?: LocalAgentChatAttachmentRef[];
}

type LocalAgentAttachmentStatus = 'queued' | 'uploading' | 'completed' | 'skipped' | 'error';

interface LocalAgentAttachmentDraft {
  id: string;
  file: File;
  contextGraphId: string;
  assertionName: string;
  status: LocalAgentAttachmentStatus;
  result?: ImportFileResult;
  error?: string;
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
const STATIC_DEFAULT_LOCAL_AGENT_HISTORY_INTEGRATIONS = ['openclaw'] as const;

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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileBadge(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['md', 'txt', 'csv', 'json', 'xml', 'yaml', 'yml'].includes(ext)) return 'TXT';
  if (['pdf'].includes(ext)) return 'PDF';
  if (['docx', 'doc'].includes(ext)) return 'DOC';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return 'IMG';
  if (['py', 'ts', 'js', 'tsx', 'jsx', 'java', 'go', 'rs', 'c', 'cpp'].includes(ext)) return 'CODE';
  return 'FILE';
}

function buildAttachmentSummary(attachments: LocalAgentChatAttachmentRef[]): string {
  if (attachments.length === 0) return '';
  const names = attachments.map((attachment) => attachment.fileName);
  if (names.length <= 2) {
    return `Attached ${names.join(' and ')}.`;
  }
  return `Attached ${names[0]} and ${names.length - 1} more files.`;
}

function isSendableAttachmentDraft(draft: LocalAgentAttachmentDraft): boolean {
  return draft.status === 'queued' || draft.status === 'completed' || draft.status === 'skipped';
}

function getProjectDisplayName(projects: ContextGraph[], projectId: string): string {
  return projects.find((project) => project.id === projectId)?.name ?? projectId;
}

function normalizeAttachmentFileName(file: File): string {
  return file.name.trim();
}

function draftToAttachmentRef(draft: LocalAgentAttachmentDraft): LocalAgentChatAttachmentRef | null {
  if (draft.status !== 'completed' || !draft.result) return null;
  const mdIntermediateHash = draft.result.extraction.mdIntermediateHash;
  const markdownHash = mdIntermediateHash
    ?? (draft.result.detectedContentType === 'text/markdown' ? draft.result.fileHash : undefined);
  return {
    id: draft.id,
    fileName: normalizeAttachmentFileName(draft.file),
    contextGraphId: draft.contextGraphId,
    assertionName: draft.assertionName,
    assertionUri: draft.result.assertionUri,
    fileHash: draft.result.fileHash,
    detectedContentType: draft.result.detectedContentType,
    rootEntity: draft.result.rootEntity,
    extractionStatus: 'completed',
    tripleCount: draft.result.extraction.tripleCount ?? draft.result.extraction.triplesWritten,
    ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
    ...(markdownHash ? { markdownHash, markdownForm: `urn:dkg:file:${markdownHash}` } : {}),
  };
}

function formatAttachmentImportContextValue(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildAttachmentImportResultRefs(
  drafts: LocalAgentAttachmentDraft[],
): { results: LocalAgentChatAttachmentImportResult[]; deliveredDraftIds: string[] } {
  const deliveredDraftIds: string[] = [];
  const results = drafts.flatMap((draft): LocalAgentChatAttachmentImportResult[] => {
    if (draft.status !== 'skipped' || !draft.result) return [];
    deliveredDraftIds.push(draft.id);
    const result = draft.result;
    const extraction = result.extraction;
    return [{
      id: draft.id,
      fileName: normalizeAttachmentFileName(draft.file),
      contextGraphId: draft.contextGraphId,
      assertionName: draft.assertionName,
      assertionUri: result.assertionUri,
      fileHash: result.fileHash,
      detectedContentType: result.detectedContentType,
      extractionStatus: 'skipped',
      pipelineUsed: extraction.pipelineUsed ?? null,
      tripleCount: extraction.tripleCount ?? extraction.triplesWritten ?? 0,
      ...(result.rootEntity ? { rootEntity: result.rootEntity } : {}),
      ...(extraction.mdIntermediateHash ? { mdIntermediateHash: extraction.mdIntermediateHash } : {}),
      ...(extraction.error ? { error: extraction.error } : {}),
    }];
  });

  return { results, deliveredDraftIds };
}

function buildAttachmentImportSummary(importResults: LocalAgentChatAttachmentImportResult[]): string {
  if (importResults.length === 0) return '';
  if (importResults.length === 1) {
    return `Attachment import result: ${formatAttachmentImportContextValue(importResults[0].fileName)}.`;
  }
  return `Attached ${importResults.length} document import results.`;
}

function buildAttachmentTurnSummary(
  attachments: LocalAgentChatAttachmentRef[],
  importResults: LocalAgentChatAttachmentImportResult[],
): string {
  const parts = [
    buildAttachmentSummary(attachments),
    buildAttachmentImportSummary(importResults),
  ]
    .filter((part) => part.length > 0)
    .map((part) => part.replace(/\.$/, ''));
  return parts.length ? `${parts.join('; ')}.` : '';
}

function buildChatContextEntries(
  projects: ContextGraph[],
  activeProjectId: string | null,
  currentAgent: AgentIdentity | null,
): LocalAgentChatContextEntry[] {
  const entries: LocalAgentChatContextEntry[] = [];
  if (activeProjectId) {
    const displayName = getProjectDisplayName(projects, activeProjectId);
    entries.push({
      key: 'target_context_graph',
      label: 'Target context graph',
      value: displayName === activeProjectId ? activeProjectId : `${displayName} (${activeProjectId})`,
    });
  }
  if (currentAgent?.agentAddress) {
    entries.push({
      key: 'current_agent_address',
      label: 'Current agent address',
      value: currentAgent.agentAddress,
    });
  }
  if (currentAgent?.agentDid) {
    entries.push({
      key: 'current_agent_did',
      label: 'Current agent DID',
      value: currentAgent.agentDid,
    });
  }
  if (currentAgent?.peerId) {
    entries.push({
      key: 'current_agent_peer_id',
      label: 'Current agent peer ID',
      value: currentAgent.peerId,
    });
  }
  return entries;
}

function mapHistoryMessage(message: LocalAgentHistoryMessage): LocalAgentMessage {
  const author = message.author.toLowerCase();
  return {
    id: message.uri || `local-history:${++localMessageId}`,
    uri: message.uri,
    turnId: message.turnId,
    role: author.includes('assistant') || author.includes('agent') ? 'assistant' : 'user',
    content: message.text || buildAttachmentSummary(message.attachmentRefs ?? []),
    ts: formatLocalTimestamp(message.ts),
    attachments: message.attachmentRefs,
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

export function normalizeMessageContent(content: string): string {
  const normalized = content.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
  return normalized
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/(?:\n[ \t]*)+$/, '');
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<React.Fragment key={`md-${key++}`}>{text.slice(lastIndex, match.index)}</React.Fragment>);
    }

    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={`md-${key++}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={`md-${key++}`}>{token.slice(1, -1)}</code>);
    } else {
      nodes.push(<React.Fragment key={`md-${key++}`}>{token}</React.Fragment>);
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push(<React.Fragment key={`md-${key++}`}>{text.slice(lastIndex)}</React.Fragment>);
  }

  return nodes;
}

function renderMessageContent(content: string): React.ReactNode {
  const normalized = normalizeMessageContent(content);
  const lines = normalized.split('\n');
  return lines.map((line, index) => (
    <React.Fragment key={`line-${index}`}>
      {renderInlineMarkdown(line)}
      {index < lines.length - 1 && <br />}
    </React.Fragment>
  ));
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

function bridgeStatusDotClass(integration: LocalAgentIntegration): string {
  if (integration.bridgeOnline) return 'connected';
  if (integration.status === 'connecting') return 'known';
  if (integration.status === 'degraded') return 'degraded';
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
  if (integration.status === 'degraded') {
    return `${integration.name} degraded`;
  }
  return `${integration.name} is unavailable`;
}

function AgentTabMenu(props: {
  integration: LocalAgentIntegration;
  statusLabel: string;
  statusDotClass: string;
  refreshBusy: boolean;
  canDisconnect: boolean;
  onRefresh: () => void;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const closeAndReturnFocus = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAndReturnFocus();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, closeAndReturnFocus]);

  // Focus first menuitem when popover opens (ARIA APG menu-button pattern).
  useEffect(() => {
    if (!open) return;
    const firstItem = popoverRef.current?.querySelector<HTMLButtonElement>(
      '.v10-agent-tab-menu-item:not(:disabled)',
    );
    firstItem?.focus();
  }, [open]);

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onPopoverKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      // Let tab close the menu so focus falls through naturally.
      setOpen(false);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(
      popoverRef.current?.querySelectorAll<HTMLButtonElement>(
        '.v10-agent-tab-menu-item:not(:disabled)',
      ) ?? [],
    );
    if (items.length === 0) return;
    const currentIndex = items.findIndex((el) => el === document.activeElement);
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = currentIndex === -1
      ? (delta === 1 ? 0 : items.length - 1)
      : (currentIndex + delta + items.length) % items.length;
    items[nextIndex]?.focus();
  };

  return (
    <div className="v10-agent-tab-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="v10-agent-tab-menu-trigger"
        aria-label={`More actions for ${props.integration.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`More actions for ${props.integration.name}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <MoreHorizontal aria-hidden="true" size={14} />
      </button>
      {open && (
        <div
          ref={popoverRef}
          className="v10-agent-tab-menu-popover"
          role="menu"
          onKeyDown={onPopoverKeyDown}
        >
          <div className="v10-agent-tab-menu-status" aria-hidden="true">
            <span className={`v10-agents-stat-dot ${props.statusDotClass}`} />
            <span>{props.statusLabel}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            className="v10-agent-tab-menu-item"
            disabled={props.refreshBusy}
            onClick={() => {
              closeAndReturnFocus();
              props.onRefresh();
            }}
          >
            {props.refreshBusy ? 'Refreshing…' : 'Refresh'}
          </button>
          {props.canDisconnect && (
            <button
              type="button"
              role="menuitem"
              className="v10-agent-tab-menu-item danger"
              onClick={() => {
                closeAndReturnFocus();
                props.onDisconnect();
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      )}
    </div>
  );
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

export function ConnectedAgentsTab(props: {
  integrations: LocalAgentIntegration[];
  selectedIntegrationId: string;
  selectedIntegration: LocalAgentIntegration | null;
  selectedSessionId: string | null;
  selectedHasConversation: boolean;
  selectedIntegrationHasAnyConversation: boolean;
  onSelectIntegration: (id: string, opts?: { preserveSession?: boolean; sessionId?: string | null }) => void;
  onConnectIntegration: (id: string) => void;
  onDisconnectIntegration: (id: string) => void;
  onRefreshIntegration: (id: string) => void;
  connectBusyId: string | null;
  refreshBusyId: string | null;
  connectNotice: string | null;
  connectError: string | null;
  localMessages: LocalAgentMessage[];
  localHistoryLoaded: boolean;
  localChatEndRef: React.RefObject<HTMLDivElement | null>;
  localInput: string;
  onLocalInputChange: (value: string) => void;
  onSendLocalMessage: () => void;
  localSending: boolean;
  activeProjectId: string | null;
  availableProjects: ContextGraph[];
  projectsLoading: boolean;
  onSelectProject: (projectId: string) => void;
  attachments: LocalAgentAttachmentDraft[];
  onAddAttachments: (files: FileList | File[]) => void;
  onRemoveAttachment: (id: string) => void;
}) {
  const {
    integrations,
    selectedIntegrationId,
    selectedIntegration,
    selectedSessionId,
    selectedHasConversation,
    selectedIntegrationHasAnyConversation,
    onSelectIntegration,
    onConnectIntegration,
    onDisconnectIntegration,
    onRefreshIntegration,
    connectBusyId,
    refreshBusyId,
    connectNotice,
    connectError,
    localMessages,
    localHistoryLoaded,
    localChatEndRef,
    localInput,
    onLocalInputChange,
    onSendLocalMessage,
    localSending,
    activeProjectId,
    availableProjects,
    projectsLoading,
    onSelectProject,
    attachments,
    onAddAttachments,
    onRemoveAttachment,
  } = props;
  const selectedAttachmentDrafts = attachments;
  const hasSendableAttachmentDrafts = selectedAttachmentDrafts.some(isSendableAttachmentDraft);
  const attachmentTargetIds = [...new Set(selectedAttachmentDrafts.map((attachment) => attachment.contextGraphId))];
  // Drafts pin to the contextGraphId they were attached under. If the user
  // later switches `activeProjectId`, those drafts are still routed to
  // their original target — the warning surfaces that divergence. Always
  // show it whenever any draft's target differs from the active project
  // (single-target mismatch was previously dropped in iteration-1 polish,
  // which Codex flagged as a silent mis-route).
  const hasMismatchedAttachmentTargets =
    selectedAttachmentDrafts.length > 0 &&
    selectedAttachmentDrafts.some((a) => a.contextGraphId !== activeProjectId);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

  // Drop-zone gating: three different reasons the dropzone refuses files.
  // Each surfaces a different recovery copy in the refuse-state overlay so
  // the user can act, rather than being told to "choose a project" when the
  // real cause is e.g. an in-flight send.
  const dropDisabledReason: 'unsupported' | 'noProject' | 'sending' | null =
    !props.selectedIntegration?.chatAttachments
      ? 'unsupported'
      : !props.activeProjectId
        ? 'noProject'
        : props.localSending
          ? 'sending'
          : null;
  const attachmentsEnabled = dropDisabledReason === null;
  const handleFilesDrop = useCallback((files: File[]) => {
    if (!attachmentsEnabled) return;
    onAddAttachments(files);
  }, [attachmentsEnabled, onAddAttachments]);
  const dropzone = useDropzone({
    onDrop: handleFilesDrop,
    noClick: true,
    noKeyboard: true,
  });

  const sortedIntegrations = [...integrations].sort(compareLocalAgentIntegrations);
  const connectedAgents = sortedIntegrations.filter((item) => item.persistentChat);
  const addableIntegrations = sortedIntegrations.filter((item) => !item.persistentChat);
  const selected = selectedIntegration;
  const {
    showingSessionHistory,
    showingStoredSessions,
    visibleAgentTabs,
    showAddFlow,
    shouldShowConversationLoader,
  } = resolveConnectedAgentsTabState({
    connectedAgents,
    selectedIntegration,
    selectedIntegrationId,
    selectedHasConversation,
    selectedIntegrationHasAnyConversation,
    localHistoryLoaded,
    localMessagesCount: localMessages.length,
  });
  const inputDisabled = localSending || !selected?.chatReady;

  return (
    <div className="v10-agents-tab">
      <div className="v10-agent-subtabs" role="tablist" aria-label="Integrated agents">
        {visibleAgentTabs.map((integration) => {
          const isActive = selected?.id === integration.id && !showAddFlow;
          return (
            <div
              key={integration.id}
              className={`v10-agent-subtab-group ${isActive ? 'active' : ''}`}
            >
              <button
                className={`v10-agent-subtab ${isActive ? 'active' : ''}`}
                onClick={() => onSelectIntegration(integration.id, {
                  preserveSession: shouldPreserveSessionForIntegrationSelection({
                    integrationId: integration.id,
                    selectedSessionId,
                    integrations,
                  }),
                  sessionId: integration.defaultSessionId,
                })}
                role="tab"
                aria-selected={isActive}
              >
                <span className={`v10-agents-stat-dot ${bridgeStatusDotClass(integration)}`} />
                <span>{integration.name}</span>
              </button>
              {isActive && (
                <AgentTabMenu
                  integration={integration}
                  statusLabel={localAgentToolbarLabel(integration, showingSessionHistory)}
                  statusDotClass={bridgeStatusDotClass(integration)}
                  refreshBusy={refreshBusyId === integration.id}
                  canDisconnect={integration.persistentChat}
                  onRefresh={() => onRefreshIntegration(integration.id)}
                  onDisconnect={() => onDisconnectIntegration(integration.id)}
                />
              )}
            </div>
          );
        })}
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
                {integration.error && (
                  <div
                    className="v10-local-agent-warning offline"
                    role="status"
                    data-testid={`local-agent-warning-${integration.id}`}
                  >
                    {integration.error}
                  </div>
                )}
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
                  <>
                    <p className="v10-local-agent-copy">
                      Connect a local Hermes profile through the node, then this tab becomes the persistent chat surface for that profile.
                    </p>
                    {integration.connectSupported && (
                      <div className="v10-local-agent-actions">
                        <button
                          className="v10-agent-send-btn secondary"
                          onClick={() => onConnectIntegration(integration.id)}
                          disabled={connectBusyId === integration.id}
                        >
                          {connectBusyId === integration.id ? 'Connecting...' : 'Connect Hermes'}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        selected && (
          <div className="v10-local-agent-chat-shell">
            {connectNotice && <div className="v10-local-agent-notice">{connectNotice}</div>}
            {connectError && <div className="v10-local-agent-error">{connectError}</div>}

            {!selected.chatReady && (
              <div className={`v10-local-agent-warning ${selected.status === 'connecting' ? 'connecting' : 'offline'}`}>
                {showingSessionHistory
                  ? `${selected.name} is not currently attached to this node. Session history remains available here; reconnect from the + tab when you want live chat again.`
                  : selected.status === 'connecting'
                  ? `${selected.name} is still finishing setup. This chat tab stays in place and will go live automatically when the connection is ready.`
                  : selected.status === 'degraded'
                  ? selected.detail
                  : showingStoredSessions
                  ? `${selected.name} has saved sessions on this node. Open one from Sessions or reconnect from the + tab to resume live chat here.`
                  : `${selected.name} is temporarily unavailable. Refresh after it recovers to resume chatting here.`}
              </div>
            )}

            <div
              {...dropzone.getRootProps({
                className: 'v10-chat-messages v10-local-agent-messages',
              })}
            >
              <input {...dropzone.getInputProps()} />
              {dropzone.isDragActive && (
                <div
                  className={`v10-drop-overlay active ${attachmentsEnabled ? 'accept' : 'refuse'}`}
                  role="status"
                  aria-live="polite"
                >
                  {attachmentsEnabled ? (
                    <Upload className="v10-drop-overlay-icon" size={20} aria-hidden="true" />
                  ) : (
                    <Ban className="v10-drop-overlay-icon" size={20} aria-hidden="true" />
                  )}
                  <div className="v10-drop-overlay-title">
                    {attachmentsEnabled
                      ? `Drop files to attach to ${getProjectDisplayName(availableProjects, activeProjectId!)}`
                      : dropDisabledReason === 'sending'
                        ? 'Wait for the current send to finish.'
                        : dropDisabledReason === 'unsupported'
                          ? `${selected.name} doesn't accept file attachments.`
                          : 'Choose a project before attaching files.'}
                  </div>
                  <div className="v10-drop-overlay-hint">
                    {attachmentsEnabled
                      ? 'Release to upload to this conversation.'
                      : dropDisabledReason === 'sending'
                        ? 'Drop will be accepted once the agent reply lands.'
                        : dropDisabledReason === 'unsupported'
                          ? 'Try a different agent that supports attachments.'
                          : 'Use the picker below the composer.'}
                  </div>
                </div>
              )}
              {shouldShowConversationLoader && (
                <div className="v10-agent-empty-state">
                  Loading the latest conversation from DKG memory...
                </div>
              )}
              {(!shouldShowConversationLoader && localMessages.length === 0) && (() => {
                const empty = showingSessionHistory
                  ? {
                      title: 'No turns in this session yet.',
                      hint: `Reconnect ${selected.name} from the + tab to start a new live thread.`,
                    }
                  : showingStoredSessions
                  ? {
                      title: `${selected.name} has saved sessions.`,
                      hint: 'Open one from Sessions, or reconnect from + to start fresh.',
                    }
                  : selected.chatReady
                  ? {
                      title: `Start a conversation with ${selected.name}.`,
                      hint: 'Try: "What can you help me with?"',
                    }
                  : {
                      title: `${selected.name} is offline.`,
                      hint: 'Conversation history stays here while the bridge reconnects.',
                    };
                return (
                  <div className="v10-agent-empty-state">
                    <div className="v10-agent-empty-state-title">{empty.title}</div>
                    <div className="v10-agent-empty-state-hint">{empty.hint}</div>
                  </div>
                );
              })()}
              {localMessages.map((message) => (
                <div key={message.id} className={`v10-chat-msg ${message.role}`}>
                  <div className={`v10-chat-bubble ${message.role}`}>
                    {renderMessageContent(message.content)}
                    {message.streaming && <span className="v10-chat-cursor" />}
                  </div>
                  {message.attachments && message.attachments.length > 0 && (
                    <div className="v10-local-agent-attachment-row" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                      {message.attachments.map((attachment) => (
                        <span
                          key={attachment.id ?? attachment.assertionUri ?? attachment.fileHash}
                          className="v10-local-agent-attachment-chip"
                          style={{
                            padding: '2px 8px',
                            borderRadius: 999,
                            background: 'var(--panel-elevated)',
                            fontSize: 11,
                          }}
                        >
                          {attachment.fileName}
                        </span>
                      ))}
                    </div>
                  )}
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
                {selectedAttachmentDrafts.length > 0 && (
                  <div className="v10-attachment-chips" role="list" aria-label="Attached files">
                    {selectedAttachmentDrafts.map((attachment) => {
                      const triples = attachment.result?.extraction.tripleCount ?? attachment.result?.extraction.triplesWritten;
                      const statusLabel = attachment.status === 'queued'
                        ? 'Queued'
                        : attachment.status === 'uploading'
                          ? 'Importing…'
                          : attachment.status === 'completed'
                            ? triples != null
                              ? `Ready · ${triples} triples`
                              : 'Ready'
                            : attachment.status === 'skipped'
                              ? 'Stored only'
                              : attachment.error ?? 'Failed';
                      return (
                        <div
                          key={attachment.id}
                          className="v10-attachment-chip"
                          data-status={attachment.status}
                          role="listitem"
                        >
                          <div className="v10-attachment-chip-badge" aria-hidden="true">
                            {fileBadge(attachment.file.name)}
                          </div>
                          <div className="v10-attachment-chip-body">
                            <div className="v10-attachment-chip-name" title={attachment.file.name}>
                              {attachment.file.name}
                            </div>
                            <div className="v10-attachment-chip-meta">
                              <span>{formatFileSize(attachment.file.size)}</span>
                              <span aria-hidden="true">·</span>
                              <span className="v10-attachment-chip-status">{statusLabel}</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="v10-attachment-chip-remove"
                            onClick={() => onRemoveAttachment(attachment.id)}
                            disabled={localSending}
                            aria-label={`Remove ${attachment.file.name}`}
                            title="Remove attachment"
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {hasMismatchedAttachmentTargets && (
                  <div className="v10-local-agent-copy" style={{ margin: 0, color: 'var(--text-tertiary)' }}>
                    {attachmentTargetIds.length > 1
                      ? 'Queued files keep their stored targets and may span multiple projects.'
                      : `Queued files keep their stored target (${getProjectDisplayName(availableProjects, attachmentTargetIds[0]!)}), not the active project.`}
                  </div>
                )}

                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    if (e.target.files) {
                      onAddAttachments(e.target.files);
                      e.target.value = '';
                    }
                  }}
                />

                <div className="v10-local-agent-composer-row">
                  <div className="v10-local-agent-composer-shell">
                    <button
                      type="button"
                      className="v10-composer-attach"
                      onClick={() => attachmentInputRef.current?.click()}
                      // Single source of truth for "can attach right now": the
                      // shared `dropDisabledReason` that the drop overlay also
                      // uses, so the button's disabled state and the dropzone
                      // stay in lockstep. The tooltip mirrors the same reason
                      // chain instead of advertising a generic "Attach files"
                      // in the disabled states.
                      disabled={!attachmentsEnabled}
                      title={
                        attachmentsEnabled
                          ? 'Attach files'
                          : dropDisabledReason === 'noProject'
                            ? 'Choose a project to attach files'
                            : dropDisabledReason === 'sending'
                              ? 'Wait for the current message to send'
                              : 'This agent does not support attachments'
                      }
                      aria-label="Attach files"
                    >
                      <Paperclip size={14} aria-hidden="true" />
                    </button>
                    <TextareaAutosize
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
                        // IME composition: don't trap Enter while composing CJK/JP/KR.
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                          e.preventDefault();
                          // Gate Enter with the same sendability check the
                          // send button uses, otherwise an empty-input
                          // Enter or an Enter while inputDisabled would
                          // fire onSendLocalMessage even though the
                          // surfaced affordance (the button) is disabled.
                          if (!inputDisabled && (localInput.trim() || hasSendableAttachmentDrafts)) {
                            onSendLocalMessage();
                          }
                          return;
                        }
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                          // Force send even with empty textarea if attachments queued.
                          e.preventDefault();
                          if (!inputDisabled && (hasSendableAttachmentDrafts || localInput.trim())) {
                            onSendLocalMessage();
                          }
                          return;
                        }
                        if (e.key === 'Escape' && localInput.length > 0) {
                          e.preventDefault();
                          onLocalInputChange('');
                        }
                      }}
                      disabled={inputDisabled}
                      minRows={1}
                      maxRows={8}
                    />
                    <button
                      type="button"
                      className="v10-agent-send-btn v10-local-agent-inline-send"
                      onClick={onSendLocalMessage}
                      disabled={inputDisabled || (!localInput.trim() && !hasSendableAttachmentDrafts)}
                      aria-label="Send message"
                      title="Send message"
                    >
                      <ArrowUp size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <div className="v10-composer-toolbar">
                  <div className="v10-composer-target">
                    <Select
                      className="v10-local-agent-target-select"
                      value={activeProjectId ?? ''}
                      onChange={onSelectProject}
                      options={[
                        // The "No project (clear selection)" row only renders
                        // once a real project is active. Otherwise its
                        // `value: ''` would match the empty trigger value
                        // and the picker would show "No project (clear
                        // selection)" as a fake selection instead of the
                        // intended "Choose a project" placeholder.
                        ...(activeProjectId
                          ? [{ value: '', label: 'No project (clear selection)' }]
                          : []),
                        ...availableProjects.map((project) => ({ value: project.id, label: project.name })),
                      ]}
                      placeholder={projectsLoading ? 'Loading projects…' : 'Choose a project'}
                      // Disable while loading. When no project is active and
                      // the list is empty there's nothing to pick yet, so
                      // disable then too — once a project is active the
                      // "No project (clear selection)" row is always there.
                      disabled={projectsLoading || (!activeProjectId && availableProjects.length === 0)}
                      ariaLabel="Active project"
                    />
                  </div>
                </div>
                {!activeProjectId && (
                  <div className="v10-local-agent-copy" style={{ margin: 0, color: 'var(--text-tertiary)' }}>
                    Choose a project to attach files.
                  </div>
                )}
              </div>
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
          Sessions track DKG-persisted conversations for your integrated agents.
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
  const [currentAgent, setCurrentAgent] = useState<AgentIdentity | null>(null);

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

  const localAbortRef = useRef<AbortController | null>(null);
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

  // Mount-time hydrate stable local-agent sessions so chat history paints
  // before bridge probes complete (issue #255).
  useEffect(() => {
    for (const integrationId of STATIC_DEFAULT_LOCAL_AGENT_HISTORY_INTEGRATIONS) {
      void loadLocalHistory(integrationId, getDefaultLocalAgentSessionId(integrationId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetchCurrentAgent().then(setCurrentAgent).catch(() => {});
  }, []);

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

    try {
      const processedDrafts = await prepareAttachmentDraftsForSend(conversationKey, drafts);
      const attachments = processedDrafts
        .map((draft) => draftToAttachmentRef(draft))
        .filter((item): item is LocalAgentChatAttachmentRef => item != null);
      const importContext = buildAttachmentImportResultRefs(processedDrafts);
      if (!text && attachments.length === 0 && importContext.results.length === 0) {
        return;
      }

      const correlationId = crypto.randomUUID();
      const importSummary = buildAttachmentImportSummary(importContext.results);
      const textWithImportSummary = [text, importSummary].filter((part) => part.length > 0).join('\n\n');
      const messageText = text
        ? textWithImportSummary
        : buildAttachmentTurnSummary(attachments, importContext.results);
      const outboundText = text ? textWithImportSummary : '';
      const attachmentIds = attachments
        .map((attachment) => attachment.id)
        .filter((attachmentId): attachmentId is string => typeof attachmentId === 'string' && attachmentId.length > 0);
      const deliveredAttachmentIds = [...attachmentIds, ...importContext.deliveredDraftIds];
      const userId = `local:${conversationKey}:${correlationId}:user`;
      assistantId = `local:${conversationKey}:${correlationId}:assistant`;
      const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      updateLocalMessages(conversationKey, (prev) => [
        ...prev,
        { id: userId, turnId: correlationId, role: 'user', content: messageText, ts: now, attachments },
        { id: assistantId, turnId: correlationId, role: 'assistant', content: '', ts: now, streaming: true },
      ]);
      setLocalInputForConversation(conversationKey, '');

      controller = new AbortController();
      localAbortRef.current = controller;
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
            updateLocalMessages(conversationKey, (prev) =>
              prev.map((message) =>
                message.id === assistantId ? { ...message, content: message.content + event.delta } : message,
              ),
            );
          }
        },
      });

      updateLocalMessages(conversationKey, (prev) =>
        adoptLocalAgentTurnId(prev, correlationId, result.turnId).map((message) =>
          message.id === assistantId
            ? {
                ...message,
                content: result.text || message.content,
                turnId: result.turnId?.trim() || message.turnId,
                streaming: false,
                ts: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              }
            : message,
        ),
      );
      if (deliveredAttachmentIds.length > 0) {
        clearCompletedAttachmentsForConversation(conversationKey, deliveredAttachmentIds);
      }
      loadSessions();
      if (stage === 0) advance();
    } catch (err: any) {
      if (assistantId) {
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
      }
      void refreshLocalIntegrations();
    } finally {
      setLocalSendingForConversation(conversationKey, false);
      localAbortRef.current = null;
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
        const loaded = historyOutcome.value.map(mapHistoryMessage);
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
          localSending={localSending}
          activeProjectId={activeProjectId}
          availableProjects={availableProjects}
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
