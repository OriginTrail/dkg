import { test, expect, type Page } from '@playwright/test';
import { contrastRatio } from '../../test/helpers/contrast.js';
import { mockQuietNode } from './mock-node.js';

/**
 * Contrast of badges, counts and the Context Graph colour tokens as the
 * browser renders them. Every colour is read with getComputedStyle from the
 * app's own stylesheet, so the real cascade (grouped rules, specificity,
 * theme overrides, color-mix) decides the result; only the contrast maths
 * runs here (test/helpers/contrast.ts).
 */

type Theme = 'dark' | 'light';
const THEMES: Theme[] = ['dark', 'light'];

/** Surfaces a badge or count can sit on. */
const SURFACES = ['--bg-root', '--bg-panel', '--bg-surface', '--bg-elevated'] as const;
const BADGE_TONES = ['neutral', 'success', 'warning', 'danger', 'pending', 'wm', 'swm', 'vm', 'role', 'muted'];
const STATUS_TONES = ['success', 'warning', 'danger', 'pending'];
const COUNTS = [['neutral', 'ds-count'], ['attention', 'ds-count ds-tone-attention'], ['quiet', 'ds-count ds-tone-quiet']] as const;

/** What a probe element looks like on a surface. */
interface Rendered { color: string; background: string; surface: string }

async function setTheme(page: Page, theme: Theme) {
  await page.evaluate((t) => {
    const light = t === 'light';
    document.documentElement.setAttribute('data-theme', t);
    document.documentElement.classList.toggle('light', light);
    document.body.classList.toggle('light', light);
  }, theme);
}

/** Render `className` on `surface` and read its colours. `vars` overrides tokens on the surface. */
async function render(page: Page, className: string, surface: string, vars: Record<string, string> = {}): Promise<Rendered> {
  return page.evaluate(({ className, surface, vars }) => {
    const wrap = document.createElement('div');
    wrap.style.background = `var(${surface})`;
    for (const [name, value] of Object.entries(vars)) wrap.style.setProperty(name, value);
    const el = document.createElement('span');
    el.className = className;
    el.textContent = 'Label 12';
    wrap.appendChild(el);
    document.getElementById('contrast-probes')!.appendChild(wrap);
    const out = {
      color: getComputedStyle(el).color,
      background: getComputedStyle(el).backgroundColor,
      surface: getComputedStyle(wrap).backgroundColor,
    };
    wrap.remove();
    return out;
  }, { className, surface, vars });
}

/** A token's colour as the browser resolves it in the current theme. */
async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((name) => {
    const el = document.createElement('div');
    el.style.color = `var(${name})`;
    document.getElementById('contrast-probes')!.appendChild(el);
    const value = getComputedStyle(el).color;
    el.remove();
    if (!getComputedStyle(document.body).getPropertyValue(name).trim()) throw new Error(`Missing token ${name}`);
    return value;
  }, name);
}

/** The declared value of a token in the current theme. */
async function declared(page: Page, name: string): Promise<string> {
  return page.evaluate((name) => getComputedStyle(document.body).getPropertyValue(name).trim().toLowerCase(), name);
}

const ratio = ({ color, background, surface }: Rendered) => contrastRatio(color, background, surface);

test.beforeEach(async ({ page }) => {
  await mockQuietNode(page);
  await page.goto('/ui/');
  await expect(page.locator('.v10-app')).toBeVisible();
  await page.evaluate(() => {
    const probes = document.createElement('div');
    probes.id = 'contrast-probes';
    probes.style.cssText = 'position:fixed;left:0;top:0;color:var(--text-primary)';
    document.body.appendChild(probes);
  });
});

