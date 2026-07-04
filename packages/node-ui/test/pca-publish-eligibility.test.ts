// @vitest-environment happy-dom
//
// E1 — the S5 publish-eligibility chip: the 4-state fail-toward-loud verdict at
// the moment of spend (green / amber / danger #6 / neutral), and "no chip when
// nothing is tracked". Mocks the PCA fetchers; uses the shared E3 fixtures.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchWalletsBalances: vi.fn(),
  fetchPca: vi.fn(),
  fetchContextGraphs: vi.fn(),
  fetchCurrentAgent: vi.fn(),
  pcaAgentAccount: vi.fn(),
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return {
    ...actual,
    fetchWalletsBalances: mocks.fetchWalletsBalances,
    fetchPca: mocks.fetchPca,
    fetchContextGraphs: mocks.fetchContextGraphs,
    fetchCurrentAgent: mocks.fetchCurrentAgent,
    pcaAgentAccount: mocks.pcaAgentAccount,
  };
});

const { PublishEligibilityChip, PublishEligibilityChipView } = await import('../src/ui/pages/conviction/PublishEligibilityChip.js');
const { usePublishEligibility } = await import('../src/ui/hooks/usePublishEligibility.js');
const { usePcaStore } = await import('../src/ui/stores/pca.js');
const { makePcaSnapshot } = await import('../src/ui/mocks/pca.js');

const W0 = '0x71D4000000000000000000000000000000009Ac2';

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => { root.render(node); });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
}
async function waitForText(c: HTMLElement, text: string) {
  const started = Date.now(); let last = '';
  while (Date.now() - started < 1500) {
    last = c.textContent ?? '';
    if (last.includes(text)) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  throw new Error(`Timed out waiting for "${text}" in "${last}"`);
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  vi.clearAllMocks();
  usePcaStore.setState({ trackedIds: ['7'], createPending: null });
  mocks.fetchContextGraphs.mockResolvedValue({ contextGraphs: [] });
  mocks.fetchCurrentAgent.mockResolvedValue({ agentDid: 'did:dkg:agent:0x' + '9'.repeat(40) });
  // GAP-3 Model B default: NO untracked coverage. The augment only fires when a wallet
  // is cleanly unregistered on every tracked account; this default makes those cases a
  // CONFIRMED fall-through (accountId: null), preserving the pre-Model-B behavior. Tests
  // that exercise untracked coverage override this per-wallet.
  mocks.pcaAgentAccount.mockResolvedValue({ agent: '', accountId: null });
});
afterEach(() => { document.body.innerHTML = ''; });

function walletsBalances(trac: string) {
  return { wallets: [W0], balances: [{ address: W0, eth: '0.1', trac, symbol: 'TRAC' }], chainId: '84532', rpcUrl: null };
}

