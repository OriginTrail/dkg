// @vitest-environment happy-dom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubGraphExplorerHeader } from '../src/ui/views/project/components.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('SubGraphExplorerHeader — locked intro copy (UX §4.4.1 Issue D)', () => {
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

  // ux-lead's Issue D compromise (both axes). The pre-fix copy said
  // "one memory layer ... optionally, one subgraph" — Codex flagged
  // it as a data-model contradiction (`MemoryEntity.layers` and
  // `.subGraphs` are both Sets; the canonical "more than one" cases
  // are an entity in the WM→SWM promote window and an entity tagged
  // into multiple sub-graphs). The locked replacement covers both
  // axes so a future Codex sweep doesn't reopen either side.
  it('renders the locked "one or more" phrasing on both axes', () => {
    act(() => {
      root.render(React.createElement(SubGraphExplorerHeader));
    });
    const intro = container.querySelector('.v10-subgraph-explorer-intro');
    expect(intro).toBeTruthy();
    const text = intro!.textContent ?? '';
    expect(text).toContain('one or more memory layers');
    expect(text).toContain('one or more subgraphs');
    // The third sentence stays as the locked Root introduction.
    expect(text).toContain('Entities in no subgraph live in the context graph root.');
  });

  it('renders the locked page title', () => {
    act(() => {
      root.render(React.createElement(SubGraphExplorerHeader));
    });
    expect(container.querySelector('.v10-subgraph-explorer-title')?.textContent).toBe('Subgraph Explorer');
  });
});
