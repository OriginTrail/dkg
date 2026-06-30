// @vitest-environment happy-dom
//
// §3b — PrimaryNodePicker (presentational): the always-visible required staked-node
// picker. Searchable combobox, node id primary + stake (NO ask), paste-id convenience,
// "this node" indicator, reward-weight donation copy, and loading/error/empty states.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { PrimaryNodePicker } = await import('../src/ui/components/Pca/PrimaryNodePicker.js');
import type { DesignatableNode } from '../src/ui/components/Pca/PrimaryNodePicker.js';

const NODES: DesignatableNode[] = [
  { nodeId: 'peerAAA', identityId: '11', stake: '50000000000000000000000' }, // 50000 TRAC
  { nodeId: 'peerBBB', identityId: '22', stake: '120000000000000000000000' }, // 120000 TRAC
  { nodeId: 'peerCCC', identityId: '33', stake: '7000000000000000000000' }, // 7000 TRAC
];

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(node); });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}
async function click(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}
async function mouseDown(el: Element) {
  await act(async () => { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
}
async function focus(el: Element) {
  // React (root delegation) maps onFocus to the native `focusin` event, which bubbles.
  await act(async () => { el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
}
function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const opts = (c: HTMLElement) => Array.from(c.querySelectorAll('[data-testid="pca-primary-node-option"]'));

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});
afterEach(() => { document.body.innerHTML = ''; });

describe('PrimaryNodePicker', () => {
  function base(overrides: Partial<React.ComponentProps<typeof PrimaryNodePicker>> = {}) {
    return React.createElement(PrimaryNodePicker, {
      nodes: NODES, loading: false, error: false, onRetry: vi.fn(),
      value: '', onChange: vi.fn(), ...overrides,
    });
  }

  it('renders the staked nodes (id + stake) and never shows an ask column', async () => {
    const { container, unmount } = await render(base());
    await focus(container.querySelector('[data-testid="pca-primary-node-search"]')!);
    const rows = opts(container);
    expect(rows.length).toBe(3);
    expect(container.textContent).toContain('#11');
    expect(container.textContent).toContain('50,000 TRAC staked'); // wei→TRAC
    expect(container.textContent?.toLowerCase()).not.toContain('ask');
    await unmount();
  });

  it('M1 — a required combobox exposes aria-required + aria-invalid until a node is picked', async () => {
    const unpicked = await render(base({ required: true, value: '' }));
    const input = unpicked.container.querySelector('[data-testid="pca-primary-node-search"]') as HTMLInputElement;
    expect(input.getAttribute('aria-required')).toBe('true');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await unpicked.unmount();
    const picked = await render(base({ required: true, value: '22' }));
    const input2 = picked.container.querySelector('[data-testid="pca-primary-node-search"]') as HTMLInputElement;
    expect(input2.getAttribute('aria-invalid')).toBe('false');
    await picked.unmount();
  });

  it('M11 — ArrowDown highlights an option (aria-activedescendant) and Enter selects it', async () => {
    const onChange = vi.fn();
    const { container, unmount } = await render(base({ onChange }));
    const input = container.querySelector('[data-testid="pca-primary-node-search"]') as HTMLInputElement;
    await focus(input); // open the popup
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    // aria-activedescendant tracks the first option (node #11, as-passed order).
    expect(input.getAttribute('aria-activedescendant')).toContain('-opt-11');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith('11');
    await unmount();
  });

  it('search filters by id', async () => {
    const { container, unmount } = await render(base());
    const search = container.querySelector('[data-testid="pca-primary-node-search"]') as HTMLInputElement;
    await focus(search);
    setInput(search, '22');
    await act(async () => {});
    const rows = opts(container);
    expect(rows.length).toBe(1);
    expect(rows[0]!.textContent).toContain('#22');
    await unmount();
  });

  it('clicking an option calls onChange with its identityId', async () => {
    const onChange = vi.fn();
    const { container, unmount } = await render(base({ onChange }));
    await focus(container.querySelector('[data-testid="pca-primary-node-search"]')!);
    await mouseDown(opts(container).find((o) => o.textContent?.includes('#33'))!);
    expect(onChange).toHaveBeenCalledWith('33');
    await unmount();
  });

  it('marks the node’s own staked identity with a "this node" indicator', async () => {
    const { container, unmount } = await render(base({ ownIdentityId: '22', role: 'core' }));
    await focus(container.querySelector('[data-testid="pca-primary-node-search"]')!);
    const ownRow = opts(container).find((o) => o.textContent?.includes('#22'))!;
    expect(ownRow.textContent).toContain('✓ this node');
    await unmount();
  });

  it('paste a valid id → onChange; an unknown id → inline error, no onChange', async () => {
    const onChange = vi.fn();
    const { container, unmount } = await render(base({ onChange }));
    const paste = container.querySelector('[data-testid="pca-primary-node-paste"]') as HTMLInputElement;
    setInput(paste, '11');
    await click(container.querySelector('[data-testid="pca-primary-node-paste-use"]')!);
    expect(onChange).toHaveBeenCalledWith('11');

    onChange.mockClear();
    setInput(paste, '999');
    await click(container.querySelector('[data-testid="pca-primary-node-paste-use"]')!);
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="pca-primary-node-paste-error"]')?.textContent)
      .toContain('Not a staked sharding-table node');
    await unmount();
  });

  it('shows the honest reward-weight donation copy for edge / no own identity', async () => {
    const { container, unmount } = await render(base({ role: 'edge', value: '33' }));
    expect(container.querySelector('[data-testid="pca-primary-node-donation"]')?.textContent)
      .toContain('accrues to the node you pick');
    await unmount();
  });

  it('core picking a node other than itself gets a heads-up (not the donation copy)', async () => {
    const { container, unmount } = await render(base({ role: 'core', ownIdentityId: '11', value: '22' }));
    expect(container.querySelector('[data-testid="pca-primary-node-heads-up"]')?.textContent)
      .toContain('instead of this node');
    expect(container.querySelector('[data-testid="pca-primary-node-donation"]')).toBeNull();
    await unmount();
  });

  it('loading / error(+retry) / empty states', async () => {
    const onRetry = vi.fn();
    let h = await render(base({ loading: true }));
    expect(h.container.textContent).toContain('Loading staked nodes');
    expect(h.container.querySelector('[data-testid="pca-primary-node-search"]')).toBeNull();
    await h.unmount();

    h = await render(base({ error: true, onRetry }));
    expect(h.container.querySelector('[data-testid="pca-primary-node-error"]')).toBeTruthy();
    await click(h.container.querySelector('[data-testid="pca-primary-node-retry"]')!);
    expect(onRetry).toHaveBeenCalled();
    await h.unmount();

    h = await render(base({ nodes: [] }));
    expect(h.container.textContent).toContain('No staked nodes found');
    await h.unmount();
  });

  it('exposes combobox + listbox roles (a11y)', async () => {
    const { container, unmount } = await render(base());
    const combo = container.querySelector('[role="combobox"]') as HTMLElement;
    expect(combo).toBeTruthy();
    await focus(combo);
    expect(combo.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[role="listbox"]')).toBeTruthy();
    expect(container.querySelectorAll('[role="option"]').length).toBe(3);
    await unmount();
  });
});
