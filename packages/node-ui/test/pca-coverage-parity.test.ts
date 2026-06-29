// @vitest-environment happy-dom
//
// #1344 cross-consumer PARITY (anti-drift), TABLE-DRIVEN — the three coverage
// surfaces share `src/ui/pca/coverage.ts` (the leaf rules that drifted across
// C1/O4/Q2/S2/U2/V3). Each row feeds ONE fixture (a PCA snapshot + a per-wallet
// probe) through the SINGLE `classifyCoverage` and asserts all three surfaces
// classify it identically — covers / inconclusive / registered-but-uncovered —
// so they can't re-diverge. One driver, one row per scenario (adding a case is a
// table row, not a copied render block). Surfaces pinned:
//   - S5 `PublishEligibilityChip` (usePublishEligibility) → the chip verdict,
//   - S6 `GetSponsoredPanel`       → the per-wallet approval-check outcome,
//   - `usePcaOverview`             → registered / approvedCount / covered / bestBps.

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

const { PublishEligibilityChip } = await import('../src/ui/pages/conviction/PublishEligibilityChip.js');
const { GetSponsoredPanel } = await import('../src/ui/pages/conviction/GetSponsoredPanel.js');
const { usePcaOverview } = await import('../src/ui/hooks/usePcaOverview.js');
const { usePcaStore } = await import('../src/ui/stores/pca.js');
const { makePcaSnapshot } = await import('../src/ui/mocks/pca.js');
const { classifyCoverage } = await import('../src/ui/pca/coverage.js');
import type { PcaOverview } from '../src/ui/hooks/usePcaOverview.js';
import type { PcaSnapshot, PcaProbedKey } from '../src/ui/api.js';

const W0 = '0x71D4000000000000000000000000000000009Ac2';
const ACCOUNT = '7';

// ── shared harness helpers (mirrors the consumer tests) ──────────────────────
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
function setInputValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// usePcaOverview is a shared-poller hook — drive it through a Harness capturing
// its latest return, exactly like pca-overview-hook.test.ts.
let latestOverview: PcaOverview | null = null;
function OverviewHarness() {
  latestOverview = usePcaOverview(0); // intervalMs 0 → load once
  return null;
}
async function renderOverview() {
  latestOverview = null;
  const handle = await render(React.createElement(OverviewHarness));
  for (let i = 0; i < 80 && (latestOverview == null || latestOverview.loading); i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
  return handle;
}

// Wire the per-surface fetchers to ONE fixture: the account snapshot for the
// bare call, the snapshot + probe for a per-wallet call. Wallet is gas+TRAC
// funded so S5's verdict is coverage-driven (not a gas/TRAC fall-through).
function wire(snap: PcaSnapshot, probe: PcaProbedKey) {
  mocks.fetchWalletsBalances.mockResolvedValue({
    wallets: [W0],
    balances: [{ address: W0, eth: '0.1', trac: '100', symbol: 'TRAC' }],
    chainId: '84532',
    rpcUrl: null,
  });
  mocks.fetchPca.mockImplementation(async (_id: string, key?: string) =>
    key ? { ...snap, probedKey: { ...probe } } : snap,
  );
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.clearAllMocks();
  latestOverview = null;
  usePcaStore.setState({ trackedIds: [ACCOUNT], createPending: null });
  // S5 owner-publish escrow caveat off (not under test here).
  mocks.fetchContextGraphs.mockResolvedValue({ contextGraphs: [] });
  mocks.fetchCurrentAgent.mockResolvedValue({ agentDid: 'did:dkg:agent:0x' + '9'.repeat(40) });
  // GAP-3 (#1344): the wallet is registered ON the fixture account, so the S5 augment
  // never fires (the tracked fast-path resolves it) and S6 discovery is inert here —
  // stub it so neither path hits a real fetch. Parity is about classifyCoverage, not GAP-3.
  mocks.pcaAgentAccount.mockResolvedValue({ agent: W0, accountId: null });
});
afterEach(() => { document.body.innerHTML = ''; });

const FUTURE = Math.floor(Date.now() / 1000) + 60 * 86_400;
const PAST = Math.floor(Date.now() / 1000) - 86_400;

interface Scenario {
  name: string;
  snapOver: Record<string, unknown>;
  probe: PcaProbedKey;
  /** The shared-resolver oracle result the 3 surfaces must agree with. */
  expected: ReturnType<typeof classifyCoverage>;
  overview: { registered: boolean | null; approvedCount: number; inconclusive: boolean; covered: boolean; bestBps: 'discount' | null };
  s5Verdict: 'eligible' | 'fallthrough' | 'unknown';
  s5Wait: string;
  s6: { wait: string; ready: boolean; notText?: string[] };
}

