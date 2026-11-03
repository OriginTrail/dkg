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
      '.ds-badge',
      '.ds-count',
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
    // Buttons (components/ds/Button + legacy aliases in 27-ds-components.css):
    // every variant's label clears AA on its own fill, in dark (preferred) and light.
    for (const [theme, vars] of [['dark', rootVars], ['light', lightVars]] as const) {
      const c = (fg: string, bg: string) => contrast(resolveColor(vars[fg], vars), resolveColor(vars[bg], vars));
      expect(c('--text-primary', '--bg-surface'), `${theme} secondary`).toBeGreaterThanOrEqual(4.5);
      expect(c('--text-on-primary', '--accent-primary'), `${theme} primary`).toBeGreaterThanOrEqual(4.5);
      expect(c('--text-secondary', '--bg-surface'), `${theme} ghost`).toBeGreaterThanOrEqual(4.5);
      expect(c('--text-danger', '--bg-surface'), `${theme} danger`).toBeGreaterThanOrEqual(4.5);
      expect(c('--layer-shared-text', '--layer-shared-bg'), `${theme} share to SWM`).toBeGreaterThanOrEqual(4.5);
      expect(c('--text-on-vm', '--accent-vm'), `${theme} publish to VM`).toBeGreaterThanOrEqual(4.5);
      expect(c('--text-on-vm', '--accent-vm-hover'), `${theme} publish to VM hover`).toBeGreaterThanOrEqual(4.5);
    }
    // Elements declare their variant: the screens that used these legacy
    // classes now carry the matching ds-* classes on the element itself.
    for (const [file, cls] of [
      ['components/Workspace/WireWorkspacePanel.tsx', 'v10-modal-btn primary ds-btn ds-primary'],
      ['views/project/components/overview.tsx', 'v10-po-join-btn approve ds-btn ds-primary ds-sm'],
      ['views/project/components/overview.tsx', 'v10-po-join-btn reject ds-btn ds-danger ds-sm'],
      ['views/MemoryLayerView.tsx', 'v10-btn-publish ds-btn ds-vm'],
    ] as const) {
      expect(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../src/ui', file), 'utf8'), `${file}: ${cls}`).toContain(`"${cls}"`);
    }

    // Badges (components/ds/Badge): each tone's text colour must clear AA on
    // the light surface. Tones set --badge-fg rather than `color`.
    for (const tone of ['success', 'warning', 'danger', 'wm', 'swm', 'vm', 'role', 'muted']) {
      const fg = resolveColor(customProperties(`.ds-badge.ds-tone-${tone}`)['--badge-fg']);
      expect(contrast(fg, lightVars['--bg-surface']), `badge ${tone}`).toBeGreaterThanOrEqual(4.5);
    }
    // Attention counts use --text-warning on a light tint; the bell's solid disc puts --bg-root on it.
    expect(contrast(resolveColor(lightVars['--text-warning']), lightVars['--bg-surface']), 'count attention').toBeGreaterThanOrEqual(4.5);
    expect(contrast(resolveColor(lightVars['--bg-root']), resolveColor(lightVars['--text-warning'])), 'bell count').toBeGreaterThanOrEqual(4.5);

  });
});
