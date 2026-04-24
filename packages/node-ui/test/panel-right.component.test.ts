// @vitest-environment happy-dom
//
// NOTE on mocking: this test mocks `../src/ui/api.js` and `../src/ui/api-wrapper.js`
// because PanelRight is exclusively driven by OpenClaw integration calls
// (`fetchLocalAgentIntegrations`, `streamLocalAgentChat`, `fetchOpenClawLocalHealth`,
// etc.), and the OpenClaw bridge is a fully external runtime that the project
// chooses to mock — see the user-approved exception covering OpenClaw and
// graph-viz adapters elsewhere in the test suite. De-mocking would require
// running a live OpenClaw daemon (or building a realistic fake of it) inside
// CI, which the same exception explicitly opts out of. All other UI tests in
// this package use real HTTP servers / real Storage shims (no mocks).

import React, { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';

const fetchAgentsMock = vi.fn();
const fetchConnectionsMock = vi.fn();
const fetchLocalAgentIntegrationsMock = vi.fn();
const fetchLocalAgentHistoryMock = vi.fn();
const fetchCurrentAgentMock = vi.fn();
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
    fetchCurrentAgent: fetchCurrentAgentMock,
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

describe('PanelRight component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();

    fetchAgentsMock.mockResolvedValue({ agents: [{
      agentUri: 'did:dkg:agent:peer-2',
      name: 'Peer Two',
      peerId: 'peer-2',
      connectionStatus: 'connected',
    }] });
    fetchConnectionsMock.mockResolvedValue({ total: 1, direct: 1, relayed: 0 });
    fetchLocalAgentIntegrationsMock.mockResolvedValue({ integrations: [{
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
    }] });
    fetchLocalAgentHistoryMock.mockResolvedValue([]);
    fetchCurrentAgentMock.mockResolvedValue({
      agentAddress: 'peer-self',
      agentDid: 'did:dkg:agent:peer-self',
      name: 'Self',
      peerId: 'peer-self',
      nodeIdentityId: 'node-self',
    });
    streamLocalAgentChatMock.mockResolvedValue({ text: 'Roger that', correlationId: 'corr-1' });
    apiFetchMemorySessionsMock.mockResolvedValue({ sessions: [] });
  });

  it('renders, loads agent state, and sends chat with injected context entries', async () => {
    const { PanelRight } = await import('../src/ui/components/Shell/PanelRight.js');
    const { useProjectsStore } = await import('../src/ui/stores/projects.js');

    act(() => {
      useProjectsStore.setState({
        contextGraphs: [{ id: 'origin-trail-game', name: 'Origin Trail Game' }],
        loading: false,
        activeProjectId: 'origin-trail-game',
      });
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(React.createElement(PanelRight));
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('OpenClaw connected');
    expect(container.textContent).toContain('Project');
    expect(container.textContent).toContain('Upload file');

    const projectSelect = container.querySelector('select') as HTMLSelectElement | null;
    expect(projectSelect).toBeTruthy();
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      valueSetter?.call(projectSelect, 'origin-trail-game');
      projectSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const attachInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(attachInput).toBeTruthy();
    await act(async () => {
      Object.defineProperty(attachInput, 'files', {
        configurable: true,
        value: [new File(['hello'], 'draft.md', { type: 'text/markdown' })],
      });
      attachInput!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container.textContent).toContain('draft.md');
    const removeButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Remove'));
    expect(removeButton).toBeTruthy();
    await act(async () => {
      removeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).not.toContain('draft.md');

    const networkTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Network');
    expect(networkTab).toBeTruthy();
    await act(async () => {
      networkTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('Peer Two');

    const sessionsTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Sessions');
    expect(sessionsTab).toBeTruthy();
    await act(async () => {
      sessionsTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('No integrated-agent sessions yet.');

    const agentsTab = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Agents');
    await act(async () => {
      agentsTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const textarea = container.querySelector('textarea');
    expect(textarea).toBeTruthy();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      valueSetter?.call(textarea, 'Check memory');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    const sendButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Send'));
    expect(sendButton).toBeTruthy();
    expect(sendButton?.hasAttribute('disabled')).toBe(false);

    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(streamLocalAgentChatMock).toHaveBeenCalledWith('openclaw', 'Check memory', expect.objectContaining({
      contextEntries: [
        {
          key: 'target_context_graph',
          label: 'Target context graph',
          value: 'Origin Trail Game (origin-trail-game)',
        },
        {
          key: 'current_agent_address',
          label: 'Current agent address',
          value: 'peer-self',
        },
        {
          key: 'current_agent_did',
          label: 'Current agent DID',
          value: 'did:dkg:agent:peer-self',
        },
        {
          key: 'current_agent_peer_id',
          label: 'Current agent peer ID',
          value: 'peer-self',
        },
      ],
    }));
    expect(container.textContent).toContain('Roger that');

    root.unmount();
    container.remove();
  });
});
