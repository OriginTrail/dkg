// @vitest-environment happy-dom
// One stat card for the whole UI. The Dashboard's local StatCard is gone.
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatTile } from '../src/ui/components/ds/StatTile.js';

const html = (el: React.ReactElement) => {
  const div = document.createElement('div');
  div.innerHTML = renderToStaticMarkup(el);
  return div.firstElementChild as HTMLElement;
};

describe('StatTile', () => {
  it('renders label, value and context line', () => {
    const card = html(React.createElement(StatTile, { label: 'Direct', value: 3, sub: 'peers' }));
    expect(card.className).toBe('stat-card ds-card');
    expect(card.querySelector('.stat-label')?.textContent).toBe('Direct');
    expect(card.querySelector('.stat-value')?.textContent).toBe('3');
    expect(card.querySelector('.stat-sub')?.textContent).toBe('peers');
  });

  it('keeps zero, and drops an empty value or context line', () => {
    expect(html(React.createElement(StatTile, { label: 'Known agents', value: 0 })).querySelector('.stat-value')?.textContent).toBe('0');
    const empty = html(React.createElement(StatTile, { label: 'Size', value: '', sub: '' }));
    expect(empty.querySelector('.stat-value')).toBeNull();
    expect(empty.querySelector('.stat-sub')).toBeNull();
  });

  it('takes an icon, rich content between value and context, and extra classes', () => {
    const card = html(React.createElement(StatTile, {
      label: 'Context graph size',
      icon: React.createElement('svg', { 'data-icon': 'trend' }),
      className: 'v10-anim-mount',
      sub: 'across graphs',
    }, React.createElement('div', { className: 'v10-cg-size-detail' }, 'detail')));
    expect(card.className).toBe('stat-card ds-card v10-anim-mount');
    expect(card.querySelector('.stat-label svg[data-icon="trend"]')).toBeTruthy();
    const order = [...card.children].map((c) => c.className);
    expect(order).toEqual(['stat-label', 'v10-cg-size-detail', 'stat-sub']);
  });

  it('is the only stat card implementation', () => {
    const dashboard = readFileSync(join(__dirname, '../src/ui/views/DashboardView.tsx'), 'utf8');
    expect(dashboard).not.toMatch(/function StatCard/);
    expect(dashboard).toContain('<StatTile');
  });
});
