// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

// Mock the api surface JoinProjectModal pulls in so the modal renders
// without a live daemon. Most calls are happy-path stubs; the test
// only asserts a11y wiring on the open dialog.
const fetchContextGraphsMock = vi.fn();
const signJoinRequestMock = vi.fn();
const submitJoinRequestMock = vi.fn();
const fetchCurrentAgentMock = vi.fn();
const connectToPeerWithTimeoutMock = vi.fn();
const connectToPeerIdWithTimeoutMock = vi.fn();

vi.mock('../src/ui/api.js', async () => {
  const actual = await vi.importActual<any>('../src/ui/api.js');
  return {
    ...actual,
    fetchContextGraphs: fetchContextGraphsMock,
    signJoinRequest: signJoinRequestMock,
    submitJoinRequest: submitJoinRequestMock,
    fetchCurrentAgent: fetchCurrentAgentMock,
    connectToPeerWithTimeout: connectToPeerWithTimeoutMock,
    connectToPeerIdWithTimeout: connectToPeerIdWithTimeoutMock,
  };
});

vi.mock('../src/ui/components/Workspace/WireWorkspacePanel.js', () => ({
  WireWorkspacePanel: ({ contextGraphId }: { contextGraphId: string }) =>
    React.createElement('div', { 'data-testid': 'wire-workspace' }, contextGraphId),
}));

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function flush(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function renderModal(props: { open: boolean; onClose: () => void }) {
  const { JoinProjectModal } = await import('../src/ui/components/Modals/JoinProjectModal.js');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(JoinProjectModal, props));
  });
  await flush();
  mountedRoots.push(root);
  mountedContainers.push(container);
  return container;
}

describe('JoinProjectModal — BUG-017 a11y dismiss wiring', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    vi.clearAllMocks();
    (globalThis as any).EventSource = class {
      constructor(_url: string) {}
      addEventListener() {}
      removeEventListener() {}
      close() {}
      onopen = null;
      onmessage = null;
      onerror = null;
    };
    fetchContextGraphsMock.mockResolvedValue({ contextGraphs: [] });
    fetchCurrentAgentMock.mockResolvedValue({
      agentAddress: '0x00000000000000000000000000000000000000a1',
      agentDid: 'did:dkg:agent:0x00000000000000000000000000000000000000a1',
      name: 'Test',
      peerId: 'peer-x',
    });
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop()!;
      const container = mountedContainers.pop()!;
      act(() => { root.unmount(); });
      container.remove();
    }
  });

  it('renders nothing when open=false (modal is unmounted, no aria-hidden ghost on the page)', async () => {
    const container = await renderModal({ open: false, onClose: vi.fn() });
    expect(container.querySelector('[role="dialog"]')).toBe(null);
  });

  it('renders role="dialog" + aria-modal="true" + aria-labelledby pointing at the title', async () => {
    const container = await renderModal({ open: true, onClose: vi.fn() });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(dialog).toBeTruthy();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog?.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    // The labelled-by id must resolve to a real element so screen
    // readers can announce the dialog title.
    expect(container.querySelector(`#${labelledBy}`)).toBeTruthy();
  });

  it('exposes an explicit Close button with an aria-label (BUG-017 explicit dismiss control)', async () => {
    const container = await renderModal({ open: true, onClose: vi.fn() });
    const closeBtn = container.querySelector('button[aria-label*="Close"]') as HTMLButtonElement | null;
    expect(closeBtn).toBeTruthy();
    // The visible glyph is `×`; aria-label carries the descriptive copy.
    expect(closeBtn?.getAttribute('aria-label')).toMatch(/[Cc]lose/);
  });

  it('Escape key invokes onClose (useModalDismiss wiring)', async () => {
    const onClose = vi.fn();
    await renderModal({ open: true, onClose });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the explicit Close button invokes onClose', async () => {
    const onClose = vi.fn();
    const container = await renderModal({ open: true, onClose });
    const closeBtn = container.querySelector('button[aria-label*="Close"]') as HTMLButtonElement;
    await act(async () => {
      closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking inside the dialog body does NOT invoke onClose', async () => {
    // useModalDismiss.onBackdropClick is wired to the OVERLAY
    // (`.v10-modal-overlay`). It only fires onClose when
    // `event.target === event.currentTarget` — i.e. only when the
    // click landed on the overlay itself, not on a child. A click
    // inside the dialog bubbles up to the overlay's onClick, but the
    // target/currentTarget identity check filters it out.
    //
    // Backdrop dismissal (`onClose` called exactly once) is covered
    // by the dedicated test immediately below — kept separate so a
    // broken backdrop handler cannot hide behind this negative case.
    const onClose = vi.fn();
    const container = await renderModal({ open: true, onClose });
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).toBeTruthy();

    act(() => {
      dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clicking the backdrop overlay invokes onClose exactly once', async () => {
    // The dismissable backdrop is `.v10-modal-overlay`, which is the
    // dialog's parent in the rendered tree. Dispatching a bubbling
    // click directly on the overlay sends target === currentTarget
    // through React's synthetic event, so onBackdropClick fires.
    // This test pins the behaviour: backdrop dismissal IS wired (a
    // pre-rc.11 BUG-017 regression where Esc worked but the backdrop
    // didn't would re-fail this).
    const onClose = vi.fn();
    const container = await renderModal({ open: true, onClose });
    const overlay = container.querySelector('.v10-modal-overlay') as HTMLElement;
    expect(overlay).toBeTruthy();

    act(() => {
      overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
