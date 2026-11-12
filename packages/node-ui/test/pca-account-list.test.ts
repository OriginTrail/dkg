// @vitest-environment happy-dom
//
// The one PCA list on the overview: what each row says and offers, and that it never
// states coverage it couldn't read (#9, H2).

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PcaAccountList, type PcaListAccount } from '../src/ui/pages/conviction/PcaAccountList.js';
import { makePcaSnapshot } from '../src/ui/mocks/pca.js';

const NOW = 1_800_000_000;
const DAY = 86_400;

function account(over: Partial<PcaListAccount> = {}): PcaListAccount {
  return {
    accountId: '12',
    snapshot: makePcaSnapshot({ accountId: '12', discountBps: 2000, expiresAtTimestamp: NOW + 90 * DAY }),
    error: null,
    notFound: false,
    classification: 'owned',
    ownerIsPrimaryWallet: true,
    health: 'healthy',
    walletProbes: [],
    approvedCount: 2,
    walletCount: 3,
    probesInconclusive: false,
    ownerMode: 'daemon',
    walletWrongNetwork: false,
    ...over,
  } as PcaListAccount;
}

const handlers = {
  onManage: vi.fn(),
  onApproveWallets: vi.fn(),
  onRemove: vi.fn(),
  onRetry: vi.fn(),
  onAddFound: vi.fn(),
  onCheckId: vi.fn(),
};

async function renderList(accounts: PcaListAccount[], over: Record<string, unknown> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(PcaAccountList, {
      accounts, found: [], loading: false, walletsInconclusive: false, readingWallet: null, nowSec: NOW, ...handlers, ...over,
    }));
  });
  return container;
}

const buttons = (c: HTMLElement) => Array.from(c.querySelectorAll('tbody td:last-child button')).map((b) => b.textContent);

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
});
afterEach(() => { document.body.innerHTML = ''; });

describe('PcaAccountList', () => {
  it('shows an owned PCA with its discount, owner, wallets and expiry', async () => {
    const c = await renderList([account()]);
    const row = c.querySelector('[data-account="12"]')!;
    expect(row.textContent).toContain('20%');
    expect(row.textContent).toContain('This node');
    expect(row.textContent).toContain('2 approved');
    expect(row.textContent).toContain('~90 days');
    expect(buttons(c)).toEqual(['Manage']);
  });

  it('offers Approve wallets on an owned PCA with none approved, and shows the ID as plain text', async () => {
    const c = await renderList([account({ approvedCount: 0 })]);
    expect(c.textContent).toContain('None approved');
    // Approve wallets is added; Manage stays, so the PCA page (top-up, removal) is still reachable.
    expect(buttons(c)).toEqual(['Approve wallets', 'Manage']);
    await act(async () => {
      (Array.from(c.querySelectorAll('button')).find((b) => b.textContent === 'Manage') as HTMLButtonElement)
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(handlers.onManage).toHaveBeenCalledWith('12');
    // View or Manage is the one way in; the ID is not a second button.
    expect(c.querySelector('[data-account="12"] td:first-child button')).toBeNull();
    expect(c.querySelector('[data-account="12"] td:first-child strong')?.textContent).toBe('#12');
  });

  it('shows the exact committed TRAC on hover', async () => {
    const c = await renderList([account()]);
    const cell = c.querySelector('[data-account="12"] td:nth-child(4)') as HTMLElement;
    expect(cell.title).toMatch(/^Exact: /);
  });

  it('disables Approve wallets on the wrong network', async () => {
    const c = await renderList([account({ approvedCount: 0, ownerMode: 'wallet', walletWrongNetwork: true })]);
    const approve = Array.from(c.querySelectorAll('button')).find((b) => b.textContent === 'Approve wallets') as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
  });

  it('keeps Remove from list on a read-only PCA', async () => {
    const c = await renderList([account({ ownerMode: 'external', approvedCount: 0 })]);
    expect(c.textContent).toContain('Someone else, read-only');
    expect(c.textContent).toContain('None of yours');
    expect(buttons(c)).toEqual(['View', 'Remove from list']);
  });

  it('H2 — a failed probe never reads as a confirmed count or asks for approval', async () => {
    const c = await renderList([account({ approvedCount: 0, probesInconclusive: true })]);
    expect(c.textContent).toContain('Couldn’t check all');
    expect(c.textContent).not.toContain('None approved');
    expect(buttons(c)).toEqual(['Manage']);
  });

  it('#9 — unreadable wallets never assert an owner or a count', async () => {
    const c = await renderList([account({ ownerMode: 'external', approvedCount: 0 })], { walletsInconclusive: true });
    expect(c.textContent).toContain('Couldn’t check');
    expect(c.textContent).not.toContain('Someone else');
    expect(c.textContent).not.toContain('None of yours');
  });

  it('warns about partial coverage on someone else’s PCA', async () => {
    const c = await renderList([account({ ownerMode: 'external' })]);
    expect(c.textContent).toContain('2 of 3 approved');
    expect(c.textContent).toContain('Wallets that aren’t approved pay the full fee');
  });

  it('a PCA that fails to load offers Retry; one that is gone offers removal', async () => {
    const c = await renderList([
      account({ accountId: '31', snapshot: null, health: null }),
      account({ accountId: '32', snapshot: null, health: null, notFound: true }),
    ]);
    expect(c.textContent).toContain('Couldn’t load PCA #31');
    expect(c.textContent).toContain('PCA #32 can’t be found on-chain.');
    expect(buttons(c)).toEqual(['Retry', 'Remove from list']);
  });

  it('#9 — a found PCA the node only owns shows no discount', async () => {
    const c = await renderList([], { found: [{ accountId: '50', relation: 'owned', basics: { discountBps: 1000 } }] });
    const row = c.querySelector('[data-testid="pca-discovered-row"]')!;
    expect(row.textContent).toContain('Found on-chain');
    expect(row.textContent).not.toContain('10%');
  });

  it('with no PCAs, asks whether you already have one and offers the ID check beside it', async () => {
    const c = await renderList([]);
    expect(c.textContent).toContain('Already have a PCA?');
    expect(c.querySelector('[data-testid="pca-check-input"]')).toBeTruthy();
    expect(c.querySelector('[data-testid="pca-check-submit"]')?.textContent).toBe('Check');
    expect(c.querySelector('table')).toBeNull();
  });

  it('Check sends the typed PCA ID on, and says what is wrong with anything else', async () => {
    const c = await renderList([]);
    const input = c.querySelector('[data-testid="pca-check-input"]') as HTMLInputElement;
    const type = async (v: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const press = async () => act(async () => {
      (c.querySelector('[data-testid="pca-check-submit"]') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await type('abc');
    await press();
    expect(c.querySelector('[role="alert"]')?.textContent).toBe('Enter the PCA ID as a number.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(handlers.onCheckId).not.toHaveBeenCalled();
    await type('#7');
    await press();
    expect(handlers.onCheckId).toHaveBeenCalledWith('7');
    expect(c.querySelector('[role="alert"]')).toBeNull();
  });
});
