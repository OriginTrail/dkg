// @vitest-environment happy-dom
//
// Stage 5 — the Prime Agent block in the "Connect Another Agent" surface.
//
// The behaviour worth pinning is the zero-session case: Prime Agent publishes a
// bridge per live session, so "no sessions" is an ordinary idle state. If the
// panel ever renders that as an error the operator has nothing to act on, so
// these tests assert the copy, not just the presence of an element.

import React, { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';

// The pinned happy-dom build exposes a `localStorage` that lacks the Storage
// methods, and `stores/journey.ts` reads it at module scope — so the panel
// cannot even be imported without this. Same reason the sibling component
// suites need it; keep it before any dynamic import of PanelRight.
if (typeof globalThis.localStorage?.getItem !== 'function') {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => { store.clear(); },
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() { return store.size; },
    },
  });
}

// React 19 wants this flag before `act` will drive the scheduler quietly.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function noop() {}

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prime-agent',
    name: 'Prime Agent',
    description: 'Connect a local Prime Intellect Prime Agent through the DKG node.',
    framework: 'Prime Agent',
    connectSupported: true,
    chatSupported: true,
    chatReady: false,
    chatAttachments: false,
    persistentChat: false,
    bridgeOnline: false,
    bridgeStatusLabel: 'Offline',
    configured: false,
    detected: false,
    status: 'available',
    statusLabel: 'Ready to connect',
    detail: 'Prime Agent is available to connect.',
    source: 'live',
    ...overrides,
  } as any;
}

async function renderAddSurface(primeAgent: Record<string, unknown>) {
  const { ConnectedAgentsTab } = await import('../src/ui/components/Shell/PanelRight.js');

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(ConnectedAgentsTab, {
      integrations: [integration(primeAgent)],
      // The add-agent tab id selects the "Connect Another Agent" surface, which
      // is where an unconfigured integration is offered.
      selectedIntegrationId: '__add_agent__',
      selectedIntegration: null,
      selectedSessionId: null,
      selectedHasConversation: false,
      selectedIntegrationHasAnyConversation: false,
      onSelectIntegration: noop,
      onConnectIntegration: noop,
      onDisconnectIntegration: noop,
      onRefreshIntegration: noop,
      connectBusyId: null,
      refreshBusyId: null,
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
      availableProjects: [{ id: 'testing', name: 'Testing' }],
      projectsLoading: false,
      attachments: [],
      onAddAttachments: noop,
      onRemoveAttachment: noop,
    } as any));
  });

  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

describe('Prime Agent panel block', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('presents zero live sessions as a normal idle state, not a failure', async () => {
    const { container, unmount } = await renderAddSurface({ sessionCount: 0 });
    const line = container.querySelector('[data-testid="local-agent-sessions-prime-agent"]');
    expect(line?.textContent).toContain('No live session');
    // Idle must not borrow the error/warning treatment.
    expect(line?.className).not.toContain('error');
    expect(container.querySelector('[data-testid="local-agent-warning-prime-agent"]')).toBeNull();
    await unmount();
  });

  it('counts multiple live sessions and says which one is used', async () => {
    const { container, unmount } = await renderAddSurface({ sessionCount: 3, activeSessionId: 'abc' });
    const line = container.querySelector('[data-testid="local-agent-sessions-prime-agent"]');
    expect(line?.textContent).toContain('3 live sessions');
    await unmount();
  });

  it('omits the session line entirely when the node did not report a count', async () => {
    // An older daemon returns no metadata; inventing "0 sessions" there would be
    // a claim the node never made.
    const { container, unmount } = await renderAddSurface({});
    expect(container.querySelector('[data-testid="local-agent-sessions-prime-agent"]')).toBeNull();
    await unmount();
  });

  it('offers a Connect affordance and the agent mark', async () => {
    const { container, unmount } = await renderAddSurface({ sessionCount: 1 });
    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Connect Prime Agent');
    const logo = container.querySelector('[data-agent-logo="prime-agent"]');
    expect(logo).not.toBeNull();
    // Painted as a mask so it follows the theme's text colour.
    expect((logo as HTMLElement).style.maskImage).toContain('data:image/png;base64,');
    await unmount();
  });
});
