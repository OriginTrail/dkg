import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { composite, contrastRatio, luminance, parseColour } from './helpers/contrast.js';

// The theme, surface and 4.5:1 checks on badges, counts and colour tokens run
// in a real browser, against the cascade it computes:
// browser-regressions/shell/badge-contrast.spec.ts. This file keeps the colour
// maths those checks rely on, and the source check below.

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/ui');

describe('contrast maths', () => {
  it('reads the colour formats getComputedStyle returns', () => {
    expect(parseColour('#fff')).toEqual([1, 1, 1, 1]);
    expect(parseColour('#000000')).toEqual([0, 0, 0, 1]);
    expect(parseColour('rgb(255, 0, 0)')).toEqual([1, 0, 0, 1]);
    expect(parseColour('rgba(0, 0, 0, 0)')).toEqual([0, 0, 0, 0]);
    expect(parseColour('rgb(0 0 255 / 50%)')).toEqual([0, 0, 1, 0.5]);
    // color-mix(in srgb, X 16%, transparent) computes to this form in Chromium.
    expect(parseColour('color(srgb 0.1 0.87 0.84 / 0.16)')).toEqual([0.1, 0.87, 0.84, 0.16]);
    expect(parseColour('transparent')).toEqual([0, 0, 0, 0]);
    expect(() => parseColour('oklch(0.7 0.1 200)')).toThrow(/Cannot parse/);
  });

  it('composites a translucent colour over the surface under it', () => {
    expect(composite([1, 1, 1, 0.5], [0, 0, 0, 1])).toEqual([0.5, 0.5, 0.5, 1]);
    expect(composite([1, 0, 0, 0], [0, 0, 1, 1])).toEqual([0, 0, 1, 1]);
    expect(composite([1, 0, 0, 1], [0, 0, 1, 1])).toEqual([1, 0, 0, 1]);
  });

  it('matches the WCAG luminance and contrast figures', () => {
    expect(luminance(parseColour('#ffffff'))).toBeCloseTo(1, 5);
    expect(luminance(parseColour('#000000'))).toBe(0);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // #767676 is the lightest grey that clears AA on white.
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
  });

  it('reads a tinted background as it shows on its surface', () => {
    // 16% black over white is a light grey, not transparent and not black.
    const tinted = contrastRatio('#000000', 'rgba(0, 0, 0, 0.16)', '#ffffff');
    expect(tinted).toBeLessThan(21);
    expect(tinted).toBeCloseTo(contrastRatio('#000000', 'rgb(214, 214, 214)'), 1);
    // A transparent background is the surface itself.
    expect(contrastRatio('#000000', 'rgba(0, 0, 0, 0)', '#ffffff')).toBeCloseTo(21, 5);
  });
});

describe('Context Graph action buttons', () => {
  it('declare their ds-* variant on the element', () => {
    // The screens that used legacy button classes now carry the matching
    // ds-* classes, so the variant contrast checked in the browser applies.
    for (const [file, cls] of [
      ['components/Workspace/WireWorkspacePanel.tsx', 'v10-modal-btn primary ds-btn ds-primary'],
      ['views/project/components/overview.tsx', 'v10-po-join-btn ds-btn ds-primary ds-sm'],
      ['views/project/components/overview.tsx', 'v10-po-join-btn ds-btn ds-danger ds-sm'],
      ['views/MemoryLayerView.tsx', 'v10-btn-publish ds-btn ds-vm'],
    ] as const) {
      expect(readFileSync(resolve(uiDir, file), 'utf8'), `${file}: ${cls}`).toContain(`"${cls}"`);
    }
  });
});
