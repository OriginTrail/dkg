// @vitest-environment happy-dom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectHeaderStrip } from '../src/ui/views/project/components.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// S5 — DOM tests for the breadcrumb in ProjectHeaderStrip (T11 / T12)
// plus the T13 grep guard that the old back-affordance is gone.

const profile = {
  displayName: 'Hello World',
  primaryColor: '#64748b',
} as any;

const cg = { id: 'cg-test', name: 'Hello World', description: 'A demo graph.' };

function query(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`Missing element ${selector}`);
  return el;
}
function all(selector: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)];
}

describe('ProjectHeaderStrip breadcrumb', () => {
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    root = createRoot(query('#root'));
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  async function render(props: Partial<React.ComponentProps<typeof ProjectHeaderStrip>>) {
    await act(async () => {
      root.render(React.createElement(ProjectHeaderStrip, {
        cg, profile,
        activeLayer: 'overview',
        activeSubGraph: null,
        detailLabel: null,
        onOverview: vi.fn(),
        onRestoreOrigin: vi.fn(),
        ...props,
      } as any));
    });
  }

  it('renders Context Graph › Layer with the layer as the trailing current hop (T12)', async () => {
    await render({ activeLayer: 'wm' });
    const hops = all('.v10-breadcrumb-hop');
    expect(hops.map(h => h.textContent)).toEqual(['Hello World', 'Working Memory']);
    // First hop is a clickable link button; trailing hop is a span.
    expect(hops[0].tagName).toBe('BUTTON');
    expect(hops[0].classList.contains('link')).toBe(true);
    expect(hops[1].tagName).toBe('SPAN');
    expect(hops[1].classList.contains('current')).toBe(true);
    expect(hops[1].getAttribute('aria-current')).toBe('page');
  });

  it('non-trailing hops are clickable and fire the right handler (T12)', async () => {
    const onOverview = vi.fn();
    const onRestoreOrigin = vi.fn();
    await render({ activeLayer: 'wm', detailLabel: 'Battery cell 003', onOverview, onRestoreOrigin });
    const hops = all('.v10-breadcrumb-hop');
    expect(hops.map(h => h.textContent)).toEqual(['Hello World', 'Working Memory', 'Battery cell 003']);

    // First hop → overview.
    await act(async () => { hops[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onOverview).toHaveBeenCalledTimes(1);

    // Middle hop (link → origin restore).
    expect(hops[1].tagName).toBe('BUTTON');
    await act(async () => { hops[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onRestoreOrigin).toHaveBeenCalledTimes(1);

    // Trailing hop is a non-interactive span (no button).
    expect(hops[2].tagName).toBe('SPAN');
  });

  it('every hop carries an unconditional title tooltip (T11 overflow affordance)', async () => {
    const longName = 'x'.repeat(200);
    await render({
      activeLayer: 'wm',
      activeSubGraph: { slug: 'demo', displayName: longName, color: '#38bdf8' } as any,
      detailLabel: longName,
    });
    const hops = all('.v10-breadcrumb-hop');
    expect(hops.every(h => (h.getAttribute('title') ?? '').length > 0)).toBe(true);
    // The middle (subgraph) + trailing hops carry the truncation CSS
    // (max-width + ellipsis); the title preserves the full text.
    const middle = hops[1];
    expect(middle.getAttribute('title')).toBe(longName);
  });

  it('the subgraph displayName is the middle hop, never the layer name (T12 hop rule)', async () => {
    await render({
      activeLayer: 'wm',
      activeSubGraph: { slug: 'demo', displayName: 'Demo Subgraph', color: '#38bdf8' } as any,
    });
    const labels = all('.v10-breadcrumb-hop').map(h => h.textContent);
    expect(labels).toEqual(['Hello World', 'Demo Subgraph']);
    expect(labels).not.toContain('Working Memory');
  });

  it('reuses the existing .v10-project-strip-sep separator between hops', async () => {
    await render({ activeLayer: 'wm', detailLabel: 'E' });
    // 3 hops → 2 separators.
    expect(all('.v10-project-strip-sep')).toHaveLength(2);
  });
});
