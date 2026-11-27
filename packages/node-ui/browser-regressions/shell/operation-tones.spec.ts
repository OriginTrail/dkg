import { test, expect, type Page } from '@playwright/test';
import { mockQuietNode } from './mock-node.js';

/**
 * Operation badges in the Operations table take their colours from the
 * op-tone-* classes: opTone() picks the tone from the operation name, the
 * class sets --op-text and --op-bg, and the badge reads them. Unit tests
 * only see the declarations; this renders the table with the real
 * stylesheets and checks the colours the browser computes, so a broken
 * binding or a rule that wins the cascade shows up here.
 */

type Theme = 'dark' | 'light';
const THEMES: Theme[] = ['dark', 'light'];

/** Operation name → the layer tokens its badge should resolve to. */
const EXPECTED = [
  { name: 'publish', text: '--layer-verified-text', bg: '--layer-verified-bg' },
  { name: 'share', text: '--layer-shared-text', bg: '--layer-shared-bg' },
  { name: 'query', text: '--text-secondary', bg: '--bg-elevated' },
] as const;

function operation(name: string, i: number) {
  return {
    operation_id: `op-${name}-${i}`,
    operation_name: name,
    status: 'success',
    started_at: Date.now() - i * 60_000,
    duration_ms: 1200,
    phases: [],
  };
}

async function setTheme(page: Page, theme: Theme) {
  await page.evaluate((t) => {
    const light = t === 'light';
    document.documentElement.setAttribute('data-theme', t);
    document.documentElement.classList.toggle('light', light);
    document.body.classList.toggle('light', light);
  }, theme);
}

/** A token as the browser resolves it, read as both a text and a background colour. */
async function token(page: Page, name: string): Promise<{ color: string; background: string }> {
  return page.evaluate((name) => {
    if (!getComputedStyle(document.body).getPropertyValue(name).trim()) throw new Error(`Missing token ${name}`);
    const el = document.createElement('div');
    el.style.color = `var(${name})`;
    el.style.backgroundColor = `var(${name})`;
    document.body.appendChild(el);
    const out = { color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor };
    el.remove();
    return out;
  }, name);
}

test('operation badges in the Operations table show their layer colours in both themes', async ({ page }) => {
  await mockQuietNode(page);
  // Matched on the path: in a glob, `?` would match any one character.
  await page.route((url) => url.pathname.endsWith('/api/operations'), (route) => route.fulfill({
    json: { operations: EXPECTED.map((e, i) => operation(e.name, i)), total: EXPECTED.length },
  }));
  await page.goto('/ui/observability');

  const badge = (name: string) => page.locator('.data-table .obs-op-badge').filter({ hasText: new RegExp(`^${name}$`) }).first();
  for (const { name } of EXPECTED) await expect(badge(name)).toBeVisible();

  for (const theme of THEMES) {
    await setTheme(page, theme);
    const seen: string[] = [];
    for (const e of EXPECTED) {
      const shown = await badge(e.name).evaluate((el) => ({
        color: getComputedStyle(el).color,
        background: getComputedStyle(el).backgroundColor,
      }));
      expect(shown.color, `${theme} ${e.name} text`).toBe((await token(page, e.text)).color);
      expect(shown.background, `${theme} ${e.name} background`).toBe((await token(page, e.bg)).background);
      seen.push(`${shown.color}|${shown.background}`);
    }
    // The three tones stay apart, so a fallback to one colour can't pass.
    expect(new Set(seen).size, `${theme} tones are distinct`).toBe(EXPECTED.length);
  }
});
