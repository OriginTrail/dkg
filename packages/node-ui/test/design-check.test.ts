// scripts/design-check.mjs (DESIGN.md · Checking a new design) reads the scale from
// 00-theme.css and says, for each value that isn't on it, which token to use or
// that the system needs a new one. These tests keep its suggestions right, and run
// it over the UI so a value off the system fails here with that suggestion attached.
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script, with no types
import { buildSystem, checkDeclaration, checkText, readTokens, runtimeProps } from '../scripts/design-check.mjs';
import { cssFiles, read, where } from './helpers/source.js';

const system = buildSystem(readTokens());
const use = (prop: string, value: string, mockup = false) => checkDeclaration(system, prop, value, { known: new Set(), mockup })
  .map((f: { use: string }) => f.use);

describe('design check', () => {
  it('names the token for a value on the scale', () => {
    expect(use('padding', '16px')).toEqual(['var(--space-16)']);
    expect(use('border-radius', '6px')).toEqual(['var(--radius-control)']);
    expect(use('font-size', '13px')).toEqual(['var(--fs-control)']);
    expect(use('color', '#ffffff')[0]).toMatch(/^var\(--text-/);
  });

  it('points a value off the scale at the nearest token, or at adding one', () => {
    const [gap] = use('gap', '10px');
    expect(gap).toMatch(/nearest is var\(--space-8\)/); // gaps and margins round down
    expect(gap).toMatch(/add a token/);
    expect(use('padding', '10px')[0]).toMatch(/nearest is var\(--space-12\)/); // padding rounds up
    expect(use('font-size', '15px')[0]).toMatch(/nearest is var\(--fs-(body|title)\)/);
    expect(use('background', '#ff00ff')[0]).toMatch(/no token is close/);
  });

  it('matches a colour to a token with the same job', () => {
    expect(use('background', '#111111')[0]).toMatch(/var\(--bg-/);
    expect(use('--surface', '#141414', true)[0]).toMatch(/var\(--bg-/);
    expect(use('--border', '#2a2a2a', true)[0]).toMatch(/var\(--border-/);
  });

  it('flags variables that are not node UI tokens', () => {
    expect(use('color', 'var(--muted)')[0]).toMatch(/not a node UI token/);
    expect(use('color', 'var(--text-primary)')).toEqual([]);
  });

  it('hints at components only in mock-ups', () => {
    const html = '<button class="btn">Save</button><span class="tag">VM</span><input type="text">';
    const kinds = (mockup: boolean) => checkText(system, html, 'mock.html', { known: new Set(), mockup })
      .map((f: { use: string }) => f.use.split(' ')[0]);
    expect(kinds(true).sort()).toEqual(['<Badge>,', '<Button>', 'class="ds-input"']);
    expect(kinds(false)).toEqual([]);
  });

  // The suites in design-tokens and layout-tokens hold the rules; this one adds the
  // suggestion, so a failure here says what to write instead.
  it('finds nothing off the system in the UI stylesheets', () => {
    const known = runtimeProps();
    const off = cssFiles.filter((f) => !f.endsWith('00-theme.css')).flatMap((f) => (
      checkText(system, read(f), f, { known })
        .filter((x: { offScale?: boolean }) => x.offScale)
        .map((x: { line: number; prop: string; value: string; use: string }) => `${where(f)}:${x.line} ${x.prop}: ${x.value} → ${x.use}`)
    ));
    expect(off).toEqual([]);
  });
});
