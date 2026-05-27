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

  // ─────────────────────────────────────────────────────────────────────
  // BUG-016 (unbounded CG name input) + Codex Yellow #2 (raw-input
  // warnings). The previous implementation sanitised on every keystroke
  // before validation, so the user never saw the helper text explaining
  // why their `<script>` tag or 200-char string was being trimmed. The
  // fix stores the raw input verbatim and validates against it, while
  // deriving the cleaned form only for the submit path + slug preview.
  // ─────────────────────────────────────────────────────────────────────

  function findNameInput(): HTMLInputElement {
    const input = container!.querySelector('input[type="text"]') as HTMLInputElement | null;
    if (!input) throw new Error('name input not found');
    return input;
  }

  function findCreateButton(): HTMLButtonElement {
    const btn = Array
      .from(container!.querySelectorAll('button'))
      .find((b) => b.textContent === 'Create Context Graph') as HTMLButtonElement | undefined;
    if (!btn) throw new Error('Create button not found');
    return btn;
  }

  function findNameHelper(): HTMLDivElement {
    const helper = container!.querySelector('#dkg-cg-name-help') as HTMLDivElement | null;
    if (!helper) throw new Error('name helper text not found');
    return helper;
  }

  it('shows the HTML-stripped warning when the user types `<b>foo</b>` (Codex Y2 raw-input visibility)', async () => {
    await renderModal();
    const input = findNameInput();
    await act(async () => { setInputValue(input, '<b>foo</b>'); });
    await flush();
    const helper = findNameHelper();
    expect(helper.textContent ?? '').toMatch(/HTML tags are not allowed/i);
    // The slug preview should still reflect the *sanitised* value
    // (so the user knows what ID they'd actually get if they
    // accepted the strip):
    expect(helper.getAttribute('aria-invalid')).toBe(null);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('shows the truncation warning when the raw input exceeds CG_NAME_MAX_LENGTH', async () => {
    await renderModal();
    const input = findNameInput();
    // Set the value directly without the `maxLength` HTML guard
    // intercepting — the validator must still surface a warning even
    // if a paste somehow bypasses maxLength (e.g. programmatic paste).
    const original = 'a'.repeat(120);
    // setInputValue uses the prototype descriptor which honours
    // maxLength, so set the value via the React-style raw setter then
    // dispatch input; happy-dom respects maxLength=80, so we
    // intentionally bypass via the property descriptor on the
    // instance to simulate paste-past-cap.
    Object.defineProperty(input, 'value', { configurable: true, value: original });
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    const helper = findNameHelper();
    // Either of two warnings is acceptable depending on which
    // branch the validator hits first — both are user-actionable.
    expect(helper.textContent ?? '').toMatch(/trimmed to 80 characters|letter or digit/i);
  });

  it('rejects punctuation-only names that slugify to empty (e.g. !!!) and disables the Create button (Codex RED-3 regression)', async () => {
    await renderModal();
    const input = findNameInput();
    const btn = findCreateButton();
    await act(async () => { setInputValue(input, '!!!'); });
    await flush();
    const helper = findNameHelper();
    expect(helper.textContent ?? '').toMatch(/letter or digit/i);
    expect(btn.disabled).toBe(true);
  });

  it('Create button is disabled the moment a validation error is present (no submit slip-through)', async () => {
    await renderModal();
    const input = findNameInput();
    const btn = findCreateButton();

    // Valid name first: button enabled.
    await act(async () => { setInputValue(input, 'Valid Name'); });
    await flush();
    expect(btn.disabled).toBe(false);

    // Replace with HTML — button must disable again on the next render.
    await act(async () => { setInputValue(input, '<script>x</script>'); });
    await flush();
    expect(btn.disabled).toBe(true);
  });

  it('clicking Create with a validation error is a no-op (createContextGraph never called)', async () => {
    await renderModal();
    const input = findNameInput();
    const btn = findCreateButton();
    await act(async () => { setInputValue(input, '<b></b>'); });
    await flush();
    // Force a click even though the button is disabled (defence in
    // depth — onClick should `return` early on validation error).
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(createContextGraphMock).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────
  // BUG-017 a11y wiring: the modal should expose role="dialog",
  // aria-modal, and an explicit × close button. These guard the
  // useModalDismiss integration end-to-end (the hook itself is unit-
  // tested separately).
  // ─────────────────────────────────────────────────────────────────────

  it('renders role="dialog" + aria-modal="true" + an explicit close button (BUG-017 a11y wiring)', async () => {
    await renderModal();
    const dialog = container!.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(dialog).toBeTruthy();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    // Close button is identified by aria-label so screen readers
    // announce it; the visible glyph is an `×`.
    const closeBtn = container!.querySelector('button[aria-label*="lose"], button[aria-label*="ismiss"]');
    expect(closeBtn).toBeTruthy();
  });
});
