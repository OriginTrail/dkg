// @vitest-environment happy-dom
//
// The design-system reference page (dev only, see DESIGN.md) renders every
// token and primitive from the real components. This keeps it rendering:
// a broken primitive or a removed token shows up here, not when someone next
// opens the page.
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STATES } from '../src/ui/design-system-states.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const root = () => document.getElementById('root')!;
const sections = () => [...root().querySelectorAll('section.dsp-section h2')].map(h => h.textContent);
const buttons = (selector: string) => [...root().querySelectorAll<HTMLButtonElement>(selector)];
const pressed = (selector: string) => buttons(selector).filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent);

beforeAll(async () => {
  try { localStorage.removeItem('dkg-theme'); } catch { /* not needed */ }
  const el = document.createElement('div');
  el.id = 'root';
  document.body.appendChild(el);
  await act(async () => { await import('../src/ui/design-system.js'); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
});

afterAll(() => { root().remove(); document.documentElement.classList.remove('light'); document.body.classList.remove('light'); });

describe('design system page', () => {
  it('renders its sections and the real primitives', () => {
    expect(root().querySelector('h1')?.textContent).toBe('Design system');
    expect(sections().length).toBeGreaterThanOrEqual(6);
    expect(root().querySelectorAll('.ds-btn').length).toBeGreaterThan(5);
    expect(root().querySelectorAll('.ds-badge').length).toBeGreaterThan(5);
    expect(root().querySelectorAll('.ds-count').length).toBeGreaterThan(0);
    expect(root().querySelectorAll('[role="tab"].ds-tab').length).toBeGreaterThan(1);
    expect(root().querySelectorAll('.v10-agent-dot, .v10-agent-chip').length).toBeGreaterThan(0);
  });

  it('shows each control in a full row of states', () => {
    const table = root().querySelector('.dsp-matrix')!;
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Component', ...STATES]);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) expect(row.querySelectorAll('td').length).toBe(STATES.length);
    expect(table.querySelectorAll('td[data-state="Hover"] .ds-btn.dsp-hover').length).toBeGreaterThan(5);
    expect(table.querySelectorAll('td[data-state="Focus"] .dsp-focus').length).toBeGreaterThan(10);
    expect(table.querySelectorAll('td[data-state="Disabled"] button:disabled').length).toBeGreaterThan(10);
    expect(table.querySelectorAll('td[data-state="Loading"] [aria-busy="true"]').length).toBe(2);
  });

  it('previews hover and focus through the components\' own selectors, with no stylesheet rewriting', () => {
    const css = readFileSync(join(__dirname, '../src/ui/styles/27-ds-components.css'), 'utf8');
    for (const selector of [
      '.ds-btn:is(:hover, .dsp-hover):not(:disabled)',
      '.ds-btn:is(:focus-visible, .dsp-focus)',
      '.ds-btn.ds-primary:is(:hover, .dsp-hover):not(:disabled)',
      '.ds-tab:is(:hover, .dsp-hover)',
      '.ds-seg-item:is(:focus-visible, .dsp-focus)',
      '.ds-filter:is(:hover, .dsp-hover)',
      '.ds-entity-chip.interactive:is(:hover, .dsp-hover)',
      '.ds-input:is(:focus-visible, .dsp-focus)',
      '.ds-toggle:is(:focus-visible, .dsp-focus)',
    ]) expect(css, selector).toContain(selector);
    // A component hover or focus rule without its preview class would show a stale cell.
    const bare = [...css.matchAll(/^\.ds-(?:btn|tab|seg-item|filter|toggle|entity-chip|input)[^{\n]*:(?:hover|focus-visible)(?![^{]*dsp-)[^{]*\{/gm)].map((m) => m[0]);
    expect(bare).toEqual([]);
    const source = readFileSync(join(__dirname, '../src/ui/design-system-states.tsx'), 'utf8');
    expect(source).not.toMatch(/document\.styleSheets|cssRules|<style>/);
  });

  it('switches theme on the document and remembers it', async () => {
    expect(document.body.classList.contains('light')).toBe(false);
    const light = buttons('.dsp-section ~ * .ds-seg-item, .ds-seg-item').find(b => b.textContent === 'Light')!;
    await act(async () => { light.click(); });
    expect(document.body.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(localStorage.getItem('dkg-theme')).toBe('light');
    const dark = buttons('.ds-seg-item').find(b => b.textContent === 'Dark')!;
    await act(async () => { dark.click(); });
    expect(document.body.classList.contains('light')).toBe(false);
  });

  it('drives its interactive examples: tabs, segmented control and filter chips', async () => {
    const tabs = buttons('#navigation [role="tab"].ds-tab');
    await act(async () => { tabs[1].click(); });
    expect(buttons('#navigation [role="tab"].ds-tab').filter(t => t.getAttribute('aria-selected') === 'true').map(t => t.textContent)).toEqual([tabs[1].textContent]);

    const segs = buttons('.ds-seg-item').filter(b => b.textContent !== 'Light' && b.textContent !== 'Dark');
    const target = segs.find(b => b.getAttribute('aria-pressed') !== 'true')!;
    await act(async () => { target.click(); });
    expect(pressed('.ds-seg-item')).toContain(target.textContent);

    const filter = buttons('.ds-filter')[0];
    const before = filter.getAttribute('aria-pressed');
    await act(async () => { filter.click(); });
    expect(buttons('.ds-filter')[0].getAttribute('aria-pressed')).not.toBe(before);
  });
});