describe('PublishEligibilityChip (S5)', () => {
  it('renders nothing when the node tracks no PCA', async () => {
    usePcaStore.setState({ trackedIds: [], createPending: null });
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(container.querySelector('[data-testid="pca-publish-eligibility"]')).toBeNull();
    await unmount();
  });

  it('GREEN when every signing wallet is covered by a healthy PCA', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('100'));
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: true } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'Funded by PCA #7');
    expect(container.textContent).toContain('30%');
    await unmount();
  });

  // Q2/#9 — a PCA covers only the TRAC fee; the signer still needs native gas. A
  // covered wallet with confirmed zero gas must NOT render GREEN.
  it('Q2 — a covered wallet with zero gas → DANGER, not eligible', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0],
      balances: [{ address: W0, eth: '0', trac: '100', symbol: 'TRAC' }], // no gas
      chainId: '84532',
      rpcUrl: null,
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: true } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'Publish will fail');
    expect(container.querySelector('[data-verdict="fallthrough-no-funds"]')).toBeTruthy();
    expect(container.querySelector('[data-verdict="eligible"]')).toBeNull();
    expect(container.querySelector('.v10-pca-publish-popover')).toBeNull();
    await unmount();
  });

  it('Q2 — mixed covered wallets (one gas-funded, one gasless) → GREEN', async () => {
    const W1 = '0x' + 'b'.repeat(40);
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0, W1],
      balances: [
        { address: W0, eth: '0.1', trac: '100', symbol: 'TRAC' }, // gas-funded
        { address: W1, eth: '0', trac: '100', symbol: 'TRAC' }, // gasless, but also covered
      ],
      chainId: '84532',
      rpcUrl: null,
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: true } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'Funded by PCA #7'); // ≥1 covered wallet has gas → GREEN
    expect(container.querySelector('[data-verdict="eligible"]')).toBeTruthy();
    expect(container.querySelector('[data-verdict="fallthrough-no-funds"]')).toBeNull();
    await unmount();
  });

  // S2/#9 — adapterSupported:false (the adapter can't answer) is NOT a confirmed
  // not-registered; on a healthy PCA + no-TRAC wallet it must resolve NEUTRAL, not DANGER.
  it('S2 — adapterSupported:false resolves NEUTRAL (unknown), not DANGER', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('0')); // gas-funded, no TRAC
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key
        ? { ...makePcaSnapshot(), probedKey: { key, registered: false, adapterSupported: false } }
        : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'PCA status unknown');
    expect(container.querySelector('[data-verdict="fallthrough-no-funds"]')).toBeNull();
    expect(container.querySelector('[data-verdict="unknown"]')).toBeTruthy();
    await unmount();
  });

  // V1/#1344/#9 — routing S5 registration through the shared normalizer means an
  // OMITTED registered (undefined) is now inconclusive ("couldn't determine"), not a
  // confirmed not-registered → resolves NEUTRAL, never a DANGER. (Now matches overview/S6.)
  it('V1 — a probedKey with registered OMITTED resolves NEUTRAL, not DANGER', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('0')); // gas-funded, no TRAC
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key } } : makePcaSnapshot(), // registered OMITTED
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'PCA status unknown');
    expect(container.querySelector('[data-verdict="fallthrough-no-funds"]')).toBeNull();
    expect(container.querySelector('[data-verdict="unknown"]')).toBeTruthy();
    await unmount();
  });

  // L1 — when wallets are covered by DIFFERENT PCAs, the GREEN chip advertises the
  // MAX covering discount (matching bestCoveringDiscountBps), not covered[0].
  it('GREEN advertises the MAX covering discount across wallets on different PCAs (L1)', async () => {
    const W1 = '0x' + 'b'.repeat(40);
    usePcaStore.setState({ trackedIds: ['7', '8'], createPending: null });
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0, W1],
      balances: [
        { address: W0, eth: '0.1', trac: '100', symbol: 'TRAC' },
        { address: W1, eth: '0.1', trac: '100', symbol: 'TRAC' },
      ],
      chainId: '84532',
      rpcUrl: null,
    });
    const bpsFor = (id: string) => (id === '8' ? 4000 : 1000);
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      const base = makePcaSnapshot({ accountId: id, discountBps: bpsFor(id) });
      if (!key) return base;
      // W0 is approved only on #7 (1000 bps); W1 only on #8 (4000 bps).
      const registered =
        (id === '7' && key.toLowerCase() === W0.toLowerCase()) ||
        (id === '8' && key.toLowerCase() === W1.toLowerCase());
      return { ...base, probedKey: { key, registered } };
    });
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'Funded by PCA #8'); // the 4000-bps account, not #7
    expect(container.textContent).toContain('40%');
    expect(container.textContent).not.toContain('10%');
    await unmount();
  });

  // L2 revert guard — a FRESH funded PCA can hold its budget in the per-epoch
  // allowance with topUpBuffer=0; the topUpBuffer-only proxy false-DANGERed it
  // on the live capstone. On S5's extended path, that budget must be confirmed
  // through remainingAllowance, not guessed from nominal baseEpochAllowance.
  it('GREEN for a funded PCA whose current-epoch remainingAllowance is positive, topUpBuffer=0 (L2 revert guard)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('100'));
    const funded = makePcaSnapshot({
      topUpBuffer: '0',
      topUpBufferTrac: '0',
      baseEpochAllowance: '850000000000000000000',
      remainingAllowance: '850000000000000000000',
      extendedRequested: true,
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...funded, probedKey: { key, registered: true } } : funded,
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'Funded by PCA #7'); // NOT a false out-of-budget DANGER
    expect(container.textContent).not.toContain('Publish will fail');
    expect(container.textContent).not.toContain('No PCA discount');
    await unmount();
  });

  it('does not show GREEN when an extended allowance read fail-softs without remainingAllowance', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('100'));
    const failSoft = makePcaSnapshot({
      topUpBuffer: '0',
      topUpBufferTrac: '0',
      baseEpochAllowance: '850000000000000000000',
      extendedRequested: true,
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...failSoft, probedKey: { key, registered: true } } : failSoft,
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'PCA status unknown');
    expect(container.textContent).not.toContain('Funded by PCA #7');
    expect(container.textContent).not.toContain('Publish will fail');
    await unmount();
  });

  // C1 — `dead` and out-of-budget are independent reason facets; at the chip
  // boundary the important product behavior is still amber fall-through, not a
  // false GREEN or DANGER.
  it('C1: an expired AND out-of-budget approved account resolves AMBER, not green/danger', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('50')); // gas+TRAC → amber fall-through
    const deadBroke = makePcaSnapshot({
      expiresAtTimestamp: Math.floor(Date.now() / 1000) - 86_400, // expired
      topUpBuffer: '0',
      topUpBufferTrac: '0',
      baseEpochAllowance: '0', // out of budget
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...deadBroke, probedKey: { key, registered: true } } : deadBroke,
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'No PCA discount'); // amber (wallet has TRAC)
    expect(container.querySelector('[data-verdict="fallthrough"]')).toBeTruthy();
    expect(container.querySelector('[data-verdict="eligible"]')).toBeNull();
    expect(container.querySelector('[data-verdict="fallthrough-no-funds"]')).toBeNull();
    await unmount();
  });

  // #3 — an approved wallet on a swept/expired PCA is uncovered via HEALTH (not
  // solvency), so the spend-time chip must not render green.
  it('an approved wallet on a SWEPT PCA resolves AMBER, not green (#3)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('50')); // has TRAC → amber
    const swept = makePcaSnapshot({ fullySwept: true });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...swept, probedKey: { key, registered: true } } : swept,
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'No PCA discount'); // amber chip (swept → no discount applies)
    expect(container.querySelector('[data-verdict="fallthrough"]')).toBeTruthy();
    expect(container.querySelector('[data-verdict="eligible"]')).toBeNull();
    await unmount();
  });

  it('DANGER (#6) when a fall-through wallet has NO TRAC → role=alert "Publish will fail"', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('0')); // no TRAC
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: false } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'Publish will fail');
    const label = container.querySelector('.v10-pca-verdict-chip-label')!;
    expect(label.getAttribute('role')).toBe('alert');
    await unmount();
  });

  // R3 — the verdict must track #1327's funding-aware signer selection: a covered
  // wallet + an uncovered/no-TRAC SPARE must NOT assert "will FAIL" (the picker
  // skips the spare). DANGER only when NO wallet can fund.
  it('R3 — covered wallet + uncovered no-TRAC spare → AMBER, not false DANGER', async () => {
    const W1 = '0x' + 'b'.repeat(40);
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0, W1],
      balances: [
        { address: W0, eth: '0.1', trac: '100', symbol: 'TRAC' },
        { address: W1, eth: '0.1', trac: '0', symbol: 'TRAC' }, // spare: no TRAC, uncovered
      ],
      chainId: '84532',
      rpcUrl: null,
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => {
      const registered = !!key && key.toLowerCase() === W0.toLowerCase();
      return { ...makePcaSnapshot(), probedKey: { key, registered } }; // both probes SUCCEED
    });
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'No PCA discount'); // AMBER, not "Publish will fail"
    expect(container.textContent).not.toContain('Publish will fail');
    expect(container.querySelector('[data-verdict="fallthrough-no-funds"]')).toBeNull();
    expect(container.querySelector('[data-verdict="fallthrough"]')).toBeTruthy();
    await unmount();
  });

  it('R3 — all wallets uncovered + 0 TRAC → DANGER (no wallet can fund)', async () => {
    const W1 = '0x' + 'b'.repeat(40);
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0, W1],
      balances: [
        { address: W0, eth: '0.1', trac: '0', symbol: 'TRAC' },
        { address: W1, eth: '0.1', trac: '0', symbol: 'TRAC' },
      ],
      chainId: '84532',
      rpcUrl: null,
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => ({
      ...makePcaSnapshot(),
      probedKey: { key, registered: false },
    }));
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'Publish will fail');
    expect(container.querySelector('[data-verdict="fallthrough-no-funds"]')).toBeTruthy();
    await unmount();
  });

  // V3/#9 — a CONFIRMED-broke wallet + an UNREADABLE-funding wallet must resolve
  // NEUTRAL, not DANGER: the inconclusive wallet may be the funded signer once readable.
  it('V3 — confirmed-broke + an unreadable-funding wallet → unknown, not DANGER', async () => {
    const W1 = '0x' + 'b'.repeat(40);
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0, W1],
      balances: [{ address: W0, eth: '0', trac: '0', symbol: 'TRAC' }], // W1 ABSENT → balanceUnknown
      chainId: '84532',
      rpcUrl: null,
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => ({
      ...makePcaSnapshot(),
      probedKey: { key, registered: false }, // both confirmed not-covered
    }));
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'PCA status unknown');
    expect(container.querySelector('[data-verdict="fallthrough-no-funds"]')).toBeNull();
    expect(container.querySelector('[data-verdict="unknown"]')).toBeTruthy();
    await unmount();
  });

  // C1/#9 — a probe that FAILED (rejected) is "couldn't read", NOT a confirmed
  // fall-through. It must resolve NEUTRAL (unknown), never a DANGER at spend time.
  it('resolves NEUTRAL (unknown), not DANGER, when the coverage probe FAILS (C1/#9)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('0')); // no TRAC — the worst case that previously false-DANGERed
    mocks.fetchPca.mockRejectedValue(new Error('probe down'));
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'PCA status unknown');
    expect(container.textContent).not.toContain('Publish will fail');
    expect(container.querySelector('[data-verdict="fallthrough-no-funds"]')).toBeNull();
    expect(container.querySelector('[data-verdict="unknown"]')).toBeTruthy();
    await unmount();
  });

  it('resolves unknown (not green, not danger) when one wallet is covered and another probe FAILS (C1)', async () => {
    const W1 = '0x' + 'b'.repeat(40);
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0, W1],
      balances: [
        { address: W0, eth: '0.1', trac: '100', symbol: 'TRAC' },
        { address: W1, eth: '0.1', trac: '0', symbol: 'TRAC' }, // no TRAC — would be danger if treated as confirmed
      ],
      chainId: '84532',
      rpcUrl: null,
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => {
      if (key && key.toLowerCase() === W0.toLowerCase()) return { ...makePcaSnapshot(), probedKey: { key, registered: true } };
      throw new Error('probe down'); // W1 probe unreadable → inconclusive
    });
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'PCA status unknown');
    expect(container.querySelector('[data-verdict="fallthrough-no-funds"]')).toBeNull();
    expect(container.querySelector('[data-verdict="eligible"]')).toBeNull(); // inconclusive blocks green
    await unmount();
  });

  // O4/#9 — the balances route returns {balances:[], error} at HTTP 200, so the
  // wb=null guard misses it and gas/TRAC read false from UNREAD data. Must resolve
  // NEUTRAL, never a DANGER from balances we couldn't read.
  it('O4 — resolves NEUTRAL (unknown), not DANGER, when balances are UNREAD (HTTP-200 error)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], error: 'RPC timeout', chainId: '84532', rpcUrl: null });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: false } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'PCA status unknown');
    expect(container.textContent).not.toContain('Publish will fail');
    expect(container.querySelector('[data-verdict="fallthrough-no-funds"]')).toBeNull();
    expect(container.querySelector('[data-verdict="unknown"]')).toBeTruthy();
    await unmount();
  });

  it('O4 — a covering PCA stays GREEN even when balances are unread', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({ wallets: [W0], balances: [], error: 'RPC timeout', chainId: '84532', rpcUrl: null });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: true } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'Funded by PCA #7'); // coverage-driven GREEN is unaffected
    await unmount();
  });

  it('AMBER when a fall-through wallet HAS TRAC (pays the direct cost)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('50')); // has TRAC
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: false } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'No PCA discount');
    const label = container.querySelector('.v10-pca-verdict-chip-label')!;
    expect(label.getAttribute('role')).toBe('alert'); // amber is also loud/assertive
    await unmount();
  });

  it('does not render the retired disclosure or preflight popover', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('50'));
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: false } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'No PCA discount');
    expect(container.querySelector('.v10-pca-verdict-why')).toBeNull();
    expect(container.querySelector('.v10-pca-publish-popover')).toBeNull();
    await unmount();
  });

  // QA #2 — DANGER ("will FAIL") remains blocking at the chip boundary.
  it('DANGER chip warns of failure without rendering retired popover copy (QA #2)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('0')); // no TRAC → danger
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: false } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'Publish will fail');
    expect(container.querySelector('[data-verdict="fallthrough-no-funds"]')).toBeTruthy();
    expect(container.textContent).not.toContain('won’t block the publish');
    expect(container.querySelector('.v10-pca-publish-popover')).toBeNull();
    await unmount();
  });

  // L12 — owner-publish detection must still flow into S5 without changing the
  // chip's fall-through verdict. Full-banner caveat copy is covered in
  // pca-components.test.ts.
  it('keeps owner-publish fall-through at the chip boundary (L12)', async () => {
    const CURATOR = 'did:dkg:agent:0x' + 'a'.repeat(40);
    mocks.fetchContextGraphs.mockResolvedValue({ contextGraphs: [{ id: 'cg', curator: CURATOR }] });
    mocks.fetchCurrentAgent.mockResolvedValue({ agentDid: CURATOR }); // node curates → owner-publish
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('50')); // has TRAC → amber fall-through
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: false } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'No PCA discount');
    expect(container.querySelector('[data-verdict="fallthrough"]')).toBeTruthy();
    await unmount();
  });

  // GAP-3 Model B (#1344) — a signing wallet covered by an account this node DOESN'T
  // track is resolved via pcaAgentAccount → fetchPca → classifyCoverage. The three
  // "deliberate + tested" cases (the lead's required set):

  // (i) wallet → UNTRACKED fundable account ⇒ GREEN, labelled "(not tracked)".
  it('GAP-3 — wallet on an UNTRACKED fundable account resolves GREEN (fixes the false-fallthrough)', async () => {
    usePcaStore.setState({ trackedIds: ['7'], createPending: null }); // tracks #7, NOT #9
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('100'));
    // Unregistered on the tracked account #7; registered + healthy on the untracked #9.
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      const base = makePcaSnapshot({ accountId: id });
      if (!key) return base;
      return { ...base, probedKey: { key, registered: id === '9' } };
    });
    mocks.pcaAgentAccount.mockResolvedValue({ agent: W0, accountId: '9' });
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'Funded by PCA #9');
    expect(container.textContent).toContain('not tracked by this node');
    expect(container.querySelector('[data-verdict="eligible"]')).toBeTruthy();
    await unmount();
  });

  // (ii) wallet → UNTRACKED EXPIRED account ⇒ NOT covered (proves registered ⇏ covered):
  // GAP-3 only DISCOVERS the account; classifyCoverage still decides, so a dead account
  // can never mint a false green.
  it('GAP-3 — wallet on an UNTRACKED EXPIRED account is NOT covered (registered ⇏ covered)', async () => {
    usePcaStore.setState({ trackedIds: ['7'], createPending: null });
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('50')); // has TRAC → amber, not danger
    const expired = (id: string) =>
      makePcaSnapshot({ accountId: id, expiresAtTimestamp: Math.floor(Date.now() / 1000) - 86_400 });
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      const base = id === '9' ? expired(id) : makePcaSnapshot({ accountId: id });
      if (!key) return base;
      return { ...base, probedKey: { key, registered: id === '9' } };
    });
    mocks.pcaAgentAccount.mockResolvedValue({ agent: W0, accountId: '9' });
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'No PCA discount'); // amber fall-through, NOT eligible
    expect(container.querySelector('[data-verdict="eligible"]')).toBeNull();
    expect(container.querySelector('[data-verdict="fallthrough"]')).toBeTruthy();
    await unmount();
  });

  // (iii) tracked fast-path UNCHANGED — a wallet covered by a TRACKED account resolves
  // GREEN without the untracked label and WITHOUT a GAP-3 lookup (the augment is skipped).
  it('GAP-3 — tracked coverage is unchanged (no untracked label, no GAP-3 call)', async () => {
    usePcaStore.setState({ trackedIds: ['7'], createPending: null });
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('100'));
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: true } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'Funded by PCA #7');
    expect(container.textContent).not.toContain('not tracked by this node');
    expect(mocks.pcaAgentAccount).not.toHaveBeenCalled(); // fast-path covered → augment skipped
    await unmount();
  });

  // (iv) the GAP-3 lookup THROWS (transport) → inconclusive (neutral), NEVER DANGER
  // (#9): a wallet unregistered on the tracked set whose reverse-map read fails can't
  // be confirmed as a fall-through.
  it('GAP-3 — pcaAgentAccount throws → unknown (neutral), not DANGER (#9)', async () => {
    usePcaStore.setState({ trackedIds: ['7'], createPending: null });
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('0')); // no TRAC — the worst case
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      const base = makePcaSnapshot({ accountId: id });
      return key ? { ...base, probedKey: { key, registered: false } } : base; // unregistered on tracked
    });
    mocks.pcaAgentAccount.mockRejectedValue(new Error('agent route down'));
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'PCA status unknown');
    expect(container.querySelector('[data-verdict="fallthrough-no-funds"]')).toBeNull();
    expect(container.querySelector('[data-verdict="unknown"]')).toBeTruthy();
    await unmount();
  });

  // (v) accountId:null is a CONFIRMED "on no PCA" → a definitive fall-through, split by
  // balance (#6): has-TRAC → amber "pays direct"; no-TRAC → danger "will FAIL". (The
  // balance signals still populate WalletDetail; only coverage moved to GAP-3.)
  it('GAP-3 — accountId:null confirms fall-through: has-TRAC → amber, no-TRAC → danger (#6)', async () => {
    usePcaStore.setState({ trackedIds: ['7'], createPending: null });
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      const base = makePcaSnapshot({ accountId: id });
      return key ? { ...base, probedKey: { key, registered: false } } : base; // unregistered on tracked
    });
    mocks.pcaAgentAccount.mockResolvedValue({ agent: W0, accountId: null }); // on NO account anywhere

    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('50')); // has TRAC
    const amber = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(amber.container, 'No PCA discount');
    expect(amber.container.querySelector('[data-verdict="fallthrough"]')).toBeTruthy();
    await amber.unmount();

    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('0')); // no TRAC
    const danger = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(danger.container, 'Publish will fail');
    expect(danger.container.querySelector('[data-verdict="fallthrough-no-funds"]')).toBeTruthy();
    await danger.unmount();
  });

  // C (#1357) — complements (ii): an UNTRACKED account that is LIVE (not expired) but has
  // NO budget → 'uncovered' via the OTHER reason facet (sawInsolvent), still NOT covered.
  // Proves registered⇏covered through the out-of-budget branch of the GAP-3 augment too.
  it('GAP-3 — wallet on an UNTRACKED live-but-zero-budget account is NOT covered (out-of-budget)', async () => {
    usePcaStore.setState({ trackedIds: ['7'], createPending: null });
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('50')); // has TRAC → amber, not danger
    const noBudget = (id: string) =>
      makePcaSnapshot({ accountId: id, topUpBuffer: '0', topUpBufferTrac: '0', baseEpochAllowance: '0' }); // live, zero budget
    mocks.fetchPca.mockImplementation(async (id: string, key?: string) => {
      const base = id === '9' ? noBudget(id) : makePcaSnapshot({ accountId: id });
      if (!key) return base;
      return { ...base, probedKey: { key, registered: id === '9' } }; // unregistered on tracked #7, registered on untracked #9
    });
    mocks.pcaAgentAccount.mockResolvedValue({ agent: W0, accountId: '9' });
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'No PCA discount'); // amber fall-through, NOT eligible
    expect(container.querySelector('[data-verdict="eligible"]')).toBeNull();
    expect(container.querySelector('[data-verdict="fallthrough"]')).toBeTruthy();
    await unmount();
  });
});

