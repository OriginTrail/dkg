// #1354 — the PCA stylesheet was split into six surface files whose combined
// cascade is correct ONLY when `styles.css` @imports them in source order with
// `26-pca-followup-overrides.css` LAST (its equal-specificity overrides win by
// source order alone). The other CSS tests read every file under `src/ui/styles`
// directly (readdirSync / concatenation), so a regression that reorders or drops
// one of these @imports in `styles.css` would leave the selectors present in
// those reads and pass anyway. This test parses `styles.css`'s ACTUAL @import
// order — the only thing that reflects how Vite loads the bundle — so a
// reorder/drop of the override layer fails loudly.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const uiDir = resolve(here, '../src/ui');

// The PCA split files, in the exact cascade order they must be imported.
// `26-pca-followup-overrides.css` MUST stay last — it patches earlier surfaces
// by equal-specificity source order.
const EXPECTED_PCA_ORDER = [
  './styles/26-pca-primitives.css',
  './styles/26-pca-overview-cards.css',
  './styles/26-pca-shell-dashboard.css',
  './styles/26-pca-modals-detail.css',
  './styles/26-pca-publish-eligibility.css',
  './styles/26-pca-followup-overrides.css',
];

/** The ordered list of `@import '<path>';` targets in styles.css. */
function stylesCssImports(): string[] {
  const css = readFileSync(resolve(uiDir, 'styles.css'), 'utf8');
  return [...css.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?\s*;/g)].map((m) => m[1]);
}

describe('PCA CSS split — styles.css import order (#1354)', () => {
  const imports = stylesCssImports();
  const pcaImports = imports.filter((p) => p.includes('26-pca'));

  it('imports exactly the six PCA split files, in cascade order', () => {
    expect(pcaImports).toEqual(EXPECTED_PCA_ORDER);
  });

  it('imports the follow-up override layer LAST among the PCA files', () => {
    expect(pcaImports[pcaImports.length - 1]).toBe('./styles/26-pca-followup-overrides.css');
  });

  it('no longer imports (or ships) the pre-split monolithic 26-pca.css', () => {
    expect(imports).not.toContain('./styles/26-pca.css');
    expect(existsSync(resolve(uiDir, 'styles/26-pca.css'))).toBe(false);
  });

  it('every imported PCA split file is reachable on disk', () => {
    for (const rel of EXPECTED_PCA_ORDER) {
      expect(existsSync(resolve(uiDir, rel))).toBe(true);
    }
  });

  it('keeps the PCA layer after the base theme so it can consume theme vars', () => {
    // 00-theme.css defines the --text-*/--bg-* custom properties the PCA files
    // only consume; the whole PCA block must load after it.
    const themeIdx = imports.indexOf('./styles/00-theme.css');
    const firstPcaIdx = imports.indexOf(EXPECTED_PCA_ORDER[0]);
    expect(themeIdx).toBeGreaterThanOrEqual(0);
    expect(firstPcaIdx).toBeGreaterThan(themeIdx);
  });
});
