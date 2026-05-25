// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

const createContextGraphMock = vi.fn();
const fetchContextGraphsMock = vi.fn();
const fetchCurrentAgentMock = vi.fn();
const installOntologyMock = vi.fn();
const publishProjectManifestMock = vi.fn();

vi.mock('../src/ui/api.js', async () => {
  const actual = await vi.importActual<any>('../src/ui/api.js');
  return {
    ...actual,
    createContextGraph: createContextGraphMock,
    fetchContextGraphs: fetchContextGraphsMock,
    fetchCurrentAgent: fetchCurrentAgentMock,
  };
});

vi.mock('../src/ui/lib/ontologyInstall.js', () => ({
  installOntology: installOntologyMock,
  listStarters: () => [{
    slug: 'coding-project',
    displayName: 'Coding Project',
    description: 'Default coding starter',
  }],
}));

vi.mock('../src/ui/lib/projectManifest.js', () => ({
  publishProjectManifest: publishProjectManifestMock,
}));

vi.mock('../src/ui/components/Workspace/WireWorkspacePanel.js', () => ({
  WireWorkspacePanel: ({ contextGraphId, projectName }: { contextGraphId: string; projectName: string }) =>
    React.createElement('div', { 'data-testid': 'wire-workspace' }, `${projectName}:${contextGraphId}`),
}));

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('CreateProjectModal partial registration flow', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  const agentAddress = '0x00000000000000000000000000000000000000a1';
  const cgId = `${agentAddress}/partial-registration`;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchCurrentAgentMock.mockResolvedValue({
      agentAddress,
      agentDid: `did:dkg:agent:${agentAddress}`,
      name: 'Local Agent',
      peerId: 'peer-local',
    });
    createContextGraphMock.mockResolvedValue({
      created: cgId,
      registered: false,
      registerError: 'rpc unavailable',
    });
    fetchContextGraphsMock.mockResolvedValue({
      contextGraphs: [{ id: cgId, name: 'Partial Registration' }],
    });
    installOntologyMock.mockResolvedValue(undefined);
    publishProjectManifestMock.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
  });

  async function renderModal() {
    const { CreateProjectModal } = await import('../src/ui/components/Modals/CreateProjectModal.js');
    const { useProjectsStore } = await import('../src/ui/stores/projects.js');
    const { useTabsStore } = await import('../src/ui/stores/tabs.js');
    const { useJourneyStore } = await import('../src/ui/stores/journey.js');
    act(() => {
      useProjectsStore.setState({ contextGraphs: [], loading: false, activeProjectId: null });
      useTabsStore.setState({
        tabs: [{ id: 'dashboard', label: 'Dashboard', closable: false }],
        activeTabId: 'dashboard',
      });
      useJourneyStore.setState({ stage: 0 });
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(CreateProjectModal, { open: true, onClose: vi.fn() }));
    });
    await flush();
    return { useProjectsStore };
  }

  it('keeps a locally-created project active and visible when on-chain registration fails', async () => {
    const { useProjectsStore } = await renderModal();
    const nameInput = container!.querySelector('input[type="text"]') as HTMLInputElement | null;
    const registerCheckbox = container!.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    expect(nameInput).toBeTruthy();
    expect(registerCheckbox).toBeTruthy();

    await act(async () => {
      setInputValue(nameInput!, 'Partial Registration');
      registerCheckbox!.click();
    });
    await flush();

    const createButton = Array
      .from(container!.querySelectorAll('button'))
      .find((button) => button.textContent === 'Create Context Graph') as HTMLButtonElement | undefined;
    expect(createButton).toBeTruthy();
    await act(async () => {
      createButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    await flush();

    expect(createContextGraphMock).toHaveBeenCalledWith(
      cgId,
      'Partial Registration',
      undefined,
      expect.objectContaining({ register: true }),
    );
    expect(useProjectsStore.getState().activeProjectId).toBe(cgId);
    expect(container!.querySelector('[data-testid="wire-workspace"]')).toBeTruthy();
    expect(container!.textContent).toContain('On-chain registration failed: rpc unavailable');
  });
});