test('badges are readable on every surface in both themes', async ({ page }) => {
  for (const theme of THEMES) {
    await setTheme(page, theme);
    for (const tone of BADGE_TONES) {
      for (const surface of SURFACES) {
        const shown = await render(page, `ds-badge ds-tone-${tone}`, surface);
        expect(ratio(shown), `${theme} badge ${tone} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Statuses have no box: the text sits straight on the surface.
    for (const tone of STATUS_TONES) {
      const shown = await render(page, `ds-badge ds-tone-${tone}`, '--bg-surface');
      expect(shown.background, `${theme} status ${tone} background`).toBe('rgba(0, 0, 0, 0)');
    }
  }
});

test('counts are readable on every surface in both themes', async ({ page }) => {
  for (const theme of THEMES) {
    await setTheme(page, theme);
    for (const [tone, className] of COUNTS) {
      for (const surface of SURFACES) {
        const shown = await render(page, className, surface);
        expect(ratio(shown), `${theme} count ${tone} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    // The bell's solid disc in the header.
    const bell = await render(page, 'v10-header-notif-badge ds-count ds-tone-attention', '--bg-panel');
    expect(ratio(bell), `${theme} bell count`).toBeGreaterThanOrEqual(4.5);
  }
});

test('the check fails a colour below AA', async ({ page }) => {
  // Regression: the notification pane's attention count on --bg-elevated
  // rendered 3.94:1 with this amber in the light theme.
  await setTheme(page, 'light');
  const old = await render(page, 'ds-count ds-tone-attention', '--bg-elevated', { '--text-warning': '#a35207' });
  expect(ratio(old)).toBeLessThan(4.5);
  // A later rule that boxes a status in its own colour is caught.
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'unreadable-status';
    style.textContent = '.ds-badge.ds-tone-success { --badge-bg: var(--text-success); }';
    document.head.appendChild(style);
  });
  const boxed = await render(page, 'ds-badge ds-tone-success', '--bg-surface');
  expect(ratio(boxed)).toBeLessThan(4.5);
  await page.evaluate(() => document.getElementById('unreadable-status')!.remove());
  // Pending text in the decoration-only ghost colour is caught, in both themes.
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.id = 'ghost-pending';
    style.textContent = '.ds-badge.ds-tone-pending { --badge-fg: var(--text-ghost); }';
    document.head.appendChild(style);
  });
  for (const theme of THEMES) {
    await setTheme(page, theme);
    expect(ratio(await render(page, 'ds-badge ds-tone-pending', '--bg-surface')), `${theme} ghost pending`).toBeLessThan(4.5);
  }
  await page.evaluate(() => document.getElementById('ghost-pending')!.remove());
  // A token set on a parent doesn't override the badge's own rule.
  const outer = await render(page, 'ds-badge ds-tone-success', '--bg-surface', { '--badge-bg': 'var(--text-success)' });
  expect(outer.background).toBe('rgba(0, 0, 0, 0)');
});

test('readable Context Graph text stays off the decoration-only ghost token', async ({ page }) => {
  const readable = [
    '.ds-badge', '.ds-count', '.v10-entity-list-header', '.v10-entity-card-triples', '.v10-item-ual',
    '.v10-item-count', '.v10-graph-placeholder', '.v10-docs-placeholder', '.v10-ka-ual', '.v10-ka-section-title',
    '.v10-ka-meta', '.v10-ka-conn-pred', '.v10-ka-triples-table th', '.v10-ka-event-time',
    '.v10-activity-feed-bucket-count', '.v10-activity-feed-time', '.v10-vm-identity-lbl', '.v10-gen-widget-footnote',
    '.v10-empty-state-title', '.v10-empty-state-desc', '.v10-stat-strip-label', '.v10-entity-list-sort-select',
    // Project overview chrome.
    '.v10-po-identity-label', '.v10-po-section-title', '.v10-po-pipeline-step-desc', '.v10-po-people-empty',
    '.v10-po-participant-name', '.v10-po-join-empty', '.v10-po-join-addr', '.v10-po-primer-footer-lede',
    '.v10-po-primer-footer-sub',
  ];
  for (const theme of THEMES) {
    await setTheme(page, theme);
    const ghost = await token(page, '--text-ghost');
    const colours = await page.evaluate((selectors) => selectors.map((selector) => {
      // Build the element the selector describes: `.a .b` nests, `th` is a tag.
      let parent: Element = document.getElementById('contrast-probes')!;
      const root = parent;
      for (const part of selector.split(/\s+/)) {
        const [, tag, classes] = /^([a-z]*)((?:\.[\w-]+)*)$/.exec(part)!;
        const el = document.createElement(tag || 'div');
        el.className = classes.split('.').filter(Boolean).join(' ');
        parent.appendChild(el);
        parent = el;
      }
      const colour = getComputedStyle(parent).color;
      root.replaceChildren();
      return colour;
    }), readable);
    readable.forEach((selector, i) => expect(colours[i], `${theme} ${selector}`).not.toBe(ghost));
  }
});