// #1382 — the pure presentation view: renders a SUPPLIED verdict with no hook / no fetch,
// so LayerActionsWidget can drive it from its single shared read.
describe('PublishEligibilityChipView (pure view)', () => {
  it('renders a supplied GREEN verdict (PCA + discount) without any fetch', async () => {
    const { container, unmount } = await render(
      React.createElement(PublishEligibilityChipView, { verdict: 'eligible', accountId: '7', discountBps: 3000, id: 'v1' }),
    );
    const wrap = container.querySelector('[data-testid="pca-publish-eligibility"]')!;
    expect(wrap).toBeTruthy();
    expect(wrap.getAttribute('id')).toBe('v1');
    expect(container.querySelector('[data-verdict="eligible"]')).toBeTruthy();
    expect(container.textContent).toContain('PCA #7');
    // Pure: it resolves nothing itself.
    expect(mocks.fetchPca).not.toHaveBeenCalled();
    expect(mocks.fetchWalletsBalances).not.toHaveBeenCalled();
    await unmount();
  });

  it('reflects a supplied DANGER verdict with no fetch', async () => {
    const { container, unmount } = await render(
      React.createElement(PublishEligibilityChipView, { verdict: 'fallthrough-no-funds' }),
    );
    expect(container.querySelector('[data-verdict="fallthrough-no-funds"]')).toBeTruthy();
    expect(mocks.fetchPca).not.toHaveBeenCalled();
    await unmount();
  });
});

