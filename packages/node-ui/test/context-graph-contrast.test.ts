import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function readStylesSources(): string {
  const uiDir = resolve(here, '../src/ui');
  const stylesDir = resolve(uiDir, 'styles');
  const chunks = readdirSync(stylesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.css'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => readFileSync(resolve(stylesDir, entry.name), 'utf8'));
  return [
    readFileSync(resolve(uiDir, 'styles.css'), 'utf8'),
    ...chunks,
  ].join('\n');
}

const css = readStylesSources();

function ruleFor(selector: string): string {
  const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`).exec(css);
  if (!match) throw new Error(`Missing selector ${selector}`);
  const open = css.indexOf('{', match.index);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

function blockFor(selector: string): string {
  return ruleFor(selector);
}

function customProperties(selector: string): Record<string, string> {
  const block = blockFor(selector);
  return Object.fromEntries(
    [...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map(([, key, value]) => [key, value.trim()]),
  );
}

const rootVars = customProperties(':root');
const lightVars = { ...rootVars, ...customProperties('body.light') };

function declaration(rule: string, property: string): string {
  const match = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+);?`).exec(rule);
  if (!match) throw new Error(`Missing ${property} declaration in ${rule}`);
  return match[1].trim();
}

function resolveColor(value: string, vars = lightVars): string {
  const varMatch = /var\((--[a-z0-9-]+)(?:,\s*([^)]+))?\)/i.exec(value);
  if (varMatch) {
    return resolveColor(vars[varMatch[1]] ?? varMatch[2], vars);
  }
  const hexMatch = /#[0-9a-f]{3,6}/i.exec(value);
  if (!hexMatch) throw new Error(`Cannot resolve color ${value}`);
  return hexMatch[0];
}