test('the layer palette keeps the shared nOS hues (WM slate, SWM cyan, VM purple)', async ({ page }) => {
  const expected = {
    dark: { '--layer-working': '#94a3b8', '--layer-shared': '#1aded7', '--layer-verified': '#8b85f4' },
    light: { '--layer-working': '#526173', '--layer-shared': '#0f9c96', '--layer-verified': '#6344df' },
  };
  for (const theme of THEMES) {
    await setTheme(page, theme);
    for (const [name, value] of Object.entries(expected[theme])) {
      expect(await declared(page, name), `${theme} ${name}`).toBe(value);
    }
  }
  // Signals keep their own hues and are not aliases of a layer.
  await setTheme(page, 'dark');
  expect(await token(page, '--layer-shared')).not.toBe(await token(page, '--accent-amber'));
  expect(await token(page, '--layer-verified')).not.toBe(await token(page, '--accent-green'));
});

test('layer, role and action colours are legible in both themes', async ({ page }) => {
  for (const theme of THEMES) {
    await setTheme(page, theme);
    const surface = await token(page, theme === 'dark' ? '--bg-panel' : '--bg-surface');
    /** Foreground token on background token, the background composited over the theme's surface. */
    const on = async (fg: string, bg?: string) => contrastRatio(await token(page, fg), bg ? await token(page, bg) : surface, surface);
    for (const layer of ['working', 'shared', 'verified']) {
      expect(await on(`--layer-${layer}-text`, `--layer-${layer}-bg`), `${theme} ${layer} text on chip`).toBeGreaterThanOrEqual(4.5);
      expect(await on(`--layer-${layer}-text`), `${theme} ${layer} text on surface`).toBeGreaterThanOrEqual(4.5);
      expect(await on(`--layer-${layer}`), `${theme} ${layer} icon on surface`).toBeGreaterThanOrEqual(3);
    }
    expect(await on('--focus-ring'), `${theme} focus ring`).toBeGreaterThanOrEqual(3);
    // Role & access (blue): chip text on its tint and on the surface; bar/dot on the surface.
    expect(await on('--role-text', '--role-bg'), `${theme} role chip`).toBeGreaterThanOrEqual(4.5);
    expect(await on('--role-text'), `${theme} access outline text`).toBeGreaterThanOrEqual(4.5);
    expect(await on('--role'), `${theme} role bar`).toBeGreaterThanOrEqual(3);
    // Buttons: every variant's label clears AA on its own fill.
    expect(await on('--text-primary', '--bg-surface'), `${theme} secondary`).toBeGreaterThanOrEqual(4.5);
    expect(await on('--text-on-primary', '--accent-primary'), `${theme} primary`).toBeGreaterThanOrEqual(4.5);
    expect(await on('--text-secondary', '--bg-surface'), `${theme} ghost`).toBeGreaterThanOrEqual(4.5);
    expect(await on('--text-danger', '--bg-surface'), `${theme} danger`).toBeGreaterThanOrEqual(4.5);
    expect(await on('--layer-shared-text', '--layer-shared-bg'), `${theme} share to SWM`).toBeGreaterThanOrEqual(4.5);
    expect(await on('--text-on-vm', '--accent-vm'), `${theme} publish to VM`).toBeGreaterThanOrEqual(4.5);
    expect(await on('--text-on-vm', '--accent-vm-hover'), `${theme} publish to VM hover`).toBeGreaterThanOrEqual(4.5);
  }
});
