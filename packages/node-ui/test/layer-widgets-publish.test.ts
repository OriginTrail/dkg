// @vitest-environment happy-dom
//
// B8 (#1365 round-3) — the SWM→VM publish CTA in `layer-widgets` (LayerActionsWidget)
// renders the confirmed DiscountAppliedBadge from the BATCH-level convictionCostCovered,
// NOT off the headline `sample` (which is chosen for cleanliness, not discount). This is
// the layer-widgets badge render path the round-3 reviewer flagged as uncovered.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  listAssertions: vi.fn(),
  publishAssertionsToVm: vi.fn(),
  partialPublishWarning: vi.fn((d?: string) => (d ? `binding incomplete — ${d}` : 'binding incomplete')),
}));

// #1382 — LayerActionsWidget now reads the S5 verdict directly to hard-gate the VM
// publish CTA. Mock the hook so tests drive the verdict deterministically.
const eligMock = vi.hoisted(() => ({ usePublishEligibility: vi.fn() }));

vi.mock('../src/ui/api.js', async (orig) => ({
  ...(await orig<typeof import('../src/ui/api.js')>()),
  listAssertions: apiMocks.listAssertions,
  publishAssertionsToVm: apiMocks.publishAssertionsToVm,
  partialPublishWarning: apiMocks.partialPublishWarning,
}));

vi.mock('../src/ui/hooks/usePublishEligibility.js', () => ({
  usePublishEligibility: eligMock.usePublishEligibility,
}));

// The S5 PREDICTIVE chip is a separate surface (+ would pull in the PCA fetchers) — no-op
// it so this test isolates the CONFIRMED badge render path.
vi.mock('../src/ui/pages/conviction/PublishEligibilityChip.js', () => ({
  PublishEligibilityChip: () => null,
}));

const { LayerActionsWidget } = await import('../src/ui/views/project/components/layer-widgets.js');

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(node); });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}
async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}
const clickPublish = async (c: HTMLElement) =>
  act(async () => { (c.querySelector('[data-testid="widget-publish-vm-btn"]') as HTMLButtonElement).click(); });

beforeEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  apiMocks.listAssertions.mockResolvedValue([{ name: 'a', graphUri: 'g' }]);
  // Default: an inconclusive verdict never gates (fail-open) — so the B8 badge tests
  // publish freely. Gate tests override per-verdict.
  eligMock.usePublishEligibility.mockReturnValue({ verdict: 'unknown', ownerPublish: false } as any);
});
afterEach(() => { document.body.innerHTML = ''; });

describe('LayerActionsWidget — B8 confirmed discount badge (#1365 r3)', () => {
  it('renders the badge from the BATCH convictionCostCovered even when the clean sample has none', async () => {
    apiMocks.publishAssertionsToVm.mockResolvedValue({
      published: 1, total: 1, sealed: 0, partial: 0, failures: [],
      sample: { status: 'confirmed', txHash: '0xtx', kaId: '0xka' }, // clean, NO discount on the sample
      convictionCostCovered: { accountId: '7', epoch: 1284, baseCost: '1000', discountedCost: '700', drawnFromEpoch: '700', drawnFromTopUp: '0' },
    });
    const { container, unmount } = await render(
      React.createElement(LayerActionsWidget, { layer: 'swm', count: 1, contextGraphId: 'cg' }),
    );
    await clickPublish(container);
    await flush();
    const badge = container.querySelector('[data-testid="pca-discount-badge"]');
    expect(badge, 'badge renders from the batch field, not the sample').toBeTruthy();
    expect(badge!.textContent).toContain('30%');
    expect(badge!.textContent).toContain('PCA #7');
    await unmount();
  });

  it('renders NO badge when the batch drew no discount (degrade-hidden #9)', async () => {
    apiMocks.publishAssertionsToVm.mockResolvedValue({
      published: 1, total: 1, sealed: 0, partial: 0, failures: [],
      sample: { status: 'confirmed', txHash: '0xtx', kaId: '0xka' },
      // no convictionCostCovered on the batch
    });
    const { container, unmount } = await render(
      React.createElement(LayerActionsWidget, { layer: 'swm', count: 1, contextGraphId: 'cg' }),
    );
    await clickPublish(container);
    await flush();
    expect(container.querySelector('[data-testid="pca-discount-badge"]')).toBeNull();
    await unmount();
  });
});

