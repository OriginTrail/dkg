import React from 'react';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

let ConnectedAgentsTab: any;
let getLocalAgentConversationStateKey: any;
let markLocalAgentIntegrationDisconnected: any;
let networkPeerCardStatusClass: any;
let resolveConnectedAgentsTabState: any;
let resolveLocalAgentSelectionState: any;
let shouldPreserveSelectedLocalAgentTab: any;
let shouldPreserveSessionForIntegrationSelection: any;
let shouldPreserveSessionOnReconnect: any;
let upsertLocalAgentIntegrationState: any;

/**
 * Minimal real Storage implementation for tests that import
 * PanelRight under Node (no DOM, no jsdom). This satisfies the
 * Web Storage API surface that PanelRight reads at module load
 * time without using any test-framework mocking primitives.
 */
class TestLocalStorage implements Storage {
  private readonly store = new Map<string, string>();
  get length(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null; }
  removeItem(key: string): void { this.store.delete(key); }
  setItem(key: string, value: string): void { this.store.set(key, String(value)); }
}

const noop = () => {};

beforeAll(async () => {
  (globalThis as any).localStorage = new TestLocalStorage();

  const panelRight = await import('../src/ui/components/Shell/PanelRight.js');
  ConnectedAgentsTab = panelRight.ConnectedAgentsTab;
  getLocalAgentConversationStateKey = panelRight.getLocalAgentConversationStateKey;
  markLocalAgentIntegrationDisconnected = panelRight.markLocalAgentIntegrationDisconnected;
  networkPeerCardStatusClass = panelRight.networkPeerCardStatusClass;
  resolveConnectedAgentsTabState = panelRight.resolveConnectedAgentsTabState;
  resolveLocalAgentSelectionState = panelRight.resolveLocalAgentSelectionState;
  shouldPreserveSelectedLocalAgentTab = panelRight.shouldPreserveSelectedLocalAgentTab;
  shouldPreserveSessionForIntegrationSelection = panelRight.shouldPreserveSessionForIntegrationSelection;
  shouldPreserveSessionOnReconnect = panelRight.shouldPreserveSessionOnReconnect;
  upsertLocalAgentIntegrationState = panelRight.upsertLocalAgentIntegrationState;
});

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'Local bridge',
    connectSupported: true,
    chatSupported: true,
    chatReady: true,
    chatAttachments: true,
    persistentChat: true,
    bridgeOnline: true,
    bridgeStatusLabel: 'Connected',
    configured: true,
    detected: true,
    status: 'connected',
    statusLabel: 'Connected',
    detail: 'ready',
    target: 'local',
    ...overrides,
  } as any;
}

function renderConnectedAgentsTab(overrides: Record<string, unknown> = {}) {
  // renderToStaticMarkup never fires event handlers, so plain no-op
  // functions are sufficient for the callback props (no need for any
  // test-framework spy/mock primitive here).
  const props = {
    integrations: [integration()],
    selectedIntegrationId: 'openclaw',
    selectedIntegration: integration(),
    selectedSessionId: 'openclaw:default',
    selectedHasConversation: false,
    selectedIntegrationHasAnyConversation: false,
    onSelectIntegration: noop,
    onConnectIntegration: noop,
    onDisconnectIntegration: noop,
    onRefreshIntegrations: noop,
    connectBusyId: null,
    connectNotice: null,
    connectError: null,
    localMessages: [],
    localHistoryLoaded: true,
    localChatEndRef: { current: null },
    localInput: '',
    onLocalInputChange: noop,
    onSendLocalMessage: noop,
    localSending: false,
    activeProjectId: 'testing',
    availableProjects: [
      { id: 'testing', name: 'Testing' },
      { id: 'agents', name: 'Agents' },
    ],
    projectsLoading: false,
    onSelectProject: noop,
    attachments: [],
    onAddAttachments: noop,
    onRemoveAttachment: noop,
    ...overrides,
  } as any;

  return renderToStaticMarkup(React.createElement(ConnectedAgentsTab, props));
}

