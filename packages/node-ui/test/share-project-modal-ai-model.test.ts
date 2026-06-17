// @vitest-environment happy-dom

// Coverage for the shared curator AI-model access MVP surfaced in
// ShareProjectModal. The MVP is MEMBERSHIP-BASED: a curator toggles a single
// per-context-graph grant, and approved members inherit access. There is NO
// separate recipient-side acceptance flow — these tests pin that the UI never
// implies one.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

const removeParticipantMock = vi.fn();
const listParticipantsMock = vi.fn();
const fetchAgentsMock = vi.fn();
const listJoinRequestsMock = vi.fn();
const approveJoinRequestMock = vi.fn();
const rejectJoinRequestMock = vi.fn();
const getModelGrantMock = vi.fn();
const setModelShareMock = vi.fn();

vi.mock('../src/ui/api.js', async () => {
  const actual = await vi.importActual<any>('../src/ui/api.js');
  return {
    ...actual,
    removeParticipant: removeParticipantMock,
    listParticipants: listParticipantsMock,
    fetchAgents: fetchAgentsMock,
    listJoinRequests: listJoinRequestsMock,
    approveJoinRequest: approveJoinRequestMock,
    rejectJoinRequest: rejectJoinRequestMock,
    getModelGrant: getModelGrantMock,
    setModelShare: setModelShareMock,
  };
});

const CG = 'did:dkg:context-graph:test/cg';
const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function flush(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function render(element: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  await flush();
  mountedRoots.push(root);
  mountedContainers.push(container);
  return container;
}

let ShareProjectModal: any;

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  (globalThis as any).fetch = vi.fn(async () =>
    new Response(JSON.stringify({ peerId: '12D3KooWQAStub' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  );
  listParticipantsMock.mockResolvedValue({ allowedAgents: [] });
  fetchAgentsMock.mockResolvedValue({ agents: [] });
  listJoinRequestsMock.mockResolvedValue({ requests: [] });
  getModelGrantMock.mockResolvedValue({ contextGraphId: CG, enabled: false });
  setModelShareMock.mockResolvedValue({ ok: true, contextGraphId: CG, enabled: true });
  ({ ShareProjectModal } = await import('../src/ui/components/Modals/ShareProjectModal.js'));
});

afterEach(() => {
  while (mountedRoots.length > 0) {
    const root = mountedRoots.pop()!;
    const container = mountedContainers.pop()!;
    act(() => { root.unmount(); });
    container.remove();
  }
});

function modal(props: { open: boolean; onClose: () => void }) {
  return React.createElement(ShareProjectModal, {
    ...props, contextGraphId: CG, contextGraphName: 'Test CG',
  });
}
function checkbox(c: HTMLElement): HTMLInputElement {
  return c.querySelector('input[aria-label="Share curator AI model access with this context graph"]') as HTMLInputElement;
}

describe('ShareProjectModal — AI Model Access (MVP)', () => {
  it('renders the AI Model Access section with a share toggle', async () => {
    const c = await render(modal({ open: true, onClose: vi.fn() }));
    expect(c.textContent).toContain('AI Model Access');
    expect(checkbox(c)).toBeTruthy();
  });

  it('fetches the grant state on open', async () => {
    await render(modal({ open: true, onClose: vi.fn() }));
    expect(getModelGrantMock).toHaveBeenCalledWith(CG);
  });

  it('shows enabled state, the model id, and the membership note when sharing is on', async () => {
    getModelGrantMock.mockResolvedValue({ contextGraphId: CG, enabled: true, modelId: 'mock-model' });
    const c = await render(modal({ open: true, onClose: vi.fn() }));
    expect(checkbox(c).checked).toBe(true);
    expect(c.textContent).toContain('Current shared model: mock-model');
    expect(c.textContent).toContain('Approved members of this context graph will also get access to the curator AI model');
  });

  it('toggling on calls setModelShare with (cgId, true)', async () => {
    const c = await render(modal({ open: true, onClose: vi.fn() }));
    await act(async () => { checkbox(c).click(); });
    await flush();
    expect(setModelShareMock).toHaveBeenCalledWith(CG, true);
  });

  it('surfaces an error and reverts the toggle when saving fails', async () => {
    setModelShareMock.mockRejectedValue(new Error('save boom'));
    const c = await render(modal({ open: true, onClose: vi.fn() }));
    await act(async () => { checkbox(c).click(); });
    await flush();
    expect(c.textContent).toContain('save boom');
    expect(checkbox(c).checked).toBe(false); // reverted
  });

  it('fails closed (disabled, with notice) when the grant cannot be loaded', async () => {
    getModelGrantMock.mockRejectedValue(new Error('network down'));
    const c = await render(modal({ open: true, onClose: vi.fn() }));
    expect(checkbox(c).checked).toBe(false);
    expect(c.textContent).toContain('Could not load model sharing status.');
    expect(c.textContent).not.toContain('Approved members of this context graph will also get access');
  });

  it('uses membership language and never implies a separate recipient acceptance step', async () => {
    getModelGrantMock.mockResolvedValue({ contextGraphId: CG, enabled: true, modelId: 'mock-model' });
    const c = await render(modal({ open: true, onClose: vi.fn() }));
    const text = (c.textContent ?? '').toLowerCase();
    expect(text).toContain('inherit');
    expect(text).toContain('membership');
    // Must NOT misrepresent the MVP as consent/acceptance-gated on the recipient.
    expect(text).not.toMatch(/must accept/);
    expect(text).not.toMatch(/pending ai/);
    expect(text).not.toMatch(/accept ai (model )?access/);
    expect(text).not.toMatch(/request ai access/);
    expect(text).not.toMatch(/ai access request/);
  });
});
