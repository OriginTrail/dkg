// @vitest-environment happy-dom
//
// B8 (#1365 round-3) — the SWM→VM publish CTA (`PublishVmWidget`) renders the confirmed
// DiscountAppliedBadge from the BATCH-level convictionCostCovered, NOT off the headline
// `sample` (chosen for cleanliness, not discount). Also covers the #1382 publish gate:
// PublishVmWidget consumes `useVmPublishGate` (real) over a mocked eligibility verdict.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  listAssertions: vi.fn(),
  publishAssertionsToVm: vi.fn(),
  partialPublishWarning: vi.fn((d?: string) => (d ? `binding incomplete — ${d}` : 'binding incomplete')),
}));

// #1382 — PublishVmWidget drives the CTA gate + chip from `useVmPublishGate`, which owns the
// single S5 read. Mock the eligibility hook so tests drive the verdict deterministically
// (useVmPublishGate stays REAL), and spy the PURE chip VIEW to capture the props it receives.
const eligMock = vi.hoisted(() => ({ usePublishEligibility: vi.fn() }));
const chipViewMock = vi.hoisted(() => ({ PublishEligibilityChipView: vi.fn((_props: any) => null) }));

vi.mock('../src/ui/api.js', async (orig) => ({
  ...(await orig<typeof import('../src/ui/api.js')>()),
  listAssertions: apiMocks.listAssertions,
  publishAssertionsToVm: apiMocks.publishAssertionsToVm,
  partialPublishWarning: apiMocks.partialPublishWarning,
}));

vi.mock('../src/ui/hooks/usePublishEligibility.js', () => ({
  usePublishEligibility: eligMock.usePublishEligibility,
}));

// Spy the pure chip view (no fetch) so we can assert the widget passes it the exact
// verdict from its single read, and isolate the CONFIRMED-badge render path.
vi.mock('../src/ui/pages/conviction/PublishEligibilityChip.js', () => ({
  PublishEligibilityChipView: chipViewMock.PublishEligibilityChipView,
}));

const { PromoteWidget, PublishVmWidget } = await import('../src/ui/views/project/components/layer-widgets.js');
const { usePcaStore } = await import('../src/ui/stores/pca.js');

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
  // Track a PCA so the chip guard (trackedIds.length > 0) is satisfied by default.
  usePcaStore.setState({ trackedIds: ['7'], createPending: null });
  // Default: an inconclusive verdict never gates (fail-open) — so the B8 badge tests
  // publish freely. Gate tests override per-verdict.
  eligMock.usePublishEligibility.mockReturnValue({ verdict: 'unknown', ownerPublish: false, anyGasFunded: false } as any);
});
afterEach(() => { document.body.innerHTML = ''; });

describe('PublishVmWidget — B8 confirmed discount badge (#1365 r3)', () => {
  it('renders the badge from the BATCH convictionCostCovered even when the clean sample has none', async () => {
    apiMocks.publishAssertionsToVm.mockResolvedValue({
      published: 1, total: 1, sealed: 0, partial: 0, failures: [],
      sample: { status: 'confirmed', txHash: '0xtx', kaId: '0xka' }, // clean, NO discount on the sample
      convictionCostCovered: { accountId: '7', epoch: 1284, baseCost: '1000', discountedCost: '700', drawnFromEpoch: '700', drawnFromTopUp: '0' },
    });
    const { container, unmount } = await render(
      React.createElement(PublishVmWidget, { count: 1, contextGraphId: 'cg' }),
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
      React.createElement(PublishVmWidget, { count: 1, contextGraphId: 'cg' }),
    );
    await clickPublish(container);
    await flush();
    expect(container.querySelector('[data-testid="pca-discount-badge"]')).toBeNull();
    await unmount();
  });
});

