// @vitest-environment happy-dom
//
// Regression test for issue #255: chat history disappears on every page refresh.
// Mocks the api the same way panel-right.component.test.ts does (OpenClaw bridge
// is mocked per project policy).

import React, { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';

const fetchAgentsMock = vi.fn();
const fetchConnectionsMock = vi.fn();
const fetchLocalAgentIntegrationsMock = vi.fn();
const fetchLocalAgentHistoryMock = vi.fn();
const streamLocalAgentChatMock = vi.fn();
const connectLocalAgentIntegrationMock = vi.fn();
const disconnectLocalAgentIntegrationMock = vi.fn();
const apiFetchMemorySessionsMock = vi.fn();

vi.mock('../src/ui/api.js', async () => {
  const actual = await vi.importActual<any>('../src/ui/api.js');
  return {
    ...actual,
    fetchAgents: fetchAgentsMock,
    fetchConnections: fetchConnectionsMock,
    fetchLocalAgentIntegrations: fetchLocalAgentIntegrationsMock,
    fetchLocalAgentHistory: fetchLocalAgentHistoryMock,
    streamLocalAgentChat: streamLocalAgentChatMock,
    connectLocalAgentIntegration: connectLocalAgentIntegrationMock,
    disconnectLocalAgentIntegration: disconnectLocalAgentIntegrationMock,
  };
});

vi.mock('../src/ui/api-wrapper.js', () => ({
  api: {
    fetchMemorySessions: apiFetchMemorySessionsMock,
  },
}));

describe('PanelRight chat history rehydration on mount (issue #255)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();

    fetchAgentsMock.mockResolvedValue({ agents: [] });
    fetchConnectionsMock.mockResolvedValue({ total: 0, direct: 0, relayed: 0 });
    apiFetchMemorySessionsMock.mockResolvedValue({ sessions: [] });
    streamLocalAgentChatMock.mockResolvedValue({ text: 'fresh', correlationId: 'x' });
  });

  function readyOpenclawIntegration(overrides: Record<string, unknown> = {}) {
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
    };
  }

  function readyHermesIntegration(overrides: Record<string, unknown> = {}) {
    return readyOpenclawIntegration({
      id: 'hermes',
      name: 'Hermes',
      defaultSessionId: 'hermes:dkg-ui:profile-dkg-smoke:home-abcd',
      target: 'bridge',
      ...overrides,
    });
  }

  async function flushAll(times = 8): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      await act(async () => { await Promise.resolve(); });
    }
  }

  it('hydrates persisted history from the openclaw default session before integrations resolve (issue #255)', async () => {
    // The bridge probe is slow on a fresh page load: integrations resolve only
    // after the chat history fetch should already be in flight. Issue #255 is
    // that chat history stays empty across that window.
    let resolveIntegrations: ((value: any) => void) | null = null;
    fetchLocalAgentIntegrationsMock.mockImplementation(
      () => new Promise((resolve) => {
        resolveIntegrations = resolve;
      }),
    );
    fetchLocalAgentHistoryMock.mockResolvedValue([
      { uri: 'urn:m:1', text: 'hello from before refresh', author: 'user', ts: '2026-04-23T01:00:00Z', turnId: 't1' },
      { uri: 'urn:m:2', text: 'and here is the prior reply', author: 'assistant', ts: '2026-04-23T01:00:01Z', turnId: 't1' },
    ]);

    const { PanelRight } = await import('../src/ui/components/Shell/PanelRight.js');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(PanelRight));
    });
    await flushAll();

    expect(fetchLocalAgentHistoryMock).toHaveBeenCalled();
    const earlyCall = fetchLocalAgentHistoryMock.mock.calls.find(
      (args) => args[0] === 'openclaw'
        && args[2]?.sessionId === 'openclaw:dkg-ui',
    );
    expect(earlyCall, 'chat history must be fetched on mount even before integrations resolve').toBeTruthy();
    const hermesEarlyCall = fetchLocalAgentHistoryMock.mock.calls.find(
      (args) => args[0] === 'hermes',
    );
    expect(hermesEarlyCall, 'Hermes history waits for profile-aware integration metadata').toBeFalsy();

    await act(async () => {
      resolveIntegrations?.({ integrations: [readyOpenclawIntegration()] });
    });
    await flushAll();

    expect(container.textContent).toContain('hello from before refresh');
    expect(container.textContent).toContain('and here is the prior reply');

    root.unmount();
    container.remove();
  });

  it('renders persisted chat history when integrations resolve quickly (existing happy path)', async () => {
    fetchLocalAgentIntegrationsMock.mockResolvedValue({ integrations: [readyOpenclawIntegration()] });
    fetchLocalAgentHistoryMock.mockResolvedValue([
      { uri: 'urn:m:1', text: 'hello from before refresh', author: 'user', ts: '2026-04-23T01:00:00Z', turnId: 't1' },
      { uri: 'urn:m:2', text: 'and here is the prior reply', author: 'assistant', ts: '2026-04-23T01:00:01Z', turnId: 't1' },
    ]);

    const { PanelRight } = await import('../src/ui/components/Shell/PanelRight.js');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(PanelRight));
    });
    await flushAll();

    expect(container.textContent).toContain('hello from before refresh');
    expect(container.textContent).toContain('and here is the prior reply');

    root.unmount();
    container.remove();
  });

  it('hydrates Hermes history from its profile-aware default session after integrations resolve', async () => {
    fetchLocalAgentIntegrationsMock.mockResolvedValue({ integrations: [readyHermesIntegration()] });
    fetchLocalAgentHistoryMock.mockResolvedValue([]);

    const { PanelRight } = await import('../src/ui/components/Shell/PanelRight.js');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(PanelRight));
    });
    await flushAll();

    const hermesProfileCall = fetchLocalAgentHistoryMock.mock.calls.find(
      (args) => args[0] === 'hermes'
        && args[2]?.sessionId === 'hermes:dkg-ui:profile-dkg-smoke:home-abcd',
    );
    expect(hermesProfileCall, 'Hermes history should use the profile-aware default session').toBeTruthy();

    root.unmount();
    container.remove();
  });
});