describe('PanelRight logic helpers', () => {
  it('resolves conversation state keys and session preservation correctly', () => {
    const integrations = [integration(), integration({ id: 'hermes', name: 'Hermes', persistentChat: false })];
    expect(getLocalAgentConversationStateKey('openclaw', null)).toBe('integration:openclaw');
    expect(getLocalAgentConversationStateKey('openclaw', 'openclaw:abc')).toBe('openclaw:abc');
    expect(shouldPreserveSessionForIntegrationSelection({
      integrationId: 'openclaw',
      selectedSessionId: 'openclaw:abc',
      integrations,
    })).toBe(true);
    expect(shouldPreserveSessionOnReconnect({
      integrationId: 'hermes',
      selectedSessionId: 'openclaw:abc',
      integrations,
    })).toBe(false);
  });

  it('resolves local agent selection state from saved sessions and message history', () => {
    const integrations = [integration(), integration({ id: 'hermes', name: 'Hermes', persistentChat: false })];
    const state = resolveLocalAgentSelectionState({
      integrations,
      selectedIntegrationId: 'hermes',
      selectedSessionId: 'hermes:thread-1',
      localMessagesByConversation: {
        'hermes:thread-1': [{ id: 'm1', role: 'user', content: 'hello' }],
      },
      sessions: [{
        sessionId: 'hermes:thread-1',
        integrationId: 'hermes',
        integrationName: 'Hermes',
        preview: 'hello',
        messageCount: 1,
        lastTs: '2026-04-14T10:00:00Z',
      }],
    });

    expect(state.selectedIntegration?.id).toBe('hermes');
    expect(state.selectedConversation?.stateKey).toBe('hermes:thread-1');
    expect(state.selectedHasConversation).toBe(true);
    expect(state.selectedIntegrationHasAnyConversation).toBe(true);
    expect(state.connectedIntegrations.map((item) => item.id)).toEqual(['openclaw']);
  });

  it('resolves tab state for disconnected stored sessions and loading conversations', () => {
    const selected = integration({ id: 'openclaw', persistentChat: false, chatReady: false, bridgeOnline: false, status: 'available' });
    const stored = resolveConnectedAgentsTabState({
      connectedAgents: [integration()],
      selectedIntegration: selected,
      selectedIntegrationId: 'openclaw',
      selectedHasConversation: true,
      selectedIntegrationHasAnyConversation: true,
      localHistoryLoaded: true,
      localMessagesCount: 0,
    });

    expect(stored.showingSessionHistory).toBe(true);
    expect(stored.showingStoredSessions).toBe(true);
    expect(stored.visibleAgentTabs[0]?.id).toBe('openclaw');

    const loader = resolveConnectedAgentsTabState({
      connectedAgents: [integration()],
      selectedIntegration: integration(),
      selectedIntegrationId: 'openclaw',
      selectedHasConversation: false,
      selectedIntegrationHasAnyConversation: false,
      localHistoryLoaded: false,
      localMessagesCount: 0,
    });
    expect(loader.shouldShowConversationLoader).toBe(true);
  });

  it('upserts integrations, marks disconnections, and preserves selected tabs with history', () => {
    const list = [integration({ id: 'hermes', name: 'Hermes', persistentChat: false, connectSupported: false, status: 'coming_soon', statusLabel: 'Coming next' })];
    const upserted = upsertLocalAgentIntegrationState(list, integration());
    expect(upserted.map((item) => item.id)).toEqual(['openclaw', 'hermes']);

    const disconnected = markLocalAgentIntegrationDisconnected([integration()], 'openclaw');
    expect(disconnected[0]).toMatchObject({
      persistentChat: false,
      chatReady: false,
      bridgeOnline: false,
      status: 'available',
      target: undefined,
    });

    expect(shouldPreserveSelectedLocalAgentTab({
      selectedIntegrationId: 'openclaw',
      selectedItem: disconnected[0],
      selectedSessionId: 'openclaw:abc',
      localMessagesByConversation: {
        'openclaw:abc': [{ id: 'm1', role: 'assistant', content: 'hi' }],
      },
      sessionSummaries: [],
    })).toBe(true);
  });

  it('maps network peer status classes conservatively', () => {
    expect(networkPeerCardStatusClass({ connectionStatus: 'connected' })).toBe('connected');
    expect(networkPeerCardStatusClass({ connectionStatus: 'disconnected' })).toBe('offline');
    expect(networkPeerCardStatusClass({})).toBe('offline');
  });
});

describe('ConnectedAgentsTab rendering', () => {
  it('renders add-agent flow with OpenClaw and Hermes content', () => {
    const markup = renderConnectedAgentsTab({
      integrations: [
        integration({ persistentChat: false, configured: false, detected: false, bridgeOnline: false, chatReady: false, status: 'available', statusLabel: 'Ready to connect' }),
        integration({ id: 'hermes', name: 'Hermes', persistentChat: false, configured: false, detected: false, bridgeOnline: false, chatReady: false, status: 'coming_soon', statusLabel: 'Coming next', connectSupported: false }),
      ],
      selectedIntegrationId: '__add_agent__',
      selectedIntegration: null,
      connectBusyId: 'openclaw',
      connectNotice: 'connected',
      connectError: 'error',
    });

    expect(markup).toContain('Connect Another Agent');
    expect(markup).toContain('Connecting...');
    expect(markup).toContain('Docs');
    expect(markup).toContain('Release Notes');
    expect(markup).toContain('Hermes will plug into this same local-agent contract next');
    expect(markup).toContain('connected');
    expect(markup).toContain('error');
  });

  it('renders chat shell, markdown bubbles, attachments, project picker, and upload composer', () => {
    const markup = renderConnectedAgentsTab({
      localMessages: [{
        id: 'a1',
        role: 'assistant',
        content: 'Hello **world**\n`code`',
        ts: '10:00',
        attachments: [{ fileName: 'spec.md', contextGraphId: 'testing', assertionName: 'spec' }],
      }],
      attachments: [{
        id: 'draft-1',
        file: new File(['hello'], 'spec.md', { type: 'text/markdown' }),
        contextGraphId: 'testing',
        assertionName: 'spec',
        status: 'queued',
      }],
      localInput: 'draft',
    });

    expect(markup).toContain('OpenClaw connected');
    expect(markup).toContain('Refresh');
    expect(markup).toContain('Disconnect');
    expect(markup).toContain('Hello <strong>world</strong><br/><code>code</code>');
    expect(markup).toContain('spec.md');
    expect(markup).toContain('Queued - imports on send');
    expect(markup).toContain('Queued files keep their stored target: Testing.');
    expect(markup).toContain('Project');
    expect(markup).toContain('Upload file');
    expect(markup).toContain('Message OpenClaw');
    expect(markup).toContain('Send');
  });

  it('renders disconnected history warnings and empty-state messaging', () => {
    const markup = renderConnectedAgentsTab({
      selectedIntegration: integration({ persistentChat: false, chatReady: false, bridgeOnline: false, status: 'available' }),
      selectedHasConversation: true,
      selectedIntegrationHasAnyConversation: true,
      localMessages: [],
      localHistoryLoaded: true,
    });

    expect(markup).toContain('Session history');
    expect(markup).toContain('is not currently attached to this node');
    expect(markup).toContain('session history is available, but there are no stored turns to show yet');
  });
});
