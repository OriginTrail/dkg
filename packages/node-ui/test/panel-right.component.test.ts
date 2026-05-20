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
const importFileMock = vi.fn();
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
    importFile: importFileMock,
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

async function waitForAssertion(assertion: () => void): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 1000) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

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
    // The peer-axis NetworkTab derives connected peers from
    // `connections.connections[]`; totals alone aren't enough.
    fetchConnectionsMock.mockResolvedValue({
      total: 1,
      direct: 1,
      relayed: 0,
      connections: [
        { peerId: 'peer-2', transport: 'direct', direction: 'outbound', openedAt: Date.now() - 60_000, durationMs: 60_000 },
      ],
    });
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
    importFileMock.mockResolvedValue({
      assertionUri: 'urn:dkg:assertion:completed',
      fileHash: 'sha256:completed',
      detectedContentType: 'text/markdown',
      extraction: { status: 'completed', tripleCount: 4, pipelineUsed: 'markdown' },
    });
    apiFetchMemorySessionsMock.mockResolvedValue({ sessions: [] });
  });

  it('renders, loads agent state, and sends chat with injected context entries', async () => {
    const { PanelRight } = await import('../src/ui/components/Shell/PanelRight.js');
    const { useProjectsStore } = await import('../src/ui/stores/projects.js');

    act(() => {
      useProjectsStore.setState({
        contextGraphs: [{ id: 'testing', name: 'Testing' }],
        loading: false,
        activeProjectId: 'testing',
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

    // The connection status label moved into the kebab popover, which is
    // rendered on demand. The active agent subtab still surfaces its name
    // and the ⋯ trigger; open the menu to confirm the connected status text.
    expect(container.textContent).toContain('OpenClaw');
    const tabMenuTrigger = container.querySelector('.v10-agent-tab-menu-trigger') as HTMLButtonElement | null;
    expect(tabMenuTrigger).toBeTruthy();
    await act(async () => {
      tabMenuTrigger!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      tabMenuTrigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('OpenClaw connected');
    // Close the menu so it doesn't intercept later interactions in this test.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    // PR2: composer toolbar has icon-only attach button (no text) and the project picker.
    expect(container.querySelector('.v10-composer-attach')).toBeTruthy();
    expect(container.querySelector('.v10-composer-target')).toBeTruthy();

    // Project picker is now the custom <Select>. Open it via the trigger,
    // then click the "Testing" option (rendered in a portal under document.body).
    const projectTrigger = container.querySelector('.v10-local-agent-target-select .v10-select-trigger') as HTMLButtonElement | null;
    expect(projectTrigger).toBeTruthy();
    await act(async () => {
      projectTrigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const testingOption = Array.from(document.body.querySelectorAll('.v10-select-option'))
      .find((opt) => opt.textContent?.trim() === 'Testing') as HTMLElement | undefined;
    expect(testingOption).toBeTruthy();
    await act(async () => {
      testingOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // The dropzone wraps the messages region and renders its own hidden input
    // (with tabindex="-1"); the attach button has a separate hidden input
    // without that attribute. Select the latter explicitly so we test the
    // attach-button flow, not a dropzone bypass.
    const attachInput = Array.from(container.querySelectorAll('input[type="file"]'))
      .find((el) => !el.hasAttribute('tabindex')) as HTMLInputElement | null;
    expect(attachInput).toBeTruthy();
    await act(async () => {
      Object.defineProperty(attachInput, 'files', {
        configurable: true,
        value: [new File(['hello'], 'draft.md', { type: 'text/markdown' })],
      });
      attachInput!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container.textContent).toContain('draft.md');
    // PR2: Remove button is now icon-only (× lucide); locate by class.
    const removeButton = container.querySelector('.v10-attachment-chip-remove') as HTMLButtonElement | null;
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

    // PR2: Send button is now icon-only (ArrowUp); locate via aria-label.
    const sendButton = container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement | null;
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
          value: 'Testing (testing)',
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

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('imports skipped chat attachments as context entries and clears the composer after send', async () => {
    importFileMock.mockResolvedValue({
      assertionUri: 'urn:dkg:assertion:epub',
      fileHash: 'sha256:epub',
      detectedContentType: 'application/epub+zip',
      extraction: {
        status: 'skipped',
        tripleCount: 0,
        pipelineUsed: null,
        error: 'No extractor\navailable',
      },
    });

    const { PanelRight } = await import('../src/ui/components/Shell/PanelRight.js');
    const { useProjectsStore } = await import('../src/ui/stores/projects.js');

    act(() => {
      useProjectsStore.setState({
        contextGraphs: [{ id: 'testing', name: 'Testing' }],
        loading: false,
        activeProjectId: 'testing',
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

    // Project picker is now the custom <Select>. Open it via the trigger,
    // then click the "Testing" option (rendered in a portal under document.body).
    const projectTrigger = container.querySelector('.v10-local-agent-target-select .v10-select-trigger') as HTMLButtonElement | null;
    expect(projectTrigger).toBeTruthy();
    await act(async () => {
      projectTrigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const testingOption = Array.from(document.body.querySelectorAll('.v10-select-option'))
      .find((opt) => opt.textContent?.trim() === 'Testing') as HTMLElement | undefined;
    expect(testingOption).toBeTruthy();
    await act(async () => {
      testingOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // The dropzone wraps the messages region and renders its own hidden input
    // (with tabindex="-1"); the attach button has a separate hidden input
    // without that attribute. Select the latter explicitly so we test the
    // attach-button flow, not a dropzone bypass.
    const attachInput = Array.from(container.querySelectorAll('input[type="file"]'))
      .find((el) => !el.hasAttribute('tabindex')) as HTMLInputElement | null;
    expect(attachInput).toBeTruthy();
    const file = new File(['epub'], ' notes.epub ', {
      type: 'application/octet-stream',
      lastModified: 123,
    });
    await act(async () => {
      Object.defineProperty(attachInput, 'files', {
        configurable: true,
        value: [file],
      });
      attachInput!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(container.textContent).toContain('notes.epub');

    const textarea = container.querySelector('textarea');
    expect(textarea).toBeTruthy();
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      valueSetter?.call(textarea, 'Summarize this file');
      textarea!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // PR2: Send button is now icon-only (ArrowUp); locate via aria-label.
    const sendButton = container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement | null;
    expect(sendButton).toBeTruthy();
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(streamLocalAgentChatMock).toHaveBeenCalled();
    });

    expect(importFileMock).toHaveBeenCalledWith(expect.any(String), 'testing', file);
    const [integrationId, outboundText, options] = streamLocalAgentChatMock.mock.calls.at(-1) ?? [];
    expect(integrationId).toBe('openclaw');
    expect(outboundText).toBe('Summarize this file\n\nAttachment import result: notes.epub.');
    expect(options.attachments).toEqual([]);
    expect(options.contextGraphId).toBe('testing');
    expect(options.contextEntries.some((entry: any) => entry.key.startsWith('attachment_import_result_'))).toBe(false);
    expect(options.attachmentImportResults).toEqual([
      expect.objectContaining({
        fileName: 'notes.epub',
        contextGraphId: 'testing',
        assertionUri: 'urn:dkg:assertion:epub',
        fileHash: 'sha256:epub',
        detectedContentType: 'application/epub+zip',
        extractionStatus: 'skipped',
        pipelineUsed: null,
        tripleCount: 0,
        error: 'No extractor\navailable',
      }),
    ]);

    await waitForAssertion(() => {
      expect(container.querySelector('.v10-local-agent-attachment-list')).toBeNull();
    });
    expect(container.textContent).toContain('Attachment import result: notes.epub.');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('normalizes completed chat attachment filenames before sending refs', async () => {
    importFileMock.mockResolvedValue({
      assertionUri: 'urn:dkg:assertion:markdown',
      fileHash: 'sha256:markdown',
      detectedContentType: 'text/markdown',
      rootEntity: 'urn:dkg:assertion:markdown#root',
      extraction: {
        status: 'completed',
        tripleCount: 4,
        pipelineUsed: 'markdown',
      },
    });

    const { PanelRight } = await import('../src/ui/components/Shell/PanelRight.js');
    const { useProjectsStore } = await import('../src/ui/stores/projects.js');

    act(() => {
      useProjectsStore.setState({
        contextGraphs: [{ id: 'testing', name: 'Testing' }],
        loading: false,
        activeProjectId: 'testing',
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

    // Project picker is now the custom <Select>. Open it via the trigger,
    // then click the "Testing" option (rendered in a portal under document.body).
    const projectTrigger = container.querySelector('.v10-local-agent-target-select .v10-select-trigger') as HTMLButtonElement | null;
    expect(projectTrigger).toBeTruthy();
    await act(async () => {
      projectTrigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const testingOption = Array.from(document.body.querySelectorAll('.v10-select-option'))
      .find((opt) => opt.textContent?.trim() === 'Testing') as HTMLElement | undefined;
    expect(testingOption).toBeTruthy();
    await act(async () => {
      testingOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // The dropzone wraps the messages region and renders its own hidden input
    // (with tabindex="-1"); the attach button has a separate hidden input
    // without that attribute. Select the latter explicitly so we test the
    // attach-button flow, not a dropzone bypass.
    const attachInput = Array.from(container.querySelectorAll('input[type="file"]'))
      .find((el) => !el.hasAttribute('tabindex')) as HTMLInputElement | null;
    expect(attachInput).toBeTruthy();
    const file = new File(['# Notes'], ' notes.md ', {
      type: 'text/markdown',
      lastModified: 456,
    });
    await act(async () => {
      Object.defineProperty(attachInput, 'files', {
        configurable: true,
        value: [file],
      });
      attachInput!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // PR2: Send button is now icon-only (ArrowUp); locate via aria-label.
    const sendButton = container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement | null;
    expect(sendButton).toBeTruthy();
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(streamLocalAgentChatMock).toHaveBeenCalled();
    });

    expect(importFileMock).toHaveBeenCalledWith(expect.any(String), 'testing', file);
    const [integrationId, outboundText, options] = streamLocalAgentChatMock.mock.calls.at(-1) ?? [];
    expect(integrationId).toBe('openclaw');
    expect(outboundText).toBe('');
    expect(options.persistUserMessage).toBe('Attached notes.md.');
    expect(options.attachments).toEqual([
      expect.objectContaining({
        fileName: 'notes.md',
        contextGraphId: 'testing',
        assertionUri: 'urn:dkg:assertion:markdown',
        fileHash: 'sha256:markdown',
        detectedContentType: 'text/markdown',
        extractionStatus: 'completed',
        tripleCount: 4,
      }),
    ]);
    expect(options.attachmentImportResults).toEqual([]);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('keeps skipped-import-only transport text blank while showing the import summary locally', async () => {
    importFileMock.mockResolvedValue({
      assertionUri: 'urn:dkg:assertion:epub-only',
      fileHash: 'sha256:epub-only',
      detectedContentType: 'application/epub+zip',
      extraction: {
        status: 'skipped',
        tripleCount: 0,
        pipelineUsed: null,
      },
    });

    const { PanelRight } = await import('../src/ui/components/Shell/PanelRight.js');
    const { useProjectsStore } = await import('../src/ui/stores/projects.js');

    act(() => {
      useProjectsStore.setState({
        contextGraphs: [{ id: 'testing', name: 'Testing' }],
        loading: false,
        activeProjectId: 'testing',
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

    // Project picker is now the custom <Select>. Open it via the trigger,
    // then click the "Testing" option (rendered in a portal under document.body).
    const projectTrigger = container.querySelector('.v10-local-agent-target-select .v10-select-trigger') as HTMLButtonElement | null;
    expect(projectTrigger).toBeTruthy();
    await act(async () => {
      projectTrigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const testingOption = Array.from(document.body.querySelectorAll('.v10-select-option'))
      .find((opt) => opt.textContent?.trim() === 'Testing') as HTMLElement | undefined;
    expect(testingOption).toBeTruthy();
    await act(async () => {
      testingOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // The dropzone wraps the messages region and renders its own hidden input
    // (with tabindex="-1"); the attach button has a separate hidden input
    // without that attribute. Select the latter explicitly so we test the
    // attach-button flow, not a dropzone bypass.
    const attachInput = Array.from(container.querySelectorAll('input[type="file"]'))
      .find((el) => !el.hasAttribute('tabindex')) as HTMLInputElement | null;
    expect(attachInput).toBeTruthy();
    const file = new File(['epub'], 'notes.epub', {
      type: 'application/octet-stream',
      lastModified: 789,
    });
    await act(async () => {
      Object.defineProperty(attachInput, 'files', {
        configurable: true,
        value: [file],
      });
      attachInput!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // PR2: Send button is now icon-only (ArrowUp); locate via aria-label.
    const sendButton = container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement | null;
    expect(sendButton).toBeTruthy();
    await act(async () => {
      sendButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(streamLocalAgentChatMock).toHaveBeenCalled();
    });

    const [integrationId, outboundText, options] = streamLocalAgentChatMock.mock.calls.at(-1) ?? [];
    expect(integrationId).toBe('openclaw');
    expect(outboundText).toBe('');
    expect(options.persistUserMessage).toBe('Attachment import result: notes.epub.');
    expect(options.attachments).toEqual([]);
    expect(options.attachmentImportResults).toEqual([
      expect.objectContaining({
        fileName: 'notes.epub',
        contextGraphId: 'testing',
        assertionUri: 'urn:dkg:assertion:epub-only',
        fileHash: 'sha256:epub-only',
        detectedContentType: 'application/epub+zip',
        extractionStatus: 'skipped',
      }),
    ]);
    expect(container.textContent).toContain('Attachment import result: notes.epub.');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
