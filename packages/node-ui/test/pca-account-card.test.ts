// @vitest-environment happy-dom
//
// B2 — PcaAccountCard render states (owned / approved / per-card error),
// fixture-driven (no api mocks). Pins the §11 owner≠coverage warning, the §8A
// owner-wallet action gate, the round-robin "N of M approved" honesty, and the
// 404→Remove / transient→Retry per-card recovery.

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PcaAccountCard } from '../src/ui/pages/conviction/PcaAccountCard.js';
import type { ResolvedPcaAccount } from '../src/ui/hooks/usePcaOverview.js';
import type { PcaSnapshot } from '../src/ui/api.js';

function snap(over: Partial<PcaSnapshot> = {}): PcaSnapshot {
  return {
    accountId: '7',
    owner: '0x9A3f000000000000000000000000000000000E41D',
    committedTRAC: '100000000000000000000000',
    committedTRACTrac: '100000.0',
    baseEpochAllowance: '850000000000000000000',
    topUpBuffer: '12500000000000000000000',
    topUpBufferTrac: '12500.0',
    createdAtEpoch: 1200,
    expiresAtEpoch: 1560,
    createdAtTimestamp: 1000,
    expiresAtTimestamp: 9_999_999_999,
    discountBps: 3000,
    agentCount: 4,
    lastSettledWindow: 0,
    fullySwept: false,
    ...over,
  };
}

function acct(over: Partial<ResolvedPcaAccount> = {}): ResolvedPcaAccount {
  return {
    accountId: '7',
    snapshot: snap(),
    error: null,
    notFound: false,
    classification: 'owned',
    ownerIsPrimaryWallet: true,
    health: 'healthy',
    walletProbes: [],
    approvedCount: 0,
    walletCount: 3,
    ...over,
  };
}

async function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('PcaAccountCard', () => {
  it('owned card with 0 approved wallets shows the #11 "discounts nothing yet" warning', async () => {
    const { container, unmount } = await render(
      React.createElement(PcaAccountCard, { account: acct({ approvedCount: 0 }) }),
    );
    expect(container.querySelector('[data-state="owned"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pca-account-card"]')).toBeTruthy(); // e2e anchor
    expect(container.textContent).toContain('discounts nothing yet');
    // formatTrac uses toFixed (no thousands separators).
    expect(container.textContent).toContain('100000.00 TRAC');
    await unmount();
  });

  it('owned card with approved wallets drops the #11 warning', async () => {
    const { container, unmount } = await render(
      React.createElement(PcaAccountCard, { account: acct({ approvedCount: 2 }) }),
    );
    expect(container.textContent).not.toContain('discounts nothing yet');
    await unmount();
  });

  it('disables "Approve wallets" when the owner is NOT the node primary wallet (§8A)', async () => {
    const onApproveWallets = vi.fn();
    const enabled = await render(
      React.createElement(PcaAccountCard, { account: acct({ ownerIsPrimaryWallet: true }), onApproveWallets }),
    );
    let approveBtn = Array.from(enabled.container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Approve wallets',
    )!;
    expect(approveBtn.disabled).toBe(false);
    await enabled.unmount();

    const disabled = await render(
      React.createElement(PcaAccountCard, { account: acct({ ownerIsPrimaryWallet: false }), onApproveWallets }),
    );
    approveBtn = Array.from(disabled.container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Approve wallets',
    )!;
    expect(approveBtn.disabled).toBe(true);
    expect(approveBtn.getAttribute('title')?.toLowerCase()).toContain('owner-only');
    await disabled.unmount();
  });

  it('approved card surfaces the round-robin "N of M approved" footgun + copy-unapproved', async () => {
    const account = acct({
      classification: 'approved',
      owner: '0xSOMEONEELSE0000000000000000000000000000',
      ownerIsPrimaryWallet: false,
      approvedCount: 2,
      walletCount: 3,
      walletProbes: [
        { wallet: '0x71D4000000000000000000000000000000009Ac2', registered: true },
        { wallet: '0x3F8a0000000000000000000000000000000C1b7', registered: true },
        { wallet: '0xE0c500000000000000000000000000000000042dD', registered: false },
      ],
    });
    const onUse = vi.fn();
    const { container, unmount } = await render(
      React.createElement(PcaAccountCard, { account, onUseForPublishing: onUse }),
    );
    expect(container.querySelector('[data-state="approved"]')).toBeTruthy();
    expect(container.textContent).toContain('2 of 3 wallets approved');
    expect(container.textContent).toContain('pay the direct cost');
    // The first unapproved wallet has a copy control.
    const copy = Array.from(container.querySelectorAll('.v10-pca-copy-btn')).find((b) =>
      b.getAttribute('aria-label')?.includes('0xE0c5'),
    );
    expect(copy).toBeTruthy();
    // Use-for-publishing wired.
    Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent === 'Use for publishing')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onUse).toHaveBeenCalledWith('7');
    await unmount();
  });

  it('404 card offers Remove-from-tracked', async () => {
    const onRemove = vi.fn();
    const { container, unmount } = await render(
      React.createElement(PcaAccountCard, {
        account: acct({ snapshot: null, notFound: true, classification: 'unknown' }),
        onRemove,
      }),
    );
    expect(container.querySelector('[data-state="not-found"]')).toBeTruthy();
    expect(container.textContent).toContain('no longer exists');
    container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onRemove).toHaveBeenCalledWith('7');
    await unmount();
  });

  it('transient-error card offers Retry', async () => {
    const onRetry = vi.fn();
    const { container, unmount } = await render(
      React.createElement(PcaAccountCard, {
        account: acct({ snapshot: null, notFound: false, error: new Error('network'), classification: 'unknown' }),
        onRetry,
      }),
    );
    expect(container.querySelector('[data-state="error"]')).toBeTruthy();
    expect(container.textContent).toContain('Couldn’t load');
    container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onRetry).toHaveBeenCalledWith('7');
    await unmount();
  });
});
