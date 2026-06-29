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

vi.mock('../src/ui/api.js', async (orig) => ({
  ...(await orig<typeof import('../src/ui/api.js')>()),
  listAssertions: apiMocks.listAssertions,
  publishAssertionsToVm: apiMocks.publishAssertionsToVm,
  partialPublishWarning: apiMocks.partialPublishWarning,
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
