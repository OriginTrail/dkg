// @vitest-environment happy-dom

// Regression coverage for #959. Three modals — Import (ImportFilesModal),
// Share (ShareProjectModal) and File Preview (FilePreviewModal) — used to
// hand-roll their overlays with only a backdrop-click handler: Esc did
// nothing and they weren't focus-trapped, unlike Create/Join (which the
// sibling `join-project-modal.a11y.test.ts` pins). All three now use the
// shared `useModalDismiss` hook. This file asserts the same BUG-017 a11y
// dimensions for each. File Preview in particular is unreachable from the
// devnet e2e (no uploaded document is seeded), so this is its only
// regression net.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

// One mock surface covering every api.js export the three modals pull in.
const importFileMock = vi.fn();
const removeParticipantMock = vi.fn();
const listParticipantsMock = vi.fn();
const fetchAgentsMock = vi.fn();
const listJoinRequestsMock = vi.fn();
const approveJoinRequestMock = vi.fn();
const rejectJoinRequestMock = vi.fn();
const fetchExtractionStatusMock = vi.fn();

vi.mock('../src/ui/api.js', async () => {
  const actual = await vi.importActual<any>('../src/ui/api.js');
  return {
    ...actual,
    importFile: importFileMock,
    removeParticipant: removeParticipantMock,
    listParticipants: listParticipantsMock,
    fetchAgents: fetchAgentsMock,
    listJoinRequests: listJoinRequestsMock,
    approveJoinRequest: approveJoinRequestMock,
    rejectJoinRequest: rejectJoinRequestMock,
    fetchExtractionStatus: fetchExtractionStatusMock,
  };
});

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function flush(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

async function render(element: React.ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await flush();
  mountedRoots.push(root);
  mountedContainers.push(container);
  return container;
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  // ShareProjectModal hits `fetch('/api/status')` on open.
  (globalThis as any).fetch = vi.fn(async () =>
    new Response(JSON.stringify({ peerId: '12D3KooWQAStub' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  listParticipantsMock.mockResolvedValue({ allowedAgents: [] });
  fetchAgentsMock.mockResolvedValue({ agents: [] });
  listJoinRequestsMock.mockResolvedValue({ requests: [] });
  // FilePreview's open effect — reject so it renders the error branch
  // (the dialog chrome + × button + Esc wiring render regardless of the
  // file-fetch outcome, which is all this suite asserts).
  fetchExtractionStatusMock.mockRejectedValue(new Error('no file in test'));
});

afterEach(() => {
  while (mountedRoots.length > 0) {
    const root = mountedRoots.pop()!;
    const container = mountedContainers.pop()!;
    act(() => { root.unmount(); });
    container.remove();
  }
});

/**
 * Shared assertion battery — the four BUG-017 dimensions every dismissable
 * modal must satisfy once it adopts `useModalDismiss`.
 */
function sharedDismissContract(
  label: string,
  makeElement: (props: { open: boolean; onClose: () => void }) => React.ReactElement,
) {
  describe(label, () => {
    it('renders role="dialog" + aria-modal + aria-labelledby resolving to the title', async () => {
      const container = await render(makeElement({ open: true, onClose: vi.fn() }));
      const dialog = container.querySelector('[role="dialog"]') as HTMLElement | null;
      expect(dialog).toBeTruthy();
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
      const labelledBy = dialog?.getAttribute('aria-labelledby');
      expect(labelledBy).toBeTruthy();
      expect(container.querySelector(`#${labelledBy}`)).toBeTruthy();
    });

    it('exposes an explicit × Close button with an aria-label', async () => {
      const container = await render(makeElement({ open: true, onClose: vi.fn() }));
      const closeBtn = container.querySelector('button[aria-label*="Close"]') as HTMLButtonElement | null;
      expect(closeBtn).toBeTruthy();
      expect(closeBtn?.getAttribute('aria-label')).toMatch(/[Cc]lose/);
    });

    it('Escape invokes onClose (the #959 fix)', async () => {
      const onClose = vi.fn();
      await render(makeElement({ open: true, onClose }));
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('clicking the × Close button invokes onClose', async () => {
      const onClose = vi.fn();
      const container = await render(makeElement({ open: true, onClose }));
      const closeBtn = container.querySelector('button[aria-label*="Close"]') as HTMLButtonElement;
      await act(async () => {
        closeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('clicking the backdrop overlay invokes onClose exactly once', async () => {
      const onClose = vi.fn();
      const container = await render(makeElement({ open: true, onClose }));
      const overlay = container.querySelector('.v10-modal-overlay') as HTMLElement;
      expect(overlay).toBeTruthy();
      act(() => {
        overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('clicking inside the dialog body does NOT invoke onClose', async () => {
      const onClose = vi.fn();
      const container = await render(makeElement({ open: true, onClose }));
      const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
      act(() => {
        dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(onClose).not.toHaveBeenCalled();
    });
  });
}

let ImportFilesModal: any;
let ShareProjectModal: any;
let FilePreviewModal: any;

beforeEach(async () => {
  ({ ImportFilesModal } = await import('../src/ui/components/Modals/ImportFilesModal.js'));
  ({ ShareProjectModal } = await import('../src/ui/components/Modals/ShareProjectModal.js'));
  ({ FilePreviewModal } = await import('../src/ui/components/Modals/FilePreviewModal.js'));
});

sharedDismissContract('ImportFilesModal — #959 Esc/focus dismiss wiring', ({ open, onClose }) =>
  React.createElement(ImportFilesModal, {
    open,
    onClose,
    contextGraphId: 'did:dkg:context-graph:test/cg',
    contextGraphName: 'Test CG',
  }),
);

sharedDismissContract('ShareProjectModal — #959 Esc/focus dismiss wiring', ({ open, onClose }) =>
  React.createElement(ShareProjectModal, {
    open,
    onClose,
    contextGraphId: 'did:dkg:context-graph:test/cg',
    contextGraphName: 'Test CG',
  }),
);

sharedDismissContract('FilePreviewModal — #959 Esc/focus dismiss wiring', ({ open, onClose }) =>
  React.createElement(FilePreviewModal, {
    open,
    onClose,
    assertionName: 'doc-1',
    contextGraphId: 'did:dkg:context-graph:test/cg',
  }),
);

// Codex review follow-up: a modal can transiently have EVERY control
// disabled (e.g. ImportFilesModal while an upload is in flight — both the
// header × and the footer action go disabled). `useModalDismiss` used to
// only focus tabbable children, so in that state focus stayed on the
// background page even though the dialog advertises aria-modal="true". The
// hook now falls back to focusing the dialog container itself.
describe('useModalDismiss — focus fallback when no enabled control', () => {
  it('focuses the dialog itself (tabindex=-1) when every descendant is disabled', async () => {
    const { useModalDismiss } = await import('../src/ui/components/Modals/useModalDismiss.js');
    function Harness() {
      const { dialogRef, onBackdropClick } = useModalDismiss(true, () => {});
      return React.createElement(
        'div',
        { className: 'v10-modal-overlay', onClick: onBackdropClick, role: 'presentation' },
        React.createElement(
          'div',
          {
            className: 'v10-modal-box',
            ref: dialogRef,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'harness-title',
          },
          React.createElement('div', { id: 'harness-title' }, 'Uploading…'),
          React.createElement('button', { type: 'button', disabled: true, 'aria-label': 'Close' }, '×'),
        ),
      );
    }
    const container = await render(React.createElement(Harness));
    await flush();
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(dialog);
  });
});