// #1382 — anyGasFunded is the load-bearing input to the owner-CG gate exception. Test it
// at the HOOK boundary from REAL mocked wallet/PCA responses (not stubbed at the widget),
// so a regression that drops the `|| balanceUnknown` fail-open would be caught here.
describe('usePublishEligibility — anyGasFunded (hook boundary)', () => {
  // Captured hook return; `any` because the harness only reads loading/anyGasFunded/verdict.
  let latestElig: any = null;
  function EligHarness() {
    latestElig = usePublishEligibility('cg', 0);
    return null;
  }
  async function renderElig() {
    latestElig = null;
    const handle = await render(React.createElement(EligHarness));
    for (let i = 0; i < 80 && (latestElig == null || latestElig.loading); i++) {
      await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    }
    return handle;
  }
  // Every signing wallet approved on a healthy PCA (so coverage isn't the fall-through cause).
  const approvedHealthy = (key?: string) =>
    (key ? { ...makePcaSnapshot(), probedKey: { key, registered: true } } : makePcaSnapshot());

  it('all approved wallets confirmed out of gas → anyGasFunded false (owner DANGER stays a gate)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0], balances: [{ address: W0, eth: '0', trac: '100', symbol: 'TRAC' }], chainId: '84532', rpcUrl: null,
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => approvedHealthy(key));
    const h = await renderElig();
    expect(latestElig!.anyGasFunded).toBe(false);
    // Covered but out of gas → the DANGER verdict the gate keys on.
    expect(latestElig!.verdict).toBe('fallthrough-no-funds');
    await h.unmount();
  });

  it('at least one gas-funded wallet → anyGasFunded true', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0], balances: [{ address: W0, eth: '0.1', trac: '100', symbol: 'TRAC' }], chainId: '84532', rpcUrl: null,
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => approvedHealthy(key));
    const h = await renderElig();
    expect(latestElig!.anyGasFunded).toBe(true);
    await h.unmount();
  });

  it('unreadable gas (missing balance entry) → anyGasFunded true (fail-open, mirrors GREEN)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue({
      wallets: [W0], balances: [], chainId: '84532', rpcUrl: null, // no entry for W0 → balanceUnknown
    });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) => approvedHealthy(key));
    const h = await renderElig();
    expect(latestElig!.anyGasFunded).toBe(true);
    await h.unmount();
  });
});
