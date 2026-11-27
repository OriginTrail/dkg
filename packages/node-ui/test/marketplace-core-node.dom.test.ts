// @vitest-environment happy-dom
// The Core node line: each requirement its own item with its check first, in sentence
// case, amounts grouped, and no dots between items. A failed check draws a cross.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreNodeChecks, coreNodeBasics } from '../src/ui/marketplace/shared.js';
import { fmtTracGrouped } from '../src/ui/marketplace/amounts.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TRAC = 10n ** 18n;
const gate = (over: Partial<{ profile: boolean; shardingTable: boolean; stake: string; minimumStake: string }> = {}) => ({
  profile: true, shardingTable: true, stake: String(50_000n * TRAC), minimumStake: String(50_000n * TRAC), ...over,
});

describe('Core node line', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (items: Parameters<typeof CoreNodeChecks>[0]['items']) => act(() => { root.render(React.createElement(CoreNodeChecks, { items })); });
  const items = () => [...container.querySelectorAll('.mkt-corenode-item')].map((el) => ({
    mark: el.querySelector('svg')?.getAttribute('aria-label') ?? null,
    text: el.textContent,
  }));

  it('shows every requirement met as its own checked item', () => {
    render(coreNodeBasics(gate()));
    expect(container.querySelector('.mkt-corenode')?.firstElementChild?.textContent).toBe('Core node');
    expect(items()).toEqual([
      { mark: 'yes', text: 'Profile' },
      { mark: 'yes', text: 'In the sharding table' },
      { mark: 'yes', text: 'Stake 50,000 of 50,000 TRAC minimum' },
    ]);
    expect(container.textContent).not.toMatch(/[·✓✗]/);
  });

  it('crosses what is missing, the stake included when it is under the minimum', () => {
    render(coreNodeBasics(gate({ shardingTable: false, stake: String(49_999n * TRAC) })));
    expect(items().map((i) => i.mark)).toEqual(['yes', 'no', 'no']);
    expect(items()[2]!.text).toBe('Stake 49,999 of 50,000 TRAC minimum');
  });

  it('draws no mark for an item that is not a check', () => {
    render([...coreNodeBasics(gate({ profile: false })), { label: 'Stake factor 1.25' }]);
    expect(items().map((i) => i.mark)).toEqual(['no', 'yes', 'yes', null]);
  });

  it('groups whole TRAC in thousands and keeps the decimals', () => {
    expect(fmtTracGrouped(1_234_567n * TRAC + 5n * 10n ** 17n)).toBe('1,234,567.5');
    expect(fmtTracGrouped(999n * TRAC)).toBe('999');
    expect(fmtTracGrouped(1n)).toBe('<0.0001');
  });
});
