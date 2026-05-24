import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../src/ui/styles.css'), 'utf8');

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
      '.v10-po-stat-label',
      '.v10-po-progress-legend',
      '.v10-entity-list-empty',
      '.v10-entity-list-header',
      '.v10-entity-card-triples',
      '.v10-item-ual',
      '.v10-item-count',
      '.v10-graph-placeholder',
      '.v10-docs-placeholder',
      '.v10-provenance-bar',
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
    ];

    for (const selector of readableSelectors) {
      expect(ruleFor(selector), selector).not.toContain('color: var(--text-ghost)');
    }
  });

  it('keeps the trust palette tokens unchanged by the contrast sweep', () => {
    expect(css).toContain('--layer-working: #64748b;');
    expect(css).toContain('--layer-shared: #f59e0b;');
    expect(css).toContain('--layer-verified: #22c55e;');
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
      '.v10-ph-join-btn.approve',
      '.v10-ph-join-btn.reject',
    ];

    for (const selector of selectorsOnSurface) {
      expect(contrast(foregroundFor(selector), lightVars['--bg-surface']), selector).toBeGreaterThanOrEqual(4.5);
    }

    expect(contrast(foregroundFor('.v10-btn-promote-all'), lightVars['--layer-shared'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(foregroundFor('.v10-btn-publish'), lightVars['--layer-verified'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(foregroundFor('.v10-decision-btn.primary-cta.publish-vm'), '#22c55e')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(foregroundFor('.v10-decision-btn.primary-cta.publish-vm'), '#16a34a')).toBeGreaterThanOrEqual(4.5);
  });
});
