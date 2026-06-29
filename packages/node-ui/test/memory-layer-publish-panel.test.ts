// @vitest-environment happy-dom
//
// Component test for the SWM→VM "Publish to Verifiable Memory" panel
// (MemoryLayerView's PublishPanel). The panel sources NAMED SWM assertions via
// listAssertions(cg,'swm'), keys selection by `graphUri` (PR #710 — a root + sub-graph
// assertion can share a name), and hands the selected assertions to the shared
// `publishAssertionsToVm` batch helper (api.ts). These tests pin the COMPONENT's
// responsibilities: (1) it forwards the right assertions (resolved from graphUri-keyed
// selection) to the helper, and (2) it renders the aggregate result — the 207 partial
// warning WITH its contextGraphError detail, and a per-KA failure surfaced via failures[]
// without crashing. The helper's own per-KA forwarding + aggregation is unit-tested in
// ui-api-pure.test.ts.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  listAssertions: vi.fn(),
  publishAssertionsToVm: vi.fn(),
  partialPublishWarning: vi.fn(),
}));

vi.mock('../src/ui/api.js', () => ({
  listAssertions: apiMocks.listAssertions,
  publishAssertionsToVm: apiMocks.publishAssertionsToVm,
  partialPublishWarning: apiMocks.partialPublishWarning,
  PARTIAL_PUBLISH_STATUS_SUFFIX: 'binding incomplete',
  // Other api.js members the panel/module references.
  executeQuery: vi.fn(),
  fetchStatus: vi.fn(),
  promoteAssertion: vi.fn(),
  describePromoteResult: vi.fn(),
  describePromoteError: vi.fn(() => null),
}));

// Keep the live-event hook a no-op so the panel doesn't open a real connection.
vi.mock('../src/ui/hooks/useNodeEvents.js', () => ({
  useMemoryGraphEvents: () => {},
  useNodeEvents: () => {},
}));

const { PublishPanel } = await import('../src/ui/views/MemoryLayerView.js');

