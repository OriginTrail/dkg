import React, { useCallback, useEffect, useRef, useState } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { useDropzone } from 'react-dropzone';
import { ArrowDown, ArrowUp, Ban, Folder, Loader2, Paperclip, Square, Upload, X } from 'lucide-react';
import type { ContextGraph } from '../../../stores/projects.js';
import type { LocalAgentIntegration } from '../../../api.js';
import { Select } from '../../common/Select.js';
import { ADD_AGENT_TAB_ID, OPENCLAW_DOCS_URL, OPENCLAW_RELEASE_URL } from './constants.js';
import { AgentTabMenu, bridgeStatusDotClass, localAgentToolbarLabel } from './AgentTabMenu.js';
import {
  fileBadge,
  formatFileSize,
  getProjectDisplayName,
} from './format.js';
import { isSendableAttachmentDraft } from './attachments.js';
import { renderMessageContent } from './messages.js';
import {
  compareLocalAgentIntegrations,
  resolveConnectedAgentsTabState,
  shouldPreserveSessionForIntegrationSelection,
} from './selection.js';
import type { LocalAgentAttachmentDraft, LocalAgentMessage } from './types.js';
import { agentLogoDataUri } from './agentLogos.js';

/**
 * The agent's own mark, drawn as a mask so it inherits the panel's text colour
 * in both themes. Purely decorative — the agent name sits right next to it, so
 * it is hidden from assistive tech rather than duplicating that name.
 */
