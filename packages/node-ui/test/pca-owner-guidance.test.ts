import { describe, expect, it } from 'vitest';
import { ownerGuidance, type OwnerGuidanceInput } from '../src/ui/pca/ownerGuidance.js';

const OWNER = '0x2409d90cC7A486730F176fff4cA7C20F1Ed6c1a5';
const base = (
  over: Partial<Omit<OwnerGuidanceInput, 'access'>> & { access?: Partial<OwnerGuidanceInput['access']> } = {},
): OwnerGuidanceInput => ({
  accountId: '1',
  owner: OWNER,
  connected: false,
  ownerInPool: false,
  ...over,
  access: { mode: 'external', wrongNetwork: false, writesEnabled: false, ...over.access },
});

describe('ownerGuidance', () => {
  it('someone else’s PCA, no wallet: one line, no repeating notice, reason on disabled actions', () => {
    const g = ownerGuidance(base());
    expect(g.walletLine).toBe('To top up, approve wallets or renew this PCA, connect the PCA owner wallet.');
    expect(g.notice).toBeNull();
    expect(g.disabledReason).toBe('Only the PCA owner wallet (0x2409…c1a5) can change PCA #1.');
  });

  it('a different wallet connected: the notice leads with what happened', () => {
    const g = ownerGuidance(base({ connected: true }));
    expect(g.notice).toEqual({
      kind: 'warning',
      retry: false,
      text: 'You’re connected with a different wallet. Only the PCA owner wallet (0x2409…c1a5) can change PCA #1. You can still check whether a wallet is approved.',
    });
  });

  it('owner is a secondary node wallet: keeps the operational-wallet explanation with no wallet connected', () => {
    const g = ownerGuidance(base({ ownerInPool: true }));
    expect(g.notice?.kind).toBe('warning');
    expect(g.notice?.text).toContain('one of this node’s operational wallets');
  });

  it('wallets loading: a neutral tip, never a warning', () => {
    const g = ownerGuidance(base({ access: { mode: 'unknown', ownerUnknownCause: 'wallets-loading' } }));
    expect(g.notice).toEqual({ kind: 'loading', text: 'Confirming ownership of PCA #1…' });
  });

  it('wallets unreadable: "can’t confirm" with Retry, and no probe note', () => {
    const g = ownerGuidance(base({ access: { mode: 'unknown', ownerUnknownCause: 'wallets-unreadable' } }));
    expect(g.notice).toEqual({ kind: 'warning', retry: true, text: 'Couldn’t load this node’s wallets, so we can’t confirm who owns PCA #1.' });
  });

  it('owner wallet on the wrong network: both the line and the notice say to switch', () => {
    const g = ownerGuidance(base({ connected: true, access: { mode: 'wallet', wrongNetwork: true } }));
    expect(g.walletLine).toContain('but it’s on another network');
    expect(g.notice?.text).toContain('The PCA owner wallet is on another network.');
  });

  it('writes enabled: no notice and no disabled reason', () => {
    const g = ownerGuidance(base({ connected: true, access: { mode: 'wallet', writesEnabled: true } }));
    expect(g.notice).toBeNull();
    expect(g.disabledReason).toBeUndefined();
    expect(g.walletLine).toBe('Your connected wallet is the PCA owner wallet. It signs top-ups, wallet approvals, removals and renewals.');
  });
});