const SCENARIOS: Scenario[] = [
  {
    name: 'registered + spendable → covers',
    snapOver: { expiresAtTimestamp: FUTURE },
    probe: { key: W0, registered: true },
    expected: { outcome: 'covers', registered: true },
    overview: { registered: true, approvedCount: 1, inconclusive: false, covered: true, bestBps: 'discount' },
    s5Verdict: 'eligible',
    s5Wait: 'Funded by PCA #' + ACCOUNT,
    s6: { wait: 'Ready', ready: true },
  },
  {
    name: 'adapterSupported:false → inconclusive (never a confirmed not-approved/DANGER)',
    snapOver: { expiresAtTimestamp: FUTURE },
    probe: { key: W0, registered: false, adapterSupported: false },
    expected: { outcome: 'inconclusive', registered: null },
    overview: { registered: null, approvedCount: 0, inconclusive: true, covered: false, bestBps: null },
    s5Verdict: 'unknown',
    s5Wait: 'PCA status unknown',
    // All-inconclusive → S6 reports a wholesale "couldn't determine" (never a false
    // "not approved"/"0 of N", never Ready) — still the inconclusive outcome.
    s6: { wait: 'the chain lookup failed', ready: false, notText: ['0 of 1'] },
  },
  {
    name: 'zero-budget approved → uncovered (hasBudget:false)',
    snapOver: { expiresAtTimestamp: FUTURE, topUpBuffer: '0', topUpBufferTrac: '0', baseEpochAllowance: '0' },
    probe: { key: W0, registered: true },
    expected: { outcome: 'uncovered', registered: true, dead: false, hasBudget: false },
    overview: { registered: true, approvedCount: 1, inconclusive: false, covered: false, bestBps: null },
    s5Verdict: 'fallthrough', // wallet has TRAC → amber, not danger
    s5Wait: 'No PCA discount',
    s6: { wait: 'Approved on PCA #' + ACCOUNT, ready: false },
  },
  {
    name: 'expired approved → uncovered (dead:true)',
    snapOver: { expiresAtTimestamp: PAST },
    probe: { key: W0, registered: true },
    expected: { outcome: 'uncovered', registered: true, dead: true, hasBudget: true },
    overview: { registered: true, approvedCount: 1, inconclusive: false, covered: false, bestBps: null },
    s5Verdict: 'fallthrough',
    s5Wait: 'No PCA discount',
    s6: { wait: 'publishes won’t get the discount', ready: false },
  },
  {
    name: 'swept approved → uncovered (dead:true)',
    snapOver: { fullySwept: true, expiresAtTimestamp: FUTURE },
    probe: { key: W0, registered: true },
    expected: { outcome: 'uncovered', registered: true, dead: true, hasBudget: true },
    overview: { registered: true, approvedCount: 1, inconclusive: false, covered: false, bestBps: null },
    s5Verdict: 'fallthrough',
    s5Wait: 'No PCA discount',
    s6: { wait: 'publishes won’t get the discount', ready: false },
  },
];

describe('#1344 coverage parity (table-driven) — S5 / S6 / overview agree via classifyCoverage', () => {
  for (const s of SCENARIOS) {
    it(`all surfaces agree: ${s.name}`, async () => {
      const snap = makePcaSnapshot({ accountId: ACCOUNT, ...s.snapOver });
      wire(snap, s.probe);

      // 0. the shared-resolver oracle — the single source the 3 surfaces consume.
      expect(classifyCoverage({ ...snap, probedKey: s.probe })).toEqual(s.expected);

      // 1. usePcaOverview
      const ov = await renderOverview();
      const a = latestOverview!.accounts.find((x) => x.accountId === ACCOUNT)!;
      expect(a.walletProbes[0]?.registered).toBe(s.overview.registered);
      expect(a.approvedCount).toBe(s.overview.approvedCount);
      expect(a.probesInconclusive).toBe(s.overview.inconclusive);
      expect(latestOverview!.covered).toBe(s.overview.covered);
      expect(latestOverview!.bestCoveringDiscountBps).toBe(s.overview.bestBps === 'discount' ? snap.discountBps : null);
      await ov.unmount();

      // 2. S5 chip (PublishEligibilityChip)
      const s5 = await render(React.createElement(PublishEligibilityChip, { contextGraphId: 'cg' }));
      await waitForText(s5.container, s.s5Wait);
      expect(s5.container.querySelector(`[data-verdict="${s.s5Verdict}"]`)).toBeTruthy();
      if (s.s5Verdict !== 'eligible') expect(s5.container.querySelector('[data-verdict="eligible"]')).toBeNull();
      await s5.unmount();

      // 3. S6 panel (GetSponsoredPanel) — run the approval check
      const s6 = await render(React.createElement(GetSponsoredPanel, { onClose: vi.fn() }));
      await waitForText(s6.container, 'Track your approval');
      setInputValue(s6.container.querySelector('input[aria-label="Sponsor account id"]') as HTMLInputElement, ACCOUNT);
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
      await act(async () => {
        (Array.from(s6.container.querySelectorAll('button')).find((b) => b.textContent === 'Check approval')!)
          .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await waitForText(s6.container, s.s6.wait);
      if (s.s6.ready) expect(s6.container.textContent).toContain('Ready');
      else expect(s6.container.textContent).not.toContain('Ready');
      for (const nt of s.s6.notText ?? []) expect(s6.container.textContent).not.toContain(nt);
      await s6.unmount();
    });
  }
});
