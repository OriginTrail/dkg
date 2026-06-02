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

describe('ProjectHeaderStrip strip chrome from origin (Codex round-9 / 9-2)', () => {
  let root: Root;

  // A profile that resolves subgraph bindings by slug — so 9-2 can read the
  // ORIGIN subgraph's color + description from `forSubGraph(originSubGraph)`.
  const bindings: Record<string, any> = {
    demo: { slug: 'demo', displayName: 'Demo', color: '#aa0000', description: 'Demo description.' },
    other: { slug: 'other', displayName: 'Other', color: '#00bb00', description: 'Other description.' },
  };
  const chromeProfile = {
    displayName: 'Hello World',
    primaryColor: '#64748b',
    forSubGraph: (slug: string) => bindings[slug],
  } as any;

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
        cg, profile: chromeProfile,
        activeLayer: 'wm',
        activeSubGraph: null,
        detailLabel: null,
        onOverview: vi.fn(),
        onRestoreOrigin: vi.fn(),
        ...props,
      } as any));
    });
  }

  // After an M2(b) cross-subgraph follow (current = 'other', origin =
  // 'demo'), the strip tint + description + breadcrumb middle hop must all
  // name the ORIGIN ('demo'), not the followed-into 'other'.
  it('cross-subgraph follow: tint + description + breadcrumb all come from the ORIGIN', async () => {
    await render({
      activeLayer: 'wm',
      activeSubGraph: bindings.other, // current page = followed-into 'other'
      detailLabel: 'Entity B',
      originLayer: 'wm',
      originSubGraph: 'demo', // origin = where the detail opened
      originSubGraphDisplayName: 'Demo',
    });
    // Tint = origin color, NOT the followed-into one.
    expect(query('.v10-project-strip').style.getPropertyValue('--sg-color')).toBe('#aa0000');
    // Description = origin description.
    expect(query('.v10-project-strip-desc').textContent).toBe('Demo description.');
    // Breadcrumb middle hop also names the origin (8-2 + 9-2 share the gate).
    const hops = all('.v10-breadcrumb-hop');
    expect(hops[1].textContent).toBe('Demo');
    // The followed-into subgraph's chrome must NOT leak through.
    expect(query('.v10-project-strip').style.getPropertyValue('--sg-color')).not.toBe('#00bb00');
    expect(query('.v10-project-strip-desc').textContent).not.toBe('Other description.');
  });

  // No cross-follow: origin == current → no-op (chrome stays on current).
  it('no cross-follow (origin == current): chrome is a no-op (stays on current)', async () => {
    await render({
      activeLayer: 'wm',
      activeSubGraph: bindings.demo,
      detailLabel: 'Entity A',
      originLayer: 'wm',
      originSubGraph: 'demo',
      originSubGraphDisplayName: 'Demo',
    });
    expect(query('.v10-project-strip').style.getPropertyValue('--sg-color')).toBe('#aa0000');
    expect(query('.v10-project-strip-desc').textContent).toBe('Demo description.');
  });

  // Origin had NO subgraph (opened from overview / a non-subgraph layer):
  // chrome degrades to profile.primaryColor + cg.description.
  it('overview-origin: chrome falls back to primaryColor + cg.description', async () => {
    await render({
      activeLayer: 'wm',
      activeSubGraph: bindings.other, // followed into 'other'
      detailLabel: 'Entity B',
      originLayer: 'overview',
      originSubGraph: null, // origin had no subgraph
      originSubGraphDisplayName: null,
    });
    expect(query('.v10-project-strip').style.getPropertyValue('--sg-color')).toBe('#64748b'); // primaryColor
    expect(query('.v10-project-strip-desc').textContent).toBe('A demo graph.'); // cg.description
    // The followed-into 'other' chrome must NOT be used.
    expect(query('.v10-project-strip').style.getPropertyValue('--sg-color')).not.toBe('#00bb00');
  });

  // No detail open: chrome derives from the CURRENT activeSubGraph (the
  // pre-9-2 behaviour — unchanged when there's no detail / no origin).
  it('no detail open: chrome derives from the current activeSubGraph', async () => {
    await render({
      activeLayer: 'wm',
      activeSubGraph: bindings.other,
      detailLabel: null,
    });
    expect(query('.v10-project-strip').style.getPropertyValue('--sg-color')).toBe('#00bb00');
    expect(query('.v10-project-strip-desc').textContent).toBe('Other description.');
  });

  // Codex round-10 (10-1) — an UNPROFILED origin subgraph (forSubGraph
  // returns undefined) must NOT throw: the chrome degrades to
  // profile.primaryColor + cg.description and the breadcrumb still renders.
  // (ProjectView resolves the origin label with the same optional-chain +
  // slug fallback; here we exercise the ProjectHeaderStrip chrome path.)
  it('unprofiled origin subgraph: no throw, breadcrumb renders, chrome falls back', async () => {
    await expect(render({
      activeLayer: 'wm',
      activeSubGraph: bindings.demo,
      detailLabel: 'Entity X',
      originLayer: 'wm',
      originSubGraph: 'ghost',           // no binding → forSubGraph returns undefined
      originSubGraphDisplayName: 'ghost', // caller's slug-fallback name
    })).resolves.not.toThrow();
    // Breadcrumb rendered (didn't crash) — middle hop shows the slug.
    const hops = all('.v10-breadcrumb-hop');
    expect(hops.map(h => h.textContent)).toEqual(['Hello World', 'ghost', 'Entity X']);
    // Chrome degraded to profile/CG defaults (no color/description binding).
    expect(query('.v10-project-strip').style.getPropertyValue('--sg-color')).toBe('#64748b');
    expect(query('.v10-project-strip-desc').textContent).toBe('A demo graph.');
  });

  // Codex round-10 (10-2) — a detail opened from the OVERVIEW renders a
  // 2-hop breadcrumb whose FIRST hop is the sole back-affordance. It must be
  // a clickable button wired to onRestoreOrigin (origin restore), NOT
  // onOverview (fresh nav that drops scroll/tab).
  it('overview-opened detail: first hop is a button that restores the origin (not overview nav)', async () => {
    const onOverview = vi.fn();
    const onRestoreOrigin = vi.fn();
    await render({
      activeLayer: 'wm',
      activeSubGraph: null,
      detailLabel: 'Entity B',
      originLayer: 'overview',
      originSubGraph: null,
      originSubGraphDisplayName: null,
      onOverview,
      onRestoreOrigin,
    });
    const hops = all('.v10-breadcrumb-hop');
    // 2 hops, no middle.
    expect(hops.map(h => h.textContent)).toEqual(['Hello World', 'Entity B']);
    // First hop is a clickable BUTTON (not a current span).
    expect(hops[0].tagName).toBe('BUTTON');
    await act(async () => { hops[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // Restores the origin; does NOT fire a fresh overview nav.
    expect(onRestoreOrigin).toHaveBeenCalledTimes(1);
    expect(onOverview).not.toHaveBeenCalled();
  });
});
