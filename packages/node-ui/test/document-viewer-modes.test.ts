// @vitest-environment happy-dom
// The Formatted/Raw switch on an imported Markdown document: the shared
// segmented control (ds-seg), with aria-pressed as the only selection state.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/ui/api.js')>()),
  authHeaders: () => ({}),
  fileUrl: () => '/api/file/doc',
}));
vi.mock('../src/ui/components/chat/MarkdownMessage.js', () => ({
  MarkdownMessage: ({ content }: { content: string }) => React.createElement('div', { 'data-testid': 'markdown' }, content),
}));

import { DocumentViewer } from '../src/ui/components/Shell/PanelCenter.js';

const SOURCE = '# Hello\n\nSome *text*.';
let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

async function mount() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(SOURCE, { headers: { 'content-type': 'text/markdown' } })));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(React.createElement(DocumentViewer, { docRef: `urn:dkg:file:keccak256:${'a'.repeat(64)}`, contentType: 'text/markdown' }));
  });
  await vi.waitFor(() => expect(host!.querySelector('[aria-label="Document view mode"]')).not.toBeNull());
  return host;
}

const button = (el: HTMLElement, name: string) =>
  [...el.querySelectorAll<HTMLButtonElement>('[aria-label="Document view mode"] button')].find(b => b.textContent === name)!;

describe('DocumentViewer view modes', () => {
  it('uses the shared segmented control, with no state class of its own', async () => {
    const el = await mount();
    const group = el.querySelector('[aria-label="Document view mode"]')!;
    expect(group.classList.contains('ds-seg')).toBe(true);
    for (const b of group.querySelectorAll('button')) expect(b.className).toBe('ds-seg-item');
  });

  it('switching modes updates the content and aria-pressed', async () => {
    const el = await mount();
    expect(button(el, 'Formatted').getAttribute('aria-pressed')).toBe('true');
    expect(button(el, 'Raw').getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('[data-testid="markdown"]')?.textContent).toBe(SOURCE);
    expect(el.querySelector('pre')).toBeNull();

    await act(async () => { button(el, 'Raw').click(); });
    expect(button(el, 'Raw').getAttribute('aria-pressed')).toBe('true');
    expect(button(el, 'Formatted').getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('[data-testid="markdown"]')).toBeNull();
    expect(el.querySelector('pre')?.textContent).toBe(SOURCE);

    await act(async () => { button(el, 'Formatted').click(); });
    expect(button(el, 'Formatted').getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('[data-testid="markdown"]')?.textContent).toBe(SOURCE);
  });
});
