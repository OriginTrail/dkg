// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyCall } from '../src/ui/components/Programs/ToolPicker.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const code = "const result = await invoke_tool('urn:dkg:tool:query', { queryId: 'approved-query' });";
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const execDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand');
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  else delete (navigator as any).clipboard;
  if (execDescriptor) Object.defineProperty(document, 'execCommand', execDescriptor);
  else delete (document as any).execCommand;
});
async function copy() {
  await act(async () => root.render(React.createElement(CopyCall, { code })));
  const button = container.querySelector('button')!; button.focus();
  await act(async () => button.click());
  return button;
}

describe('copying approved Program call examples', () => {
  it('uses the secure clipboard when available', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await copy();
    expect(writeText).toHaveBeenCalledExactlyOnceWith(code);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Copied');
  });

  it.each([true, false])('cleans up the HTTP fallback and restores focus when copy succeeds: %s', async succeeds => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    let captured = '';
    const execCommand = vi.fn((command: string) => {
      expect(command).toBe('copy');
      captured = document.querySelector('textarea')!.value;
      return succeeds;
    });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    const button = await copy();
    expect(execCommand).toHaveBeenCalledExactlyOnceWith('copy');
    expect(captured).toBe(code);
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe(succeeds ? 'Copied' : 'Select and copy the example below.');
    expect(container.querySelector('pre')?.textContent).toBe(code);
  });
});
