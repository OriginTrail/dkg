// @vitest-environment happy-dom
//
// B8 (#1365 round-3) — the SWM→VM publish CTA (`PublishVmWidget`) renders the confirmed
// DiscountAppliedBadge from the BATCH-level convictionCostCovered, NOT off the headline
// `sample` (chosen for cleanliness, not discount). Also covers the #1382 publish gate:
// PublishVmWidget consumes `useVmPublishGate` (real) over a mocked eligibility verdict, and
// renders the REAL PublishEligibilityChipView (so a dropped/mismatched chip id is caught).

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  listAssertions: vi.fn(),
  knowledgeAssetFinalize: vi.fn(),
  promoteAssertion: vi.fn(),
  publishAssertionsToVm: vi.fn(),
  partialPublishWarning: vi.fn((d?: string) => (d ? `binding incomplete — ${d}` : 'binding incomplete')),
}));

// #1382 — PublishVmWidget drives the CTA gate + chip from `useVmPublishGate`, which owns the
// single S5 read. Mock the eligibility hook so tests drive the verdict deterministically
// (useVmPublishGate stays REAL, and the REAL chip view renders so its aria id is exercised).
const eligMock = vi.hoisted(() => ({ usePublishEligibility: vi.fn() }));

vi.mock('../src/ui/api.js', async (orig) => ({
  ...(await orig<typeof import('../src/ui/api.js')>()),
  listAssertions: apiMocks.listAssertions,
  knowledgeAssetFinalize: apiMocks.knowledgeAssetFinalize,
  promoteAssertion: apiMocks.promoteAssertion,
  publishAssertionsToVm: apiMocks.publishAssertionsToVm,
  partialPublishWarning: apiMocks.partialPublishWarning,
}));

