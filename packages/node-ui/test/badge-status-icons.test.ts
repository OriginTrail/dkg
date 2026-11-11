/**
 * Status badges draw one icon, and Badge is what draws it (DESIGN.md · Labels).
 * A chip with its own glyph passes `icon`; the default never stacks on top.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Badge } from '../src/ui/components/ds/Badge.js';
import { DiscountAppliedBadge, EligibilityVerdictBanner, HealthChip, HEALTH_CHIP_META } from '../src/ui/components/Pca/index.js';
import { OperationStatusBadge as StatusBadge } from '../src/ui/components/OperationStatusBadge.js';

const render = (el: React.ReactElement) => renderToStaticMarkup(el);
const count = (html: string, needle: string) => html.split(needle).length - 1;
const DEFAULT_GLYPH = 'ds-status-glyph';

describe('status badge icons', () => {
  it('draws the default glyph once on every status tone, in both sizes', () => {
    for (const tone of ['success', 'warning', 'danger', 'pending'] as const) {
      for (const size of ['sm', 'md'] as const) {
        expect(count(render(React.createElement(Badge, { tone, size }, 'Label')), DEFAULT_GLYPH), `${tone} ${size}`).toBe(1);
      }
    }
  });

  it('draws no status glyph on other tones', () => {
    for (const tone of ['neutral', 'muted', 'role', 'kind', 'wm', 'swm', 'vm'] as const) {
      expect(count(render(React.createElement(Badge, { tone }, 'Label')), DEFAULT_GLYPH), tone).toBe(0);
    }
  });

  it('lets `icon` replace the default and `icon={null}` remove it', () => {
    const custom = render(React.createElement(Badge, { tone: 'success', icon: '◉' }, 'Label'));
    expect(count(custom, DEFAULT_GLYPH)).toBe(0);
    expect(count(custom, '◉')).toBe(1);
    expect(count(render(React.createElement(Badge, { tone: 'success', icon: null }, 'Label')), DEFAULT_GLYPH)).toBe(0);
  });

  it('shows the glyph instead of a dot on a status tone', () => {
    const html = render(React.createElement(Badge, { tone: 'warning', dot: true }, 'Label'));
    expect(count(html, 'ds-badge-dot')).toBe(0);
    expect(count(html, DEFAULT_GLYPH)).toBe(1);
    expect(count(render(React.createElement(Badge, { tone: 'role', dot: true }, 'Label')), 'ds-badge-dot')).toBe(1);
  });

  it('gives each PCA chip its own glyph exactly once', () => {
    for (const state of Object.keys(HEALTH_CHIP_META) as Array<keyof typeof HEALTH_CHIP_META>) {
      const html = render(React.createElement(HealthChip, { state }));
      expect(count(html, DEFAULT_GLYPH), state).toBe(0);
      expect(count(html, 'v10-pca-health-glyph'), state).toBe(1);
      expect(count(html, HEALTH_CHIP_META[state].glyph), state).toBe(1);
    }
    const discount = render(React.createElement(DiscountAppliedBadge, {
      convictionCostCovered: { accountId: '7', epoch: 1, baseCost: '1000', discountedCost: '700', drawnFromEpoch: '700', drawnFromTopUp: '0' },
    } as React.ComponentProps<typeof DiscountAppliedBadge>));
    expect(count(discount, DEFAULT_GLYPH)).toBe(0);
    expect(count(discount, '◉')).toBe(1);
    for (const verdict of ['eligible', 'fallthrough', 'fallthrough-no-funds', 'unknown'] as const) {
      const chip = render(React.createElement(EligibilityVerdictBanner, { verdict, variant: 'chip' }));
      expect(count(chip, DEFAULT_GLYPH), verdict).toBe(0);
    }
  });

  it('draws the default glyph on operation statuses, but not on cancelled', () => {
    expect(count(render(React.createElement(StatusBadge, { status: 'success' })), DEFAULT_GLYPH)).toBe(1);
    expect(count(render(React.createElement(StatusBadge, { status: 'cancelled' })), DEFAULT_GLYPH)).toBe(0);
  });

  it('keeps status badges on <Badge>: raw classes would render without an icon', () => {
    const ui = resolve(__dirname, '../src/ui');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return name.endsWith('.tsx') ? [full] : [];
    });
    const raw = walk(ui).filter((file) => !file.endsWith('Badge.tsx') && /ds-badge[^\n]*ds-tone-(?:success|warning|danger|pending|\$\{)/.test(readFileSync(file, 'utf8')));
    expect(raw).toEqual([]);
  });
});
