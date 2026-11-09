// @vitest-environment happy-dom
// A row made pressable works from the keyboard: Enter or Space presses it once,
// Space doesn't scroll the page, and keys on controls inside it stay with them.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pressable } from '../src/ui/lib/pressable.js';
import { ImportFilesModal } from '../src/ui/components/Modals/ImportFilesModal.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
function render(el: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(el));
  return container;
}
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; vi.restoreAllMocks(); });

const key = (el: Element, k: string) => {
  const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  act(() => { el.dispatchEvent(event); });
  return event;
};

describe('pressable', () => {
  function Row({ onPress, onInner }: { onPress: () => void; onInner: () => void }) {
    return React.createElement('div', { 'data-testid': 'row', ...pressable(onPress) },
      'Operation',
      React.createElement('button', { 'data-testid': 'inner', onClick: onInner, onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation() }, 'Copy'),
      React.createElement('input', { 'data-testid': 'field' }));
  }

  it('joins the tab order', () => {
    const c = render(React.createElement(Row, { onPress: () => {}, onInner: () => {} }));
    expect(c.querySelector('[data-testid="row"]')?.getAttribute('tabindex')).toBe('0');
  });

  it('presses once on Enter and once on Space, and Space does not scroll', () => {
    const onPress = vi.fn();
    const c = render(React.createElement(Row, { onPress, onInner: () => {} }));
    const row = c.querySelector('[data-testid="row"]')!;
    const enter = key(row, 'Enter');
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(enter.defaultPrevented).toBe(true);
    const space = key(row, ' ');
    expect(onPress).toHaveBeenCalledTimes(2);
    expect(space.defaultPrevented).toBe(true);
  });

  it('ignores other keys', () => {
    const onPress = vi.fn();
    const c = render(React.createElement(Row, { onPress, onInner: () => {} }));
    const tab = key(c.querySelector('[data-testid="row"]')!, 'Tab');
    expect(onPress).not.toHaveBeenCalled();
    expect(tab.defaultPrevented).toBe(false);
  });

  it('leaves keys on nested controls alone, even when they bubble', () => {
    const onPress = vi.fn();
    const c = render(React.createElement(Row, { onPress, onInner: () => {} }));
    const field = c.querySelector('[data-testid="field"]')!;
    const space = key(field, ' ');
    key(field, 'Enter');
    expect(onPress).not.toHaveBeenCalled();
    expect(space.defaultPrevented).toBe(false);
  });

  it('still presses on a click', () => {
    const onPress = vi.fn();
    const c = render(React.createElement(Row, { onPress, onInner: () => {} }));
    act(() => { (c.querySelector('[data-testid="row"]') as HTMLElement).click(); });
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('a real consumer: the import file chooser', () => {
  it('opens the file picker once on Enter and on Space', () => {
    const pick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    render(React.createElement(ImportFilesModal, { open: true, onClose: () => {}, contextGraphId: 'cg' } as any));
    const zone = document.querySelector('[aria-label="Choose files to import"]')!;
    expect(zone).toBeTruthy();
    expect(zone.getAttribute('tabindex')).toBe('0');
    key(zone, 'Enter');
    expect(pick).toHaveBeenCalledTimes(1);
    const space = key(zone, ' ');
    expect(pick).toHaveBeenCalledTimes(2);
    expect(space.defaultPrevented).toBe(true);
  });
});