describe('PublishVmWidget — S5 publish CTA gate (#1382)', () => {
  const publishBtn = (c: HTMLElement) =>
    c.querySelector('[data-testid="widget-publish-vm-btn"]') as HTMLButtonElement;
  const setVerdict = (verdict: unknown, ownerPublish = false, anyGasFunded = false) =>
    eligMock.usePublishEligibility.mockReturnValue({ verdict, ownerPublish, anyGasFunded } as any);

  it('GATES the VM publish CTA on a DANGER (fallthrough-no-funds) verdict via aria-disabled + tooltip', async () => {
    setVerdict('fallthrough-no-funds');
    const { container, unmount } = await render(
      React.createElement(PublishVmWidget, { count: 1, contextGraphId: 'cg' }),
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
      React.createElement(PublishVmWidget, { count: 1, contextGraphId: 'cg' }),
    );
    await clickPublish(container);
    await flush();
    expect(apiMocks.listAssertions).not.toHaveBeenCalled();
    expect(apiMocks.publishAssertionsToVm).not.toHaveBeenCalled();
    await unmount();
  });

  // #1382 owner-CG exception: the registration escrow covers the TRAC fee, so an owner
  // publish with a gas-funded wallet stays ENABLED even on fallthrough-no-funds.
  it('does NOT gate on fallthrough-no-funds when ownerPublish AND a wallet has gas (escrow may cover)', async () => {
    setVerdict('fallthrough-no-funds', true, true);
    const { container, unmount } = await render(
      React.createElement(PublishVmWidget, { count: 1, contextGraphId: 'cg' }),
    );
    const btn = publishBtn(container);
    expect(btn.getAttribute('aria-disabled')).toBeNull();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('title')).toBeNull();
    await unmount();
  });

  // #1382 review MUST-FIX: escrow covers TRAC, NOT gas — so an owner publish with EVERY
  // wallet out of gas still fails on-chain and MUST stay gated (the owner exception must
  // not bypass a confirmed no-gas failure).
  it('STILL gates an owner publish when no wallet has gas (escrow does not cover gas)', async () => {
    setVerdict('fallthrough-no-funds', true, false);
    const { container, unmount } = await render(
      React.createElement(PublishVmWidget, { count: 1, contextGraphId: 'cg' }),
    );
    const btn = publishBtn(container);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('title')).toContain('Publish will fail');
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
        React.createElement(PublishVmWidget, { count: 1, contextGraphId: 'cg' }),
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
      React.createElement(PromoteWidget, { count: 1, contextGraphId: 'cg' }),
    );
    const btn = container.querySelector('[data-testid="widget-promote-all-btn"]') as HTMLButtonElement;
    expect(btn.getAttribute('aria-disabled')).toBeNull();
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('title')).toBeNull();
    await unmount();
  });

  // Shared-eligibility contract (#1382): the widget resolves the verdict ONCE and drives
  // the pure chip view with it — button and chip can't disagree, and there's one poll.
  it('drives the pure chip view with the exact verdict from its single read', async () => {
    setVerdict('eligible');
    const { unmount } = await render(
      React.createElement(PublishVmWidget, { count: 1, contextGraphId: 'cg' }),
    );
    // Single shared read via useVmPublishGate: the hook is called once with (cg, 30s).
    expect(eligMock.usePublishEligibility).toHaveBeenCalledWith('cg', 30_000);
    // The pure view received the exact verdict from that read.
    expect(chipViewMock.PublishEligibilityChipView).toHaveBeenCalled();
    const props = chipViewMock.PublishEligibilityChipView.mock.calls.at(-1)![0];
    expect(props.verdict).toBe('eligible');
    await unmount();
  });

  // OT2LV — the promote path never enters the eligibility probe BY CONSTRUCTION: PromoteWidget
  // doesn't consume useVmPublishGate, so the hook isn't called and no chip renders. (The
  // fetcher-level guarantee — no fetchWalletsBalances/fetchPca/fetchContextGraphs — is pinned
  // over the REAL hook in pca-publish-eligibility.test.ts.)
  it('the promote (wm) widget never runs the eligibility probe and renders no chip', async () => {
    setVerdict('eligible');
    const { unmount } = await render(
      React.createElement(PromoteWidget, { count: 1, contextGraphId: 'cg' }),
    );
    expect(eligMock.usePublishEligibility).not.toHaveBeenCalled();
    expect(chipViewMock.PublishEligibilityChipView).not.toHaveBeenCalled();
    await unmount();
  });

  it('renders no chip when the node tracks no PCA (guard preserved)', async () => {
    usePcaStore.setState({ trackedIds: [] });
    setVerdict('eligible');
    const { unmount } = await render(
      React.createElement(PublishVmWidget, { count: 1, contextGraphId: 'cg' }),
    );
    expect(chipViewMock.PublishEligibilityChipView).not.toHaveBeenCalled();
    await unmount();
  });
});