function AgentLogo({ integrationId }: { integrationId: string }): React.ReactElement | null {
  const uri = agentLogoDataUri(integrationId);
  if (!uri) return null;
  return (
    <span
      className="v10-local-agent-logo"
      aria-hidden="true"
      data-agent-logo={integrationId}
      style={{ maskImage: `url("${uri}")`, WebkitMaskImage: `url("${uri}")` }}
    />
  );
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
  /** Aborts the active stream when the send button is in stop-icon mode. */
  onStopLocalStream: () => void;
  localSending: boolean;
  activeProjectId: string | null;
  availableProjects: ContextGraph[];
  /** Membership-filtered subset for the project picker (see container).
   *  Optional: defaults to the full `availableProjects` so any renderer
   *  that doesn't supply it keeps the pre-PR5 behaviour. */
  selectableProjects?: ContextGraph[];
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
    onStopLocalStream,
    localSending,
    activeProjectId,
    availableProjects,
    projectsLoading,
    onSelectProject,
    attachments,
    onAddAttachments,
    onRemoveAttachment,
  } = props;
  // Defaults to the full list when a renderer doesn't supply the
  // membership-filtered subset (the real container always does).
  const selectableProjects = props.selectableProjects ?? availableProjects;
  const selectedAttachmentDrafts = attachments;
  const hasSendableAttachmentDrafts = selectedAttachmentDrafts.some(isSendableAttachmentDraft);
  const attachmentTargetIds = [...new Set(selectedAttachmentDrafts.map((attachment) => attachment.contextGraphId))];
  // Send-button state machine: idle / uploading / streaming.
  //   - uploading: at least one attachment draft is mid-upload — show
  //     a spinner so the user knows the click is in progress (no
  //     interaction until the upload settles).
  //   - streaming: an assistant bubble is still streaming text — show
  //     a stop-square icon and rebind the click to `onStopLocalStream`
  //     so the user can abort the in-flight reply.
  //   - idle: default `ArrowUp` send icon, normal send semantics.
  // The visible-affordance contract from PR2's CEdrv still applies: the
  // disabled state mirrors the keyboard-Enter gate.
  const isUploadingAttachments = selectedAttachmentDrafts.some((a) => a.status === 'uploading');
  const isStreaming = localMessages.some((m) => m.streaming);
  const sendButtonMode: 'idle' | 'uploading' | 'streaming' = isStreaming
    ? 'streaming'
    : isUploadingAttachments
      ? 'uploading'
      : 'idle';
  // `canSend` is computed later (line ~1100) once `inputDisabled` is
  // defined; the send-button JSX and the Enter / Cmd+Enter handlers
  // both consult it.
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
  const messagesRegionRef = useRef<HTMLDivElement>(null);
  // Mirror of `messagesRegionRef` as state so observer effects can re-run
  // when the region actually mounts. Necessary because the messages
  // region is conditionally rendered (loader / add-flow / chat shell) —
  // a one-shot useEffect at component mount sees `ref.current === null`
  // when the panel starts in any non-chat state, and never re-attaches
  // after the chat shell appears. Codex CGpfC. The callback ref below
  // bridges both consumers.
  const [messagesRegionEl, setMessagesRegionEl] = useState<HTMLDivElement | null>(null);
  const setMessagesRegion = useCallback((el: HTMLDivElement | null) => {
    messagesRegionRef.current = el;
    setMessagesRegionEl(el);
  }, []);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const onMessagesScroll = useCallback(() => {
    const el = messagesRegionRef.current;
    if (!el) return;
    // ~40px slack so the button doesn't flicker at the exact bottom edge.
    const offFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollToBottom(offFromBottom > 40);
  }, []);

  const scrollMessagesToBottom = useCallback(() => {
    const el = messagesRegionRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  // Recompute the scroll-pill state whenever the active conversation or its
  // message list changes. Without this, switching to a conversation with a
  // shorter history (or whose latest message just landed via auto-scroll)
  // leaves the pill stuck visible from the previous thread until the user
  // scrolls again. A rAF lets the layout settle after React commits.
  useEffect(() => {
    const el = messagesRegionRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      const off = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollToBottom(off > 40);
    });
    return () => cancelAnimationFrame(raf);
  }, [selectedIntegrationId, selectedSessionId, localMessages.length]);

  // Length-based recompute above misses the streaming case: the assistant's
  // last message grows in place (text appended to the same array entry),
  // so `localMessages.length` is unchanged. Watch the messages region's
  // subtree directly — any DOM mutation (streamed text chunk, new bubble,
  // markdown re-render, image load resizing) re-evaluates whether the
  // pill should show. MutationObserver beats ResizeObserver here because
  // (a) the scroll container has a fixed flex height (ResizeObserver
  // doesn't fire on scrollHeight changes alone) and (b) it's stable
  // across content-root transitions — earlier code captured
  // `firstElementChild` once at mount, which broke when the tab
  // initially rendered a loader/empty state and then transitioned to
  // streaming a real conversation. The effect re-runs whenever the
  // messages region mounts / unmounts (panel may start in add-flow or
  // empty state and only render the scroll container later) — Codex
  // CGpfC.
  useEffect(() => {
    if (!messagesRegionEl || typeof MutationObserver === 'undefined') return;
    const recompute = () => {
      const off = messagesRegionEl.scrollHeight - messagesRegionEl.scrollTop - messagesRegionEl.clientHeight;
      setShowScrollToBottom(off > 40);
    };
    // Initial recompute when the region mounts — without this, switching
    // from add-flow/loader to an already-populated chat leaves the pill
    // stuck on its prior `false` until the next mutation or manual
    // scroll fires (Codex CHBiH).
    recompute();
    const mo = new MutationObserver(recompute);
    mo.observe(messagesRegionEl, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [messagesRegionEl]);

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
  // Single source of truth for "is the user allowed to fire a send right
  // now". Both the button click AND the keyboard Enter / Cmd+Enter
  // handlers gate on this — earlier the button correctly disabled while
  // a draft was `uploading`, but the Enter handler did not, so the user
  // could submit a turn mid-upload. `prepareAttachmentDraftsForSend`
  // treats `uploading` drafts as sendable work, which would either start
  // a second import for the same file or push the turn before the first
  // upload finished. Codex CIlgu.
  const canSend =
    !inputDisabled
    && !isUploadingAttachments
    && (localInput.trim() !== '' || hasSendableAttachmentDrafts);

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
                <AgentLogo integrationId={integration.id} />
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
                    <div className="v10-local-agent-title">
                      <AgentLogo integrationId={integration.id} />
                      {integration.name}
                    </div>
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
                {integration.id === 'prime-agent' && (
                  <>
                    <p className="v10-local-agent-copy">
                      Connect a local Prime Agent through the node, then this tab becomes the persistent chat surface for it. Unlike the other agents, Prime Agent publishes a bridge per live session, and the node talks to the most recently active one.
                    </p>
                    {/*
                      Sessions are ephemeral by nature, so "none live" is normal
                      rather than broken. Say that plainly instead of showing an
                      error state the operator cannot act on.
                    */}
                    {typeof integration.sessionCount === 'number' && (
                      <p
                        className="v10-local-agent-copy"
                        data-testid={`local-agent-sessions-${integration.id}`}
                      >
                        {integration.sessionCount === 0
                          ? 'No live session. Start a Prime Agent session, then refresh — the extension publishes its bridge on session start.'
                          : integration.sessionCount === 1
                          ? '1 live session.'
                          : `${integration.sessionCount} live sessions — the most recently active one is used.`}
                      </p>
                    )}
                    {integration.connectSupported && (
                      <div className="v10-local-agent-actions">
                        <button
                          className="v10-agent-send-btn secondary"
                          onClick={() => onConnectIntegration(integration.id)}
                          disabled={connectBusyId === integration.id}
                        >
                          {connectBusyId === integration.id ? 'Connecting...' : 'Connect Prime Agent'}
                        </button>
                      </div>
                    )}
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
          <div {...dropzone.getRootProps({ className: 'v10-local-agent-chat-shell' })}>
            <input {...dropzone.getInputProps()} />
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

            {dropzone.isDragActive && (
              <div
                className={`v10-drop-overlay active ${attachmentsEnabled ? 'accept' : 'refuse'}`}
                role="status"
                aria-live="polite"
              >
                <div className="v10-drop-overlay-card">
                  {attachmentsEnabled ? (
                    <Upload className="v10-drop-overlay-icon" size={32} aria-hidden="true" />
                  ) : (
                    <Ban className="v10-drop-overlay-icon" size={32} aria-hidden="true" />
                  )}
                  <div className="v10-drop-overlay-title">
                    {attachmentsEnabled
                      ? `Drop files to attach to ${getProjectDisplayName(availableProjects, activeProjectId!)}`
                      : dropDisabledReason === 'sending'
                        ? 'Wait for the current send to finish.'
                        : dropDisabledReason === 'unsupported'
                          ? `${selected.name} doesn't accept file attachments.`
                          : 'Choose a context graph before attaching files.'}
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
              </div>
            )}
            <div
              className="v10-chat-messages v10-local-agent-messages"
              ref={setMessagesRegion}
              onScroll={onMessagesScroll}
            >
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
                    {renderMessageContent(
                      message.content,
                      message.role,
                      Boolean(message.synthesized),
                      Boolean(message.streaming),
                      message.failureNotice,
                    )}
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
                            // `--panel-elevated` is undefined in styles.css —
                            // the token is `--bg-elevated`. Pre-existing typo
                            // surfaced by UI-lead's PR4 audit (Task #69):
                            // when the bubble was removed, the silent
                            // fallback used to land near `--bg-surface` and
                            // happened to look right; now it falls back to
                            // `--bg-panel` and the chip blends in.
                            background: 'var(--bg-elevated)',
                            fontSize: 11,
                          }}
                        >
                          {attachment.fileName}
                        </span>
                      ))}
                    </div>
                  )}
                  {message.ts && (
                    // `<time dateTime>` is the semantic markup for a moment
                    // in time — assistive tech and machine parsers read the
                    // ISO string while sighted users see the locale-formatted
                    // display. UX-lead P1-A (minimum). The full relative-
                    // time + hover-only treatment lives in a future PR per
                    // user direction.
                    <time
                      className={`v10-local-agent-msg-time ${message.role}`}
                      dateTime={message.tsRaw}
                    >
                      {message.ts}
                    </time>
                  )}
                </div>
              ))}
              <div ref={localChatEndRef} />
              <button
                type="button"
                className={`v10-scroll-to-bottom ${showScrollToBottom ? 'visible' : ''}`}
                onClick={scrollMessagesToBottom}
                aria-label="Scroll to latest message"
                title="Scroll to latest message"
                tabIndex={showScrollToBottom ? 0 : -1}
                aria-hidden={!showScrollToBottom}
              >
                <ArrowDown size={14} aria-hidden="true" />
              </button>
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
                      onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onLocalInputChange(e.target.value)}
                      onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                        // IME composition: don't trap Enter while composing CJK/JP/KR.
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                          e.preventDefault();
                          // Single `canSend` gate shared with the send
                          // button — if the button is disabled (input
                          // off, empty composer, or any draft mid-upload),
                          // Enter must be a no-op too. Codex CIlgu.
                          if (canSend) {
                            onSendLocalMessage();
                          }
                          return;
                        }
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                          // Force send even with empty textarea if attachments
                          // queued — but still through the same shared gate so
                          // a Cmd+Enter during upload doesn't race the upload.
                          e.preventDefault();
                          if (canSend) {
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
                    <div className="v10-composer-controls">
                      <div className="v10-composer-controls-left">
                        <button
                          type="button"
                          className="v10-composer-attach"
                          onClick={() => attachmentInputRef.current?.click()}
                          // Single source of truth for "can attach right now":
                          // the shared `dropDisabledReason` that the drop
                          // overlay also uses, so the button's disabled state
                          // and the dropzone stay in lockstep. The tooltip
                          // mirrors the same reason chain instead of
                          // advertising a generic "Attach files" in the
                          // disabled states.
                          disabled={!attachmentsEnabled}
                          title={
                            attachmentsEnabled
                              ? 'Attach files'
                              : dropDisabledReason === 'noProject'
                                ? 'Choose a context graph to attach files'
                                : dropDisabledReason === 'sending'
                                  ? 'Wait for the current message to send'
                                  : 'This agent does not support attachments'
                          }
                          aria-label="Attach files"
                        >
                          <Paperclip size={14} aria-hidden="true" />
                        </button>
                        <div className="v10-composer-target">
                          <Select
                            className="v10-local-agent-target-select"
                            value={activeProjectId ?? ''}
                            onChange={onSelectProject}
                            options={[
                              // The "No project (clear selection)" row only
                              // renders once a real project is active.
                              // Otherwise its `value: ''` would match the
                              // empty trigger value and the picker would show
                              // "No project (clear selection)" as a fake
                              // selection instead of the intended "Choose a
                              // project" placeholder.
                              ...(activeProjectId
                                ? [{ value: '', label: 'No context graph (clear selection)' }]
                                : []),
                              ...selectableProjects.map((project) => ({ value: project.id, label: project.name })),
                            ]}
                            placeholder={projectsLoading ? 'Loading context graphs…' : 'Choose a context graph'}
                            // Disable while loading. When no project is active
                            // and the list is empty there's nothing to pick
                            // yet, so disable then too — once a project is
                            // active the clear row is always there.
                            disabled={projectsLoading || (!activeProjectId && selectableProjects.length === 0)}
                            ariaLabel="Active project"
                            prefixIcon={<Folder size={12} aria-hidden="true" />}
                          />
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`v10-local-agent-inline-send v10-local-agent-inline-send-${sendButtonMode}`}
                        onClick={sendButtonMode === 'streaming' ? onStopLocalStream : onSendLocalMessage}
                        disabled={
                          // Streaming: stop is always clickable.
                          // Uploading: button is informational only, no
                          //   interaction — auto-flips once upload settles.
                          // Idle: gated by the shared `canSend` flag, which
                          //   the keyboard Enter / Cmd+Enter handlers also
                          //   consult so the two surfaces stay in lockstep.
                          sendButtonMode === 'streaming'
                            ? false
                            : sendButtonMode === 'uploading'
                              ? true
                              : !canSend
                        }
                        aria-label={
                          // WAI-ARIA APG: button labels describe the action
                          // (or its current unavailability), not narrate
                          // state. "Send message (attachments uploading)"
                          // reads as "this button sends, but it's currently
                          // waiting for uploads" — the role + reason model
                          // screen readers expect. UX-lead P1-C.
                          sendButtonMode === 'streaming'
                            ? 'Stop reply'
                            : sendButtonMode === 'uploading'
                              ? 'Send message (attachments uploading)'
                              : 'Send message'
                        }
                        title={
                          sendButtonMode === 'streaming'
                            ? 'Stop reply'
                            : sendButtonMode === 'uploading'
                              ? 'Send message (attachments uploading)…'
                              : 'Send message'
                        }
                      >
                        {sendButtonMode === 'streaming' ? (
                          <Square size={12} aria-hidden="true" />
                        ) : sendButtonMode === 'uploading' ? (
                          <Loader2 className="v10-local-agent-inline-send-spinner" size={14} aria-hidden="true" />
                        ) : (
                          <ArrowUp size={14} aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )
      )}
    </div>
  );
}