describe('LayerActionsWidget — S5 publish CTA gate (#1382)', () => {
  const publishBtn = (c: HTMLElement) =>
    c.querySelector('[data-testid="widget-publish-vm-btn"]') as HTMLButtonElement;
  const setVerdict = (verdict: unknown, ownerPublish = false) =>
    eligMock.usePublishEligibility.mockReturnValue({ verdict, ownerPublish } as any);

  it('GATES the VM publish CTA on a DANGER (fallthrough-no-funds) verdict via aria-disabled + tooltip', async () => {
    setVerdict('fallthrough-no-funds');
    const { container, unmount } = await render(
      React.createElement(LayerActionsWidget, { layer: 'swm', count: 1, contextGraphId: 'cg' }),
    );
    const btn = publishBtn(container);
    // Policy gate uses aria-disabled (SR/keyboard reachable), NOT native disabled.
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('title')).toContain('Publish will fail');
    // The reason is AT-reachable: aria-describedby points at a node carrying the cause.
    const describedby = btn.getAttribute('aria-describedby') ?? '';
    const reasonId = describedby.split(' ').pop()!;
    // useId() ids contain colons → use an attribute selector, not `#id` (invalid CSS).
    expect(container.querySelector(`[id="${reasonId}"]`)?.textContent).toContain('coverage or gas');
    await unmount();
  });

  it('a gated click is a NO-OP (never starts the publish)', async () => {
    setVerdict('fallthrough-no-funds');
    const { container, unmount } = await render(
      React.createElement(LayerActionsWidget, { layer: 'swm', count: 1, contextGraphId: 'cg' }),
    );
    await clickPublish(container);
    await flush();
    expect(apiMocks.listAssertions).not.toHaveBeenCalled();
    expect(apiMocks.publishAssertionsToVm).not.toHaveBeenCalled();
    await unmount();
  });

  // #1382 owner-CG bug: on an owner publish the registration escrow can still cover the
  // cost, so fallthrough-no-funds is NOT definitive — the button must stay ENABLED.
  it('does NOT gate on fallthrough-no-funds when ownerPublish is true (escrow may cover)', async () => {
    setVerdict('fallthrough-no-funds', true);
    const { container, unmount } = await render(
      React.createElement(LayerActionsWidget, { layer: 'swm', count: 1, contextGraphId: 'cg' }),
    );
    const btn = publishBtn(container);
    expect(btn.getAttribute('aria-disabled')).toBeNull();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('title')).toBeNull();
    await unmount();
  });

  // CTA POLICY: gate ONLY the terminal no-funds case. 'eligible'/'fallthrough' (has TRAC
  // → pays direct) stay enabled; 'unknown' (inconclusive) and a still-loading/undefined
  // verdict fail OPEN (#9 — never block on what we can't confirm).
  it.each(['eligible', 'fallthrough', 'unknown', undefined])(
    'keeps the VM publish CTA ENABLED on a %s verdict',
    async (verdict) => {
      setVerdict(verdict);
      const { container, unmount } = await render(
        React.createElement(LayerActionsWidget, { layer: 'swm', count: 1, contextGraphId: 'cg' }),
      );
      const btn = publishBtn(container);
      expect(btn.getAttribute('aria-disabled')).toBeNull();
      expect(btn.disabled).toBe(false);
      expect(btn.getAttribute('title')).toBeNull();
      await unmount();
    },
  );

  it('never gates the PROMOTE (wm) CTA, even on a DANGER verdict', async () => {
    setVerdict('fallthrough-no-funds');
    const { container, unmount } = await render(
      React.createElement(LayerActionsWidget, { layer: 'wm', count: 1, contextGraphId: 'cg' }),
    );
    const btn = container.querySelector('[data-testid="widget-promote-all-btn"]') as HTMLButtonElement;
    expect(btn.getAttribute('aria-disabled')).toBeNull();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('title')).toBeNull();
    await unmount();
  });
});
