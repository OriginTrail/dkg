// @vitest-environment happy-dom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Treasury } from '../src/ui/marketplace/purchase/Treasury.js';
import { FIXTURE_IDS, fixtureFetch, fixtureWorld } from '../src/ui/marketplace/api/fixtures.js';
import type { Account, Funding } from '../src/ui/marketplace/api/types.js';
import { MISSING_COPY, byTestId, click, render, type, unmountAll } from './helpers/marketplace-render.js';

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const NOW_S = NOW / 1000;
const DAY = 86_400;
/** The buyer wallet the node names when the form reads its funding afresh: not the one the card was drawn with. */
const NODE_BUYER = `0x${'b1'.repeat(20)}`;

interface Sent { method: string; url: string; body: unknown }

/** The fixture node at NOW, keeping every request the card sends. */
function recordNode(): Sent[] {
  const sent: Sent[] = [];
  const node = fixtureFetch('active', NOW);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    sent.push({ method, url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const res = await node(input, init);
    if (method !== 'GET' || String(input) !== '/api/marketplace/funding') return res;
    const funding = await res.json() as Funding;
    return new Response(JSON.stringify({ ...funding, buyerWallet: { ...funding.buyerWallet, address: NODE_BUYER } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  return sent;
}

/** The fixture's funding with `accounts` in place of its own. */
function fundingWith(accounts: Account[]): Funding {
  return { ...fixtureWorld(NOW).funding, accounts };
}

const world = fixtureWorld(NOW);
const owned = world.accounts.find((a) => a.accountId === '7')!;
const other = world.accounts.find((a) => a.accountId === '9')!;
const grant = owned.grant!;
const ownedWithoutGrant: Account = { ...owned, accountId: '8', grant: undefined, buyerWallets: [] };
const ownedSpendingOff: Account = { ...owned, accountId: '5', serviceCapable: false, refusal: 'ServiceSpendingDisabled' };
const otherWithGrant: Account = { ...other, accountId: '11', grant: { ...grant, buyer: FIXTURE_IDS.buyerWallet }, buyerWallets: [grant] };

const row = (c: HTMLElement, id: string) => byTestId(c, `mkt-account-${id}`) as HTMLElement;
const control = (c: HTMLElement, id: string, copyKey: string) => row(c, id).querySelector<HTMLButtonElement>(`button[data-copy="${copyKey}"]`);
const writes = (sent: Sent[]) => sent.filter((s) => s.method !== 'GET');

async function fill(c: HTMLElement, limit: string, days: string): Promise<HTMLButtonElement> {
  await type(byTestId(c, 'mkt-limit'), limit);
  await type(byTestId(c, 'mkt-limit-days'), days);
  return byTestId(c, 'mkt-limits-send') as HTMLButtonElement;
}

describe('marketplace Treasury', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(async () => {
    await unmountAll();
    vi.useRealTimers();
  });

  it('offers an owned account the owner\'s actions, and another owner\'s account only the consent', async () => {
    recordNode();
    const c = await render(React.createElement(Treasury, { funding: fundingWith([owned, ownedWithoutGrant, other, otherWithGrant]), onChanged: () => undefined }));
    const buttons = (id: string) => [...row(c, id).querySelectorAll('button')].map((b) => b.getAttribute('data-copy'));
    expect(buttons('7')).toEqual(['treasury.limits', 'treasury.remove', 'treasury.spending.off']);
    expect(buttons('8')).toEqual(['treasury.add', 'treasury.spending.off']);
    expect(buttons('9')).toEqual(['treasury.consent']);
    expect(buttons('11')).toEqual([]);
    expect(row(c, '7').textContent).toContain('owned by this node');
    expect(row(c, '9').textContent).toContain('owned elsewhere');
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('says the accounts are still being looked up while the node reads the list, not that there are none', async () => {
    recordNode();
    const pending = await render(React.createElement(Treasury, { funding: { ...fundingWith([]), accountsPending: true }, onChanged: () => undefined }));
    expect(pending.querySelector('[data-copy="treasury.accounts.pending"]')).not.toBeNull();
    expect(pending.querySelector('[data-copy="treasury.accounts.none"]')).toBeNull();
    expect(pending.textContent).not.toContain(MISSING_COPY);

    // The list read last stays on show while the next one is read.
    const stale = await render(React.createElement(Treasury, { funding: { ...fundingWith([owned]), accountsPending: true }, onChanged: () => undefined }));
    expect(stale.querySelector('[data-copy="treasury.accounts.pending"]')).not.toBeNull();
    expect(row(stale, '7')).not.toBeNull();

    const none = await render(React.createElement(Treasury, { funding: { ...fundingWith([]), accountsPending: false }, onChanged: () => undefined }));
    expect(none.querySelector('[data-copy="treasury.accounts.none"]')).not.toBeNull();
    expect(none.querySelector('[data-copy="treasury.accounts.pending"]')).toBeNull();
  });

  it('says why the last look-up of the accounts failed while the node looks them up again', async () => {
    recordNode();
    const c = await render(React.createElement(Treasury, {
      funding: { ...fundingWith([]), accountsPending: true, accountsError: 'upstream timeout' },
      onChanged: () => undefined,
    }));
    const failed = c.querySelector('[data-copy="treasury.accounts.failed"]');
    expect(failed?.textContent).toContain('upstream timeout');
    expect(c.querySelector('[data-copy="treasury.accounts.pending"]')).toBeNull();
    expect(c.querySelector('[data-copy="treasury.accounts.none"]')).toBeNull();
    expect(c.textContent).not.toContain(MISSING_COPY);
  });

  it('changes the limits on the account picked, for the buyer wallet the node names, with the exact limit and expiry', async () => {
    const sent = recordNode();
    const onChanged = vi.fn();
    const second: Account = { ...owned, accountId: '12' };
    const c = await render(React.createElement(Treasury, { funding: fundingWith([owned, second]), onChanged }));
    await click(control(c, '12', 'treasury.limits'));
    const send = await fill(c, '0.25', '7');
    expect(send.disabled).toBe(false);
    await click(send);
    expect(sent.map((s) => `${s.method} ${s.url}`)).toEqual([
      'GET /api/marketplace/funding',
      `POST /api/marketplace/accounts/12/buyers/${NODE_BUYER}/limits`,
    ]);
    expect(sent[1].body).toEqual({ maxCostPerEpoch: '250000000000000000', expiresAt: NOW_S + 7 * DAY });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(row(c, '12').textContent).toContain('Sent · tx 0xd2d2…d2d2');
    expect(byTestId(c, 'mkt-limits-form')).toBeNull();
  });

  it('adds this node\'s buyer wallet to an owned account with the limits typed', async () => {
    const sent = recordNode();
    const onChanged = vi.fn();
    const c = await render(React.createElement(Treasury, { funding: fundingWith([owned, ownedWithoutGrant]), onChanged }));
    await click(byTestId(c, 'mkt-add-buyer-8'));
    await click(await fill(c, '12.5', '30'));
    expect(writes(sent)).toEqual([
      { method: 'POST', url: '/api/marketplace/accounts/8/buyers', body: { maxCostPerEpoch: '12500000000000000000', expiresAt: NOW_S + 30 * DAY } },
    ]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('signs the buyer\'s consent for another owner\'s account, and shows it without a transaction', async () => {
    const sent = recordNode();
    const onChanged = vi.fn();
    const c = await render(React.createElement(Treasury, { funding: fundingWith([other]), onChanged }));
    await click(byTestId(c, 'mkt-consent-9'));
    expect(byTestId(c, 'mkt-limits-form')?.textContent).not.toContain('Sends one transaction');
    await click(await fill(c, '0.25', '7'));
    expect(writes(sent)).toEqual([
      { method: 'POST', url: '/api/marketplace/accounts/9/buyer-consent', body: { maxCostPerEpoch: '250000000000000000', expiresAt: NOW_S + 7 * DAY } },
    ]);
    const consent = byTestId(c, 'mkt-consent')?.textContent ?? '';
    expect(consent).toContain('Give this to account 9\'s owner');
    expect(consent).toContain('"maxCostPerEpoch": "250000000000000000"');
    expect(consent).toContain(`"expiresAt": ${NOW_S + 7 * DAY}`);
    expect(onChanged).not.toHaveBeenCalled();
  });

  for (const [limit, days] of [['0', '7'], ['-1', '7'], ['abc', '7'], ['0.0000000000000000001', '7'], ['', '7'], ['1', '0'], ['1', '1.5'], ['1', '-2'], ['1', 'x'], ['1', '']]) {
    it(`sends nothing for ${limit || 'no'} TRAC over ${days || 'no'} days`, async () => {
      const sent = recordNode();
      const c = await render(React.createElement(Treasury, { funding: fundingWith([owned, ownedWithoutGrant, other]), onChanged: () => undefined }));
      for (const open of [() => control(c, '7', 'treasury.limits'), () => byTestId(c, 'mkt-add-buyer-8'), () => byTestId(c, 'mkt-consent-9')]) {
        await click(open());
        const send = await fill(c, limit, days);
        expect(send.disabled).toBe(true);
        await click(send);
        await click(byTestId(c, 'mkt-limits-form')?.querySelector('button[data-copy="gate.cancel"]'));
      }
      expect(sent).toEqual([]);
    });
  }

  it('removes the grant\'s buyer wallet from the account', async () => {
    const sent = recordNode();
    const onChanged = vi.fn();
    const c = await render(React.createElement(Treasury, { funding: fundingWith([owned]), onChanged }));
    await click(byTestId(c, 'mkt-remove-buyer-7'));
    expect(writes(sent)).toEqual([{ method: 'DELETE', url: `/api/marketplace/accounts/7/buyers/${grant.buyer}`, body: undefined }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(row(c, '7').textContent).toContain('Sent · tx 0xd2d2…d2d2');
  });

  it('turns service spending on where it is off, and off where it is on', async () => {
    const sent = recordNode();
    const c = await render(React.createElement(Treasury, { funding: fundingWith([owned, ownedSpendingOff]), onChanged: () => undefined }));
    expect(byTestId(c, 'mkt-spending-5')?.textContent).toBe('Turn service spending on');
    expect(byTestId(c, 'mkt-spending-7')?.textContent).toBe('Turn service spending off');
    await click(byTestId(c, 'mkt-spending-5'));
    await click(byTestId(c, 'mkt-spending-7'));
    expect(writes(sent)).toEqual([
      { method: 'POST', url: '/api/marketplace/accounts/5/service-spending', body: { enabled: true } },
      { method: 'POST', url: '/api/marketplace/accounts/7/service-spending', body: { enabled: false } },
    ]);
  });
});
