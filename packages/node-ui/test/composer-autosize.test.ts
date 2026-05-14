// @vitest-environment happy-dom
//
// Covers PR2 composer keybindings + autosize wiring on `<TextareaAutosize>`.
// Specifically: IME guard, Enter to send, Ctrl+Enter send-with-attachments,
// Escape clears, and the `minRows={1} maxRows={8}` props are wired through.

import React, { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';

// Capture the props PanelRight passes to react-textarea-autosize so we can
// assert the `minRows={1}` / `maxRows={8}` contract without relying on
// happy-dom layout (which won't run the library's measurement effect).
const textareaAutosizeProps: Array<Record<string, unknown>> = [];
vi.mock('react-textarea-autosize', () => {
  const forwardRef = React.forwardRef;
  const MockTextareaAutosize = forwardRef<HTMLTextAreaElement, any>((props, ref) => {
    textareaAutosizeProps.push({ ...props });
    const { minRows, maxRows, cacheMeasurements, ...rest } = props;
    return React.createElement('textarea', { ...rest, ref });
  });
  return { __esModule: true, default: MockTextareaAutosize };
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

function noop() {}

async function renderTab(
  overrides: Record<string, unknown>,
): Promise<{ container: HTMLDivElement; unmount: () => Promise<void> }> {
  const { ConnectedAgentsTab } = await import('../src/ui/components/Shell/PanelRight.js');

  const props: Record<string, unknown> = {
    integrations: [integration()],
    selectedIntegrationId: 'openclaw',
    selectedIntegration: integration(),
    selectedSessionId: 'openclaw:default',
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
    onSelectProject: noop,
    attachments: [],
    onAddAttachments: noop,
    onRemoveAttachment: noop,
    ...overrides,
  };

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(React.createElement(ConnectedAgentsTab, props as any));
  });

  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function getTextarea(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector('textarea.v10-agent-input') as HTMLTextAreaElement | null;
  if (!el) throw new Error('Expected .v10-agent-input textarea to be rendered');
  return el;
}

function getSendButton(container: HTMLElement): HTMLButtonElement {
  const el = container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement | null;
  if (!el) throw new Error('Expected Send button (aria-label="Send message") to be rendered');
  return el;
}

function pressKey(
  el: HTMLElement,
  init: KeyboardEventInit & { isComposing?: boolean },
): void {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (init.isComposing) {
    // happy-dom honours `isComposing` on the synthetic event when set as
    // a non-enumerable own prop on the underlying event object.
    Object.defineProperty(event, 'isComposing', { value: true });
  }
  el.dispatchEvent(event);
}

describe('Composer keybindings + autosize wiring', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
  });

  it('renders the TextareaAutosize element with the composer class, current value, and forwards minRows=1/maxRows=8', async () => {
    textareaAutosizeProps.length = 0;
    const { container, unmount } = await renderTab({ localInput: 'draft text' });
    const textarea = getTextarea(container);
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.classList.contains('v10-agent-input')).toBe(true);
    expect(textarea.value).toBe('draft text');
    // The autosize contract: minRows=1 (composer starts single-line) and
    // maxRows=8 (then internal scroll). Assert via the mocked library so
    // the check survives happy-dom (no layout) and doesn't depend on
    // brittle DOM attributes that the real library doesn't forward.
    expect(textareaAutosizeProps.length).toBeGreaterThanOrEqual(1);
    const lastProps = textareaAutosizeProps[textareaAutosizeProps.length - 1];
    expect(lastProps.minRows).toBe(1);
    expect(lastProps.maxRows).toBe(8);
    await unmount();
  });

  it('Enter (no modifier) calls onSendLocalMessage', async () => {
    const onSendLocalMessage = vi.fn();
    const { container, unmount } = await renderTab({
      localInput: 'hello',
      onSendLocalMessage,
    });
    const textarea = getTextarea(container);

    await act(async () => {
      pressKey(textarea, { key: 'Enter' });
    });
    expect(onSendLocalMessage).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('Shift+Enter does NOT send (newline allowed)', async () => {
    const onSendLocalMessage = vi.fn();
    const { container, unmount } = await renderTab({
      localInput: 'hello',
      onSendLocalMessage,
    });
    const textarea = getTextarea(container);

    await act(async () => {
      pressKey(textarea, { key: 'Enter', shiftKey: true });
    });
    expect(onSendLocalMessage).not.toHaveBeenCalled();
    await unmount();
  });

  it('IME composition guard: Enter while isComposing does NOT send', async () => {
    const onSendLocalMessage = vi.fn();
    const { container, unmount } = await renderTab({
      localInput: 'こんにちは',
      onSendLocalMessage,
    });
    const textarea = getTextarea(container);

    await act(async () => {
      pressKey(textarea, { key: 'Enter', isComposing: true });
    });
    expect(onSendLocalMessage).not.toHaveBeenCalled();
    await unmount();
  });

  it('Ctrl+Enter sends when attachments are queued even if text is empty', async () => {
    const onSendLocalMessage = vi.fn();
    const file = new File(['hello'], 'spec.md', { type: 'text/markdown' });
    const { container, unmount } = await renderTab({
      localInput: '',
      onSendLocalMessage,
      attachments: [{
        id: 'draft-1',
        file,
        contextGraphId: 'testing',
        assertionName: 'spec',
        status: 'queued',
      }],
    });
    const textarea = getTextarea(container);

    await act(async () => {
      pressKey(textarea, { key: 'Enter', ctrlKey: true });
    });
    expect(onSendLocalMessage).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('Cmd+Enter (metaKey) also force-sends with attachments-only', async () => {
    const onSendLocalMessage = vi.fn();
    const file = new File(['hello'], 'spec.md', { type: 'text/markdown' });
    const { container, unmount } = await renderTab({
      localInput: '',
      onSendLocalMessage,
      attachments: [{
        id: 'draft-1',
        file,
        contextGraphId: 'testing',
        assertionName: 'spec',
        status: 'queued',
      }],
    });
    const textarea = getTextarea(container);

    await act(async () => {
      pressKey(textarea, { key: 'Enter', metaKey: true });
    });
    expect(onSendLocalMessage).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('Ctrl+Enter does NOT send when no text and no attachments', async () => {
    const onSendLocalMessage = vi.fn();
    const { container, unmount } = await renderTab({
      localInput: '   ',
      onSendLocalMessage,
      attachments: [],
    });
    const textarea = getTextarea(container);

    await act(async () => {
      pressKey(textarea, { key: 'Enter', ctrlKey: true });
    });
    expect(onSendLocalMessage).not.toHaveBeenCalled();
    await unmount();
  });

  it('plain Enter does NOT send when input is empty and no attachments', async () => {
    // The send button gates on `inputDisabled || (!localInput.trim() && !hasSendableAttachmentDrafts)`.
    // Plain Enter must mirror that gate — otherwise pressing Enter on an
    // empty composer would fire `onSendLocalMessage()` even though the
    // visible affordance (the button) is disabled.
    const onSendLocalMessage = vi.fn();
    const { container, unmount } = await renderTab({
      localInput: '   ',
      onSendLocalMessage,
      attachments: [],
    });
    const textarea = getTextarea(container);

    await act(async () => {
      pressKey(textarea, { key: 'Enter' });
    });
    expect(onSendLocalMessage).not.toHaveBeenCalled();
    await unmount();
  });

  it('plain Enter sends when text is empty but attachments are queued', async () => {
    const onSendLocalMessage = vi.fn();
    const file = new File(['hello'], 'spec.md', { type: 'text/markdown' });
    const { container, unmount } = await renderTab({
      localInput: '',
      onSendLocalMessage,
      attachments: [{
        id: 'draft-1',
        file,
        contextGraphId: 'testing',
        assertionName: 'spec',
        status: 'queued',
      }],
    });
    const textarea = getTextarea(container);

    await act(async () => {
      pressKey(textarea, { key: 'Enter' });
    });
    expect(onSendLocalMessage).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('Escape on a populated composer calls onLocalInputChange("")', async () => {
    const onLocalInputChange = vi.fn();
    const { container, unmount } = await renderTab({
      localInput: 'draft',
      onLocalInputChange,
    });
    const textarea = getTextarea(container);

    await act(async () => {
      pressKey(textarea, { key: 'Escape' });
    });
    expect(onLocalInputChange).toHaveBeenCalledWith('');
    await unmount();
  });

  it('Escape on an empty composer is a no-op', async () => {
    const onLocalInputChange = vi.fn();
    const { container, unmount } = await renderTab({
      localInput: '',
      onLocalInputChange,
    });
    const textarea = getTextarea(container);

    await act(async () => {
      pressKey(textarea, { key: 'Escape' });
    });
    expect(onLocalInputChange).not.toHaveBeenCalled();
    await unmount();
  });

  it('Send button is disabled with empty text and no attachments', async () => {
    const { container, unmount } = await renderTab({
      localInput: '',
      attachments: [],
    });
    const send = getSendButton(container);
    expect(send.disabled).toBe(true);
    await unmount();
  });

  it('Send button is enabled with attachments-only (no text)', async () => {
    const file = new File(['x'], 'spec.md', { type: 'text/markdown' });
    const { container, unmount } = await renderTab({
      localInput: '',
      attachments: [{
        id: 'draft-1',
        file,
        contextGraphId: 'testing',
        assertionName: 'spec',
        status: 'queued',
      }],
    });
    const send = getSendButton(container);
    expect(send.disabled).toBe(false);
    await unmount();
  });

  it('Send button click invokes onSendLocalMessage', async () => {
    const onSendLocalMessage = vi.fn();
    const { container, unmount } = await renderTab({
      localInput: 'hi',
      onSendLocalMessage,
    });
    const send = getSendButton(container);
    await act(async () => {
      send.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSendLocalMessage).toHaveBeenCalledTimes(1);
    await unmount();
  });
});