function rgb(hex: string): [number, number, number] {
  const raw = hex.slice(1);
  const full = raw.length === 3 ? raw.split('').map(ch => ch + ch).join('') : raw;
  return [0, 2, 4].map(offset => parseInt(full.slice(offset, offset + 2), 16) / 255) as [number, number, number];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map(channel => (
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return (0.2126 * r) + (0.7152 * g) + (0.0722 * b);
}

function contrast(foreground: string, background: string): number {
  const a = luminance(resolveColor(foreground));
  const b = luminance(resolveColor(background));
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

function foregroundFor(selector: string): string {
  return resolveColor(declaration(ruleFor(selector), 'color'));
}

describe('Context Graph contrast tokens', () => {
  it('keeps readable Context Graph text off the decoration-only ghost token', () => {
    const readableSelectors = [
      '.v10-layer-switch-count',
      '.v10-entity-list-empty',
      '.v10-entity-list-header',
      '.v10-entity-card-triples',
      '.v10-item-ual',
      '.v10-item-count',
      '.v10-graph-placeholder',
      '.v10-docs-placeholder',
      '.v10-ka-ual',
      '.v10-ka-section-title',
      '.v10-ka-meta',
      '.v10-ka-conn-pred',
      '.v10-ka-triples-table th',
      '.v10-ka-event-time',
      '.v10-activity-feed-bucket-count',
      '.v10-activity-feed-time',
      '.v10-vm-identity-lbl',
      '.v10-gen-widget-footnote',
      '.v10-evidence-title',
      '.v10-canvas-empty',
      '.v10-empty-state-title',
      '.v10-empty-state-desc',
      '.v10-stat-strip-label',
      '.v10-entity-list-sort-select',
      // S2 Overview finalize (§4.2.1) — readable chrome rendered
      // via `--text-*` tokens. Registered here so a future
      // regression on any of these is caught explicitly.
      '.v10-po-identity-label',
      '.v10-po-section-title',
      '.v10-po-pipeline-step-desc',
      '.v10-po-people-empty',
      '.v10-po-participant-name',
      '.v10-po-join-empty',
      '.v10-po-join-addr',
      '.v10-po-primer-footer-lede',
      '.v10-po-primer-footer-sub',
    ];

    for (const selector of readableSelectors) {
      expect(ruleFor(selector), selector).not.toContain('color: var(--text-ghost)');
    }
  });

  it('pins the layer palette to the shared nOS hues (WM slate, SWM cyan, VM purple)', () => {
    expect(rootVars['--layer-working']).toBe('#94a3b8');
    expect(rootVars['--layer-shared']).toBe('#1aded7');
    expect(rootVars['--layer-verified']).toBe('#8b85f4');
    expect(lightVars['--layer-working']).toBe('#526173');
    expect(lightVars['--layer-shared']).toBe('#0f9c96');
    expect(lightVars['--layer-verified']).toBe('#6344df');
    // Signals keep their own hues and are no longer aliases of a layer.
    expect(rootVars['--layer-shared']).not.toBe(rootVars['--accent-amber']);
    expect(rootVars['--layer-verified']).not.toBe(rootVars['--accent-green']);
  });

  it('keeps every layer role legible in both themes', () => {
    for (const [theme, vars] of [['dark', rootVars], ['light', lightVars]] as const) {
      const surface = theme === 'dark' ? vars['--bg-panel'] : vars['--bg-surface'];
      for (const layer of ['working', 'shared', 'verified']) {
        const text = vars[`--layer-${layer}-text`];
        const bg = vars[`--layer-${layer}-bg`];
        const icon = vars[`--layer-${layer}`];
        expect(contrast(text, bg), `${theme} ${layer} text on chip`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(text, surface), `${theme} ${layer} text on surface`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(icon, surface), `${theme} ${layer} icon on surface`).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(vars['--text-on-vm'], vars['--accent-vm']), `${theme} publish-to-VM label`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(vars['--text-on-primary'], vars['--accent-primary']), `${theme} primary label`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(vars['--focus-ring'], surface), `${theme} focus ring`).toBeGreaterThanOrEqual(3);
      // Role & access (blue): chip text on its tint and on the surface; bar/dot vs surface.
      expect(contrast(vars['--role-text'], vars['--role-bg']), `${theme} role chip`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(vars['--role-text'], surface), `${theme} access outline text`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(vars['--role'], surface), `${theme} role bar`).toBeGreaterThanOrEqual(3);
    }
  });

  it('uses light-theme semantic foregrounds with AA contrast for status and action text', () => {
    const selectorsOnSurface = [
      '.v10-mlv-save-btn',
      '.v10-btn-promote',
      '.v10-trust-badge.trust-verified',
      '.v10-trust-badge.trust-shared',
      '.v10-trust-badge.trust-working',
      '.v10-trust-badge.vm',
      '.v10-trust-badge.swm',
      '.v10-trust-badge.wm',
      '.v10-layer-expand-footer-btn.promote',
      '.v10-layer-expand-footer-btn.publish',
      '.v10-layer-action-btn.primary',
      '.v10-layer-action-btn.promote',
      '.v10-decision-btn.approve',
      '.v10-decision-btn.revise',
      '.v10-subgraph-chip-badge.tone-warn',
      '.v10-subgraph-chip-badge.tone-danger',
      '.v10-subgraph-chip-badge.tone-info',
      '.v10-subgraph-chip-badge.tone-muted',
      '.v10-activity-feed-type',
      '.v10-activity-feed-status.status-good',
      '.v10-activity-feed-status.status-warn',
      '.v10-activity-feed-status.status-bad',
      '.v10-po-join-btn.approve',
      '.v10-po-join-btn.reject',
    ];

    for (const selector of selectorsOnSurface) {
      expect(contrast(foregroundFor(selector), lightVars['--bg-surface']), selector).toBeGreaterThanOrEqual(4.5);
    }

    // Share-to-SWM uses the SWM layer tint; publish-to-VM is the purple fill.
    expect(contrast(foregroundFor('.v10-btn-promote-all'), lightVars['--layer-shared-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(foregroundFor('.v10-ka-verify-btn.promote'), lightVars['--layer-shared-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(foregroundFor('.v10-btn-publish'), lightVars['--accent-vm'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(foregroundFor('.v10-decision-btn.primary-cta.publish-vm'), lightVars['--accent-vm'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(foregroundFor('.v10-decision-btn.primary-cta.publish-vm'), lightVars['--accent-vm-hover'])).toBeGreaterThanOrEqual(4.5);
  });
});
