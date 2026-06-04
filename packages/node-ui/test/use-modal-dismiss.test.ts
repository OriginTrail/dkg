// @vitest-environment happy-dom

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

import { useModalDismiss } from '../src/ui/components/Modals/useModalDismiss.js';

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

interface HostProps {
  open: boolean;
  onClose: () => void;
  /** Optional override so individual tests can swap the focusable mix. */
  children?: React.ReactNode;
}

function ModalHost({ open, onClose, children }: HostProps) {
  const { dialogRef, onBackdropClick } = useModalDismiss(open, onClose);
  if (!open) return null;
  return React.createElement(
    'div',
    {
      'data-testid': 'backdrop',
      onClick: onBackdropClick,
      role: 'presentation',
    },
    React.createElement(
      'div',
      {
        ref: dialogRef,
        role: 'dialog',
        'aria-modal': 'true',
      },
      children ?? React.createElement('button', { id: 'first' }, 'First'),
    ),
  );
}

function mount(open: boolean, onClose: () => void, children?: React.ReactNode): void {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(ModalHost, { open, onClose, children }));
  });
  mountedRoots.push(root);
  mountedContainers.push(container);
}

function rerender(open: boolean, onClose: () => void, children?: React.ReactNode): void {
  const root = mountedRoots[mountedRoots.length - 1];
  act(() => {
    root.render(React.createElement(ModalHost, { open, onClose, children }));
  });
}

async function tick(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

describe('useModalDismiss (BUG-017)', () => {
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    while (mountedRoots.length > 0) {
      const root = mountedRoots.pop()!;
      const container = mountedContainers.pop()!;
      act(() => { root.unmount(); });
      container.remove();
    }
  });

  it('Escape key invokes onClose while open', () => {
    const onClose = vi.fn();
    mount(true, onClose);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape is a no-op when open=false (listener is detached)', () => {
    const onClose = vi.fn();
    mount(false, onClose);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('clicking the backdrop calls onClose; clicking inside the dialog does NOT', () => {
    const onClose = vi.fn();
    mount(true, onClose);

    const backdrop = document.querySelector('[data-testid="backdrop"]') as HTMLElement;
    const dialog = backdrop.querySelector('[role="dialog"]') as HTMLElement;

    // Click *inside* the dialog (event.target !== event.currentTarget)
    act(() => { dialog.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).not.toHaveBeenCalled();

    // Click the backdrop directly
    act(() => { backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('restores focus to the previously-focused element on close (a11y restoration)', async () => {
    const opener = document.createElement('button');
    opener.id = 'opener';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const onClose = vi.fn();
    mount(true, onClose);
    await tick();

    // Closing the modal (open: false) should fire the cleanup which
    // returns focus to the opener.
    rerender(false, onClose);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('focus trap: pressing Shift+Tab on the FIRST focusable wraps to the LAST', async () => {
    const onClose = vi.fn();
    mount(true, onClose, [
      React.createElement('button', { key: 'a', id: 'b-first' }, 'A'),
      React.createElement('button', { key: 'b', id: 'b-mid' }, 'B'),
      React.createElement('button', { key: 'c', id: 'b-last' }, 'C'),
    ]);
    await tick();
    const first = document.getElementById('b-first') as HTMLElement;
    const last = document.getElementById('b-last') as HTMLElement;
    first.focus();
    expect(document.activeElement).toBe(first);

    const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    // The hook calls preventDefault and focuses `last` manually
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it('focus trap: pressing Tab on the LAST focusable wraps to the FIRST', async () => {
    const onClose = vi.fn();
    mount(true, onClose, [
      React.createElement('button', { key: 'a', id: 't-first' }, 'A'),
      React.createElement('button', { key: 'b', id: 't-mid' }, 'B'),
      React.createElement('button', { key: 'c', id: 't-last' }, 'C'),
    ]);
    await tick();
    const first = document.getElementById('t-first') as HTMLElement;
    const last = document.getElementById('t-last') as HTMLElement;
    last.focus();
    expect(document.activeElement).toBe(last);

    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it('Tab in the middle of the focus list is NOT intercepted (browser handles natural progression)', async () => {
    const onClose = vi.fn();
    mount(true, onClose, [
      React.createElement('button', { key: 'a', id: 'm-first' }, 'A'),
      React.createElement('button', { key: 'b', id: 'm-mid' }, 'B'),
      React.createElement('button', { key: 'c', id: 'm-last' }, 'C'),
    ]);
    await tick();
    const mid = document.getElementById('m-mid') as HTMLElement;
    mid.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    // The hook only intercepts when focus is on first/last edge —
    // mid-Tab keeps `preventDefault` false so the browser handles it.
    expect(ev.defaultPrevented).toBe(false);
  });

  it('prefers an [autofocus] element over the first focusable when moving initial focus', async () => {
    // The hook reads the literal HTML attribute via
    // `dialog.querySelector('[autofocus]')` (not React's autoFocus
    // prop, which never serialises to an attribute). We render the
    // attribute via JSX spread so the DOM actually carries it.
    const onClose = vi.fn();
    mount(true, onClose, [
      React.createElement('button', { key: 'a', id: 'af-first' }, 'A'),
      React.createElement('input', {
        key: 'b',
        id: 'af-target',
        defaultValue: '',
        // Use the attribute form so the matching selector fires.
        ...({ autofocus: '' } as Record<string, string>),
      }),
      React.createElement('button', { key: 'c', id: 'af-last' }, 'C'),
    ]);
    await tick();
    expect(document.activeElement?.id).toBe('af-target');
  });

  it('traps Tab inside an aria-modal dialog with zero focusables (focus pinned to the dialog)', async () => {
    // Previously this asserted Tab was a no-op, but that let a keyboard
    // user Tab straight OUT of an aria-modal dialog into the background
    // page when nothing inside was tabbable (e.g. ImportFilesModal while
    // an upload is in flight disables every control). Codex review: an
    // aria-modal dialog must keep focus contained. The hook now makes the
    // dialog container focusable (tabindex=-1), pins focus on it, and
    // swallows Tab so it can't escape.
    const onClose = vi.fn();
    mount(true, onClose, React.createElement('p', null, 'No focusables'));
    await tick();
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(dialog);
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    expect(() => window.dispatchEvent(ev)).not.toThrow();
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
  });

  it('uses capture phase so Escape inside a child <input> still closes the dialog (BUG-017 regression guard)', async () => {
    const onClose = vi.fn();
    mount(true, onClose, React.createElement('input', { id: 'inside-input', defaultValue: '' }));
    await tick();
    const input = document.getElementById('inside-input') as HTMLInputElement;
    input.focus();

    // Dispatch via input so the event starts at the input target. The
    // hook listens at the window level with capture=true so Escape
    // reaches the handler before any input keybinding could swallow
    // it.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalled();
  });
});
