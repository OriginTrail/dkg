// @vitest-environment happy-dom

// RC.17 UI bug: the "What is a Context Graph?" primer took over the center
// pane as a closable tab, but the only way out was the easy-to-miss "×" in
// the tab strip — the pane itself had no Back affordance and ignored Escape,
// so users got stuck and had to re-click the originating CG tab. The primer
// now renders an explicit "← Back" button and listens for Escape; both close
// the primer tab, which the tabs store auto-resolves to the previously active
// tab. This file pins both affordances.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { ContextGraphPrimerView } from '../src/ui/views/ContextGraphPrimerView.js';
import { useTabsStore } from '../src/ui/stores/tabs.js';
import { CONTEXT_GRAPH_PRIMER_TAB_ID } from '../src/ui/lib/contextGraphPrimer.js';

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(React.createElement(ContextGraphPrimerView));
  });
  return container;
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  // Open the primer on top of a project tab so closing it resolves back to
  // the project — the real navigation the user expects.
  useTabsStore.setState({
    tabs: [
      { id: 'dashboard', label: 'Dashboard', closable: false },
      { id: 'project:cg', label: 'My CG', closable: true },
      { id: CONTEXT_GRAPH_PRIMER_TAB_ID, label: 'What is a Context Graph?', closable: true },
    ],
    activeTabId: CONTEXT_GRAPH_PRIMER_TAB_ID,
  });
});

afterEach(() => {
  if (root) act(() => { root!.unmount(); });
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = '';
});

describe('ContextGraphPrimerView — Back + Escape dismissal', () => {
  it('renders an explicit Back button with an aria-label', async () => {
    const c = await render();
    const back = c.querySelector('button.v10-primer-back') as HTMLButtonElement | null;
    expect(back).toBeTruthy();
    expect(back?.getAttribute('aria-label')).toMatch(/[Cc]lose|[Bb]ack/);
  });

  it('clicking Back closes the primer tab and returns to the previous tab', async () => {
    const c = await render();
    const back = c.querySelector('button.v10-primer-back') as HTMLButtonElement;
    await act(async () => {
      back.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const state = useTabsStore.getState();
    expect(state.tabs.some(t => t.id === CONTEXT_GRAPH_PRIMER_TAB_ID)).toBe(false);
    expect(state.activeTabId).toBe('project:cg');
  });

  it('pressing Escape closes the primer tab', async () => {
    await render();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    const state = useTabsStore.getState();
    expect(state.tabs.some(t => t.id === CONTEXT_GRAPH_PRIMER_TAB_ID)).toBe(false);
    expect(state.activeTabId).toBe('project:cg');
  });

  it('removes the Escape listener on unmount (no dangling handler)', async () => {
    await render();
    act(() => { root!.unmount(); });
    root = null;
    // After unmount the primer tab is still open; a stray Escape handler would
    // close it. With proper cleanup the tab survives.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useTabsStore.getState().tabs.some(t => t.id === CONTEXT_GRAPH_PRIMER_TAB_ID)).toBe(true);
  });
});
