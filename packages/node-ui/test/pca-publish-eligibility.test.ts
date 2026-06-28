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
}));

vi.mock('../src/ui/api.js', async (orig) => {
  const actual = await orig<typeof import('../src/ui/api.js')>();
  return {
    ...actual,
    fetchWalletsBalances: mocks.fetchWalletsBalances,
    fetchPca: mocks.fetchPca,
    fetchContextGraphs: mocks.fetchContextGraphs,
    fetchCurrentAgent: mocks.fetchCurrentAgent,
  };
});

const { PublishEligibilityChip } = await import('../src/ui/pages/conviction/PublishEligibilityChip.js');
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
    // The danger foot mentions gas (a PCA covers only the TRAC fee), keeps "fail on-chain".
    const why = container.querySelector('.v10-pca-verdict-why') as HTMLButtonElement;
    await act(async () => { why.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'needs native gas');
    expect(container.querySelector('.v10-pca-publish-foot')?.textContent).toContain('would fail on-chain');
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
    // L8 — the gas popover row stays informational (neutral) under the GREEN verdict.
    const why = container.querySelector('.v10-pca-verdict-why') as HTMLButtonElement;
    await act(async () => { why.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const gasRow = Array.from(container.querySelectorAll('.v10-pca-publish-cond')).find((li) =>
      li.textContent?.toLowerCase().includes('gas'),
    )!;
    expect(gasRow.getAttribute('data-tone')).toBe('neutral');
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

  // L2 revert guard — a FRESH funded PCA holds its budget in baseEpochAllowance
  // (per-epoch cap) with topUpBuffer=0; the topUpBuffer-only proxy false-DANGERed
  // it on the live capstone. Coarse proxy: any budget capacity ⇒ GREEN.
  it('GREEN for a funded PCA whose budget is in baseEpochAllowance, topUpBuffer=0 (L2 revert guard)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('100'));
    const funded = makePcaSnapshot({ topUpBuffer: '0', topUpBufferTrac: '0', baseEpochAllowance: '850000000000000000000' });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...funded, probedKey: { key, registered: true } } : funded,
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'Funded by PCA #7'); // NOT a false out-of-budget DANGER
    expect(container.textContent).not.toContain('Publish will fail');
    expect(container.textContent).not.toContain('No PCA discount');
    await unmount();
  });

  // #3 — an approved wallet on a swept/expired PCA is uncovered via HEALTH (not
  // solvency), and reads "approved … but swept", never a misleading "no PCA".
  it('an approved wallet on a SWEPT PCA reads "approved … but swept", not "no PCA" (#3)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('50')); // has TRAC → amber
    const swept = makePcaSnapshot({ fullySwept: true });
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...swept, probedKey: { key, registered: true } } : swept,
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'No PCA discount'); // amber chip (swept → no discount applies)
    const why = container.querySelector('.v10-pca-verdict-why') as HTMLButtonElement;
    await act(async () => { why.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'approved on PCA #7, but it’s swept/expired');
    expect(container.textContent).not.toContain('no PCA → pays direct cost');
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

  it('"why?" opens the preflight popover with the per-condition breakdown (gas row informational, L8)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('50'));
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: false } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'No PCA discount');
    const why = container.querySelector('.v10-pca-verdict-why') as HTMLButtonElement;
    await act(async () => { why.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'All signing wallets approved');
    expect(container.querySelector('.v10-pca-publish-popover')).toBeTruthy();
    // L8 — the gas row is informational (neutral), never a ⚠ that contradicts the verdict.
    const gasRow = Array.from(container.querySelectorAll('.v10-pca-publish-cond')).find((li) =>
      li.textContent?.toLowerCase().includes('gas is separate'),
    )!;
    expect(gasRow).toBeTruthy();
    expect(gasRow.getAttribute('data-tone')).toBe('neutral');
    // QA #2 — AMBER is non-blocking, so the "won't block" fix-footer is correct here.
    expect(container.textContent).toContain('won’t block the publish');
    await unmount();
  });

  // QA #2 — DANGER ("will FAIL") is BLOCKING, so the amber "won't block" footer is
  // wrong; it must read as a blocking-failure fix instead.
  it('DANGER popover footer warns of on-chain failure, NOT "won’t block" (QA #2)', async () => {
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('0')); // no TRAC → danger
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: false } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'Publish will fail');
    const why = container.querySelector('.v10-pca-verdict-why') as HTMLButtonElement;
    await act(async () => { why.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'would fail on-chain');
    const foot = container.querySelector('.v10-pca-publish-foot')!;
    expect(foot.textContent).not.toContain('won’t block the publish');
    await unmount();
  });

  // L12 — the #4 escrow caveat must fire on owner-publishes (node curates the
  // target CG). Pre-fix it never did because the CG list has no isCurator/role —
  // the owner signal is cg.curator vs the node's agentDid.
  it('appends the #4 escrow caveat on an owner-publish, sourced from cg.curator vs agentDid (L12)', async () => {
    const CURATOR = 'did:dkg:agent:0x' + 'a'.repeat(40);
    mocks.fetchContextGraphs.mockResolvedValue({ contextGraphs: [{ id: 'cg', curator: CURATOR }] });
    mocks.fetchCurrentAgent.mockResolvedValue({ agentDid: CURATOR }); // node curates → owner-publish
    mocks.fetchWalletsBalances.mockResolvedValue(walletsBalances('50')); // has TRAC → amber fall-through
    mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
      key ? { ...makePcaSnapshot(), probedKey: { key, registered: false } } : makePcaSnapshot(),
    );
    const { container, unmount } = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
    await waitForText(container, 'No PCA discount');
    // The escrow caveat lives in the full banner (popover), not the chip label.
    const why = container.querySelector('.v10-pca-verdict-why') as HTMLButtonElement;
    await act(async () => { why.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitForText(container, 'registration escrow already covers it');
    await unmount();
  });
});