vi.mock('../src/ui/hooks/usePublishEligibility.js', () => ({
  usePublishEligibility: eligMock.usePublishEligibility,
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
  apiMocks.knowledgeAssetFinalize.mockResolvedValue(undefined);
  apiMocks.promoteAssertion.mockResolvedValue({ promotedCount: 1 });
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

  // OTwiA — a publish error is formatted with the RAW message (publish-appropriate), never
  // the promote-specific "an assertion" wording that describePromoteError synthesizes.
  it('formats a publish error with the raw message, never promote wording ("an assertion")', async () => {
    apiMocks.publishAssertionsToVm.mockRejectedValue(new Error('VM publish tx reverted'));
    const { container, unmount } = await render(
      React.createElement(PublishVmWidget, { count: 1, contextGraphId: 'cg' }),
    );
    await clickPublish(container);
    await flush();
    const res = container.querySelector('[data-testid="layer-action-result"]');
    expect(res?.textContent).toContain('VM publish tx reverted');
    expect(res?.textContent).not.toContain('an assertion');
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
  // → pays direct) stay enabled; 'unknown' (inconclusive, also the still-loading verdict —
  // the hook returns 'unknown', never undefined) fails OPEN (#9 — never block on what we
  // can't confirm).
  it.each(['eligible', 'fallthrough', 'unknown'])(
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

  // Shared-eligibility contract (#1382): the widget resolves the verdict ONCE and drives the
  // REAL chip view with it — button and chip can't disagree, one poll, and (OVzKw) the
  // button's aria-describedby points at an element that actually EXISTS in the DOM.
  it('drives the REAL chip from EXACTLY ONE read; aria-describedby points at the rendered chip', async () => {
    eligMock.usePublishEligibility.mockReturnValue({
      verdict: 'eligible', ownerPublish: false, anyGasFunded: false, accountId: '7', discountBps: 3000,
    } as any);
    const { container, unmount } = await render(
      React.createElement(PublishVmWidget, { count: 1, contextGraphId: 'cg' }),
    );
    // ONE shared read: the widget (via useVmPublishGate) polls once; the pure chip doesn't
    // re-poll. A double-poll regression (chip owning its own hook) would make this > 1.
    expect(eligMock.usePublishEligibility).toHaveBeenCalledWith('cg', 30_000);
    expect(eligMock.usePublishEligibility).toHaveBeenCalledTimes(1);
    // The REAL chip rendered the supplied verdict.
    const chip = container.querySelector('[data-testid="pca-publish-eligibility"]');
    expect(chip).toBeTruthy();
    expect(container.querySelector('[data-verdict="eligible"]')).toBeTruthy();
    // Not blocked → aria-describedby is exactly the chip's id AND that element exists.
    const describedby = publishBtn(container).getAttribute('aria-describedby')!;
    expect(describedby.trim().split(/\s+/)).toHaveLength(1);
    expect(document.getElementById(describedby.trim())).toBe(chip);
    await unmount();
  });

  // OT2LV — the promote path never enters the eligibility probe BY CONSTRUCTION: PromoteWidget
  // doesn't consume useVmPublishGate, so the hook isn't called and no chip renders. (The
  // fetcher-level guarantee — no fetchWalletsBalances/fetchPca/fetchContextGraphs — is pinned
  // over the REAL hook in pca-publish-eligibility.test.ts.)
  it('the promote (wm) widget never runs the eligibility probe and renders no chip', async () => {
    setVerdict('eligible');
    const { container, unmount } = await render(
      React.createElement(PromoteWidget, { count: 1, contextGraphId: 'cg' }),
    );
    expect(eligMock.usePublishEligibility).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="pca-publish-eligibility"]')).toBeNull();
    await unmount();
  });

  it('renders no chip when the node tracks no PCA, and the button has NO dangling aria-describedby', async () => {
    usePcaStore.setState({ trackedIds: [] });
    setVerdict('eligible'); // not blocked → no reason node either
    const { container, unmount } = await render(
      React.createElement(PublishVmWidget, { count: 1, contextGraphId: 'cg' }),
    );
    // No chip rendered → its id isn't in the DOM…
    expect(container.querySelector('[data-testid="pca-publish-eligibility"]')).toBeNull();
    // …so the button must not reference it (OVs0A: describedByIds are atomic with targets).
    expect(publishBtn(container).getAttribute('aria-describedby')).toBeNull();
    await unmount();
  });
});

describe('PromoteWidget — promote flow (#1382)', () => {
  const clickPromote = async (c: HTMLElement) =>
    act(async () => { (c.querySelector('[data-testid="widget-promote-all-btn"]') as HTMLButtonElement).click(); });

  it('seals (finalize) each draft BEFORE promoting, threading subGraph through both calls', async () => {
    const order: string[] = [];
    apiMocks.listAssertions.mockResolvedValue([{ name: 'a1', subGraph: 'sg1' }]);
    apiMocks.knowledgeAssetFinalize.mockImplementation(async () => { order.push('finalize'); });
    apiMocks.promoteAssertion.mockImplementation(async () => { order.push('promote'); return { promotedCount: 3 }; });
    const { container, unmount } = await render(
      React.createElement(PromoteWidget, { count: 1, contextGraphId: 'cg' }),
    );
    await clickPromote(container);
    for (let i = 0; i < 30 && order.length < 2; i++) await flush();
    // finalize precedes promote for the draft (a dropped seal would fail this).
    expect(order).toEqual(['finalize', 'promote']);
    // subGraph threaded through BOTH calls (a dropped passthrough would fail this).
    expect(apiMocks.knowledgeAssetFinalize).toHaveBeenCalledWith('cg', 'a1', { subGraphName: 'sg1' });
    expect(apiMocks.promoteAssertion).toHaveBeenCalledWith('cg', 'a1', 'all', 'sg1');
    expect(container.querySelector('[data-testid="layer-action-result"]')?.textContent).toContain('Promoted 3 triples to Shared Memory');
    await unmount();
  });
});