async function render(node: React.ReactElement): Promise<{
  container: HTMLDivElement;
  unmount: () => Promise<void>;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

/** Flush microtasks/state updates after an async user action. */
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

// One root-bucket assertion (no sub-graph) + one sub-graph-scoped, uniquely identified by
// graphUri. The panel must hand the helper the right { name, subGraph } objects.
const ASSERTIONS = [
  { name: 'alpha', graphUri: 'did:dkg:cg/assertion/0xabc/alpha' },
  { name: 'beta', graphUri: 'did:dkg:cg/sg1/assertion/0xabc/beta', subGraph: 'sg1' },
];

const cleanResult = {
  published: 2, total: 2, sealed: 0, partial: 0, failures: [],
  sample: { status: 'confirmed', txHash: '0xtx', kaId: '0xka' },
};

beforeEach(() => {
  apiMocks.listAssertions.mockReset();
  apiMocks.publishAssertionsToVm.mockReset();
  apiMocks.partialPublishWarning.mockReset();
  apiMocks.listAssertions.mockResolvedValue(ASSERTIONS);
  apiMocks.publishAssertionsToVm.mockResolvedValue(cleanResult);
  // Echo the contextGraphError detail so a dropped detail is observable.
  apiMocks.partialPublishWarning.mockImplementation((detail?: string) =>
    detail ? `binding incomplete — ${detail}` : 'binding incomplete',
  );
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('MemoryLayerView PublishPanel (SWM → VM)', () => {
  it('hands ALL assertions (name + subGraph, resolved from graphUri) to the batch helper', async () => {
    const { container, unmount } = await render(
      React.createElement(PublishPanel, { contextGraphId: 'cg', onPublished: () => {} }),
    );
    await flush();

    const publishAll = container.querySelector('.v10-btn-promote-all') as HTMLButtonElement;
    expect(publishAll, 'Publish All button present once assertions load').toBeTruthy();
    await act(async () => { publishAll.click(); });
    await flush();

    // The component resolves selection and delegates the loop to the shared helper.
    expect(apiMocks.publishAssertionsToVm).toHaveBeenCalledTimes(1);
    expect(apiMocks.publishAssertionsToVm).toHaveBeenCalledWith('cg', ASSERTIONS);
    await unmount();
  });

  it('hands only the SELECTED assertion to the helper, resolved from its graphUri', async () => {
    const { container, unmount } = await render(
      React.createElement(PublishPanel, { contextGraphId: 'cg', onPublished: () => {} }),
    );
    await flush();

    const rowChecks = container.querySelectorAll('.v10-publish-entity-check input[type="checkbox"]');
    expect(rowChecks.length).toBe(2);
    // Select the sub-graph assertion (second row).
    await act(async () => { (rowChecks[1] as HTMLInputElement).click(); });
    await flush();

    const publishSelected = container.querySelector('.v10-btn-publish') as HTMLButtonElement;
    expect(publishSelected, 'Publish-selected button appears after a selection').toBeTruthy();
    await act(async () => { publishSelected.click(); });
    await flush();

    expect(apiMocks.publishAssertionsToVm).toHaveBeenCalledTimes(1);
    expect(apiMocks.publishAssertionsToVm).toHaveBeenCalledWith('cg', [ASSERTIONS[1]]);
    await unmount();
  });

  it('disambiguates same-NAME root vs sub-graph rows by graphUri (hands only the selected one)', async () => {
    // Root and sub-graph assertion share the SAME name — only graphUri distinguishes them.
    apiMocks.listAssertions.mockResolvedValue([
      { name: 'shared', graphUri: 'did:dkg:cg/assertion/0xabc/shared' },
      { name: 'shared', graphUri: 'did:dkg:cg/sg1/assertion/0xabc/shared', subGraph: 'sg1' },
    ]);
    const { container, unmount } = await render(
      React.createElement(PublishPanel, { contextGraphId: 'cg', onPublished: () => {} }),
    );
    await flush();

    const rowChecks = container.querySelectorAll('.v10-publish-entity-check input[type="checkbox"]');
    expect(rowChecks.length).toBe(2);
    // Select ONLY the sub-graph row; name-keyed selection would also match the root 'shared'.
    await act(async () => { (rowChecks[1] as HTMLInputElement).click(); });
    await flush();
    await act(async () => { (container.querySelector('.v10-btn-publish') as HTMLButtonElement).click(); });
    await flush();

    expect(apiMocks.publishAssertionsToVm).toHaveBeenCalledTimes(1);
    const items = apiMocks.publishAssertionsToVm.mock.calls[0][1];
    expect(items).toEqual([{ name: 'shared', graphUri: 'did:dkg:cg/sg1/assertion/0xabc/shared', subGraph: 'sg1' }]);
    await unmount();
  });

  it('renders a WARNING (not a clean success) + the contextGraphError detail on a 207 partial', async () => {
    apiMocks.publishAssertionsToVm.mockResolvedValue({
      published: 1, total: 1, sealed: 0, partial: 1, partialError: 'binding failed', failures: [],
      sample: { status: 'confirmed', txHash: '0xtx', kaId: '0xka', contextGraphError: 'binding failed' },
    });
    const { container, unmount } = await render(
      React.createElement(PublishPanel, { contextGraphId: 'cg', onPublished: () => {} }),
    );
    await flush();
    await act(async () => { (container.querySelector('.v10-btn-promote-all') as HTMLButtonElement).click(); });
    await flush();

    const card = container.querySelector('.v10-publish-result-card');
    expect(card).toBeTruthy();
    // A partial publish must NOT be styled as a clean success.
    expect(card!.className).toContain('error');
    expect(card!.className).not.toContain('success');
    // The panel forwards the daemon's contextGraphError DETAIL to the warning, not drops it.
    expect(apiMocks.partialPublishWarning).toHaveBeenCalledWith('binding failed');
    expect(container.textContent).toContain('binding failed');
    await unmount();
  });

  // B8 (#1365 r3) — the CONFIRMED discount badge reads the BATCH-LEVEL convictionCostCovered,
  // NOT the headline `sample` (which is picked for cleanliness, not discount). Regression
  // guard: a CLEAN non-discount sample alongside a batch-level discount must still render.
  it('B8 — renders the discount badge from the BATCH field even when the clean sample has no discount', async () => {
    apiMocks.publishAssertionsToVm.mockResolvedValue({
      published: 2, total: 2, sealed: 0, partial: 0, failures: [],
      // The headline sample is a clean, NON-discount item (the mixed-batch trap)…
      sample: { status: 'confirmed', txHash: '0xtx', kaId: '0xka' },
      // …but the batch DID draw a discount on another item → badge must render it.
      convictionCostCovered: { accountId: '7', epoch: 1284, baseCost: '1000', discountedCost: '700', drawnFromEpoch: '700', drawnFromTopUp: '0' },
    });
    const { container, unmount } = await render(
      React.createElement(PublishPanel, { contextGraphId: 'cg', onPublished: () => {} }),
    );
    await flush();
    await act(async () => { (container.querySelector('.v10-btn-promote-all') as HTMLButtonElement).click(); });
    await flush();
    const badge = container.querySelector('[data-testid="pca-discount-badge"]');
    expect(badge, 'discount badge renders from the batch field, not the sample').toBeTruthy();
    expect(badge!.textContent).toContain('30%'); // 10000*(1000-700)/1000 = 3000 bps
    expect(badge!.textContent).toContain('PCA #7');
    await unmount();
  });

  it('B8 — renders NO discount badge when the batch has no convictionCostCovered (degrade-hidden #9)', async () => {
    // cleanResult (default) has no convictionCostCovered → no false discount claim.
    const { container, unmount } = await render(
      React.createElement(PublishPanel, { contextGraphId: 'cg', onPublished: () => {} }),
    );
    await flush();
    await act(async () => { (container.querySelector('.v10-btn-promote-all') as HTMLButtonElement).click(); });
    await flush();
    expect(container.querySelector('[data-testid="pca-discount-badge"]')).toBeNull();
    await unmount();
  });

  it('surfaces a per-KA failure (subset-not-sealable) via failures[] without crashing', async () => {
    apiMocks.publishAssertionsToVm.mockResolvedValue({
      published: 0, total: 1, sealed: 0, partial: 0,
      failures: [{ name: 'beta', error: 'Share the full asset to Shared Memory before publishing.' }],
      sample: null,
    });
    const { container, unmount } = await render(
      React.createElement(PublishPanel, { contextGraphId: 'cg', onPublished: () => {} }),
    );
    await flush();
    await act(async () => { (container.querySelector('.v10-btn-promote-all') as HTMLButtonElement).click(); });
    await flush();

    const card = container.querySelector('.v10-publish-result-card');
    expect(card, 'panel renders a result card rather than crashing').toBeTruthy();
    expect(container.textContent).toContain('Share the full asset');
    await unmount();
  });
});
