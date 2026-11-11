// @vitest-environment happy-dom
// The Core Node lines take their checks as rendered content through richCopy, in the
// copy's own order, with each mark named for screen readers.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckMark, richCopy } from '../src/ui/marketplace/shared.js';
import { copy } from '../src/ui/marketplace/copy.generated.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('richCopy', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (node: React.ReactNode) => act(() => { root.render(React.createElement('p', null, node)); });
  const marks = () => [...container.querySelectorAll('svg')].map((s) => s.getAttribute('aria-label'));

  it('puts a passed and a failed check where the copy places them', () => {
    render(richCopy('store.gate', {
      profile: React.createElement(CheckMark, { ok: true }),
      table: React.createElement(CheckMark, { ok: false }),
      stake: '50000', min: '50000', factor: '1',
    }));
    expect(marks()).toEqual(['yes', 'no']);
    expect(container.querySelector('svg.lucide-check')).toBeTruthy();
    expect(container.querySelector('svg.lucide-x')).toBeTruthy();
    // The words around the marks are the copy's, with the text parameters filled in.
    expect(container.textContent).toBe(copy('store.gate', { profile: '', table: '', stake: '50000', min: '50000', factor: '1' }));
    expect(container.textContent).not.toMatch(/[✓✗{}]/);
  });

  it('reads the other way round when the profile fails and the table passes', () => {
    render(richCopy('operate.gate', {
      profile: React.createElement(CheckMark, { ok: false }),
      table: React.createElement(CheckMark, { ok: true }),
      stake: '1', min: '2', proved: copy('operate.proved.not'),
    }));
    expect(marks()).toEqual(['no', 'yes']);
    expect(container.textContent).toContain(copy('operate.proved.not'));
  });

  it('leaves a placeholder without a parameter as written, as copy does', () => {
    render(richCopy('store.gate', { profile: 'a' }));
    expect(container.textContent).toContain('{table}');
  });
});
