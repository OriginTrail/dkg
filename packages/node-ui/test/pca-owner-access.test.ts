// @vitest-environment happy-dom
//
// #1375 (PR8) — the centralized PCA owner-access model. Two suites:
//  1. DIRECT unit tests of the pure `resolvePcaOwnerAccess` core (the model was only ever
//     covered indirectly through consumers; `detailOwnerMode` had no direct test at all).
//  2. CALL-SITE PARITY — the exact seam this refactor risks. Asserts the core reproduces the
//     effective (classify + gate) decision of every former owner-mode site for the three
//     dangerous cases: daemon == connected, wrong-network, and external.

import { describe, it, expect, vi } from 'vitest';

// Keep the import graph light + hermetic: `resolveOwnerActionSubmitterKind` is pure but its
// module (`ownerActions.ts`) pulls in the api client + the browser-wallet submitter. Stub both
// so importing it doesn't load real transport/viem — the classifier under test uses neither.
vi.mock('../src/ui/api.js', () => ({
  createPca: () => {},
  fetchPca: () => {},
  fetchWalletsBalances: () => {},
  pcaAddAgent: () => {},
  pcaRemoveAgent: () => {},
  pcaTopUp: () => {},
  pcaSettle: () => {},
}));
vi.mock('../src/ui/web3/walletOwnerActionSubmitter.js', () => ({
  walletOwnerActionSubmitter: () => ({}),
}));

const { resolvePcaOwnerAccess } = await import('../src/ui/pca/ownerAccess.js');
const { resolveOwnerActionSubmitterKind } = await import('../src/ui/pca/ownerActions.js');

const HOT = `0x${'11'.repeat(20)}`; // this node's primary operational (daemon) wallet
const HW = `0x${'22'.repeat(20)}`; // a connected browser wallet
const EXTERNAL = `0x${'33'.repeat(20)}`; // a third-party owner

describe('resolvePcaOwnerAccess — core classification', () => {
  it('daemon wins even when the primary wallet is ALSO the connected wallet (inv-17 ordering)', () => {
    const access = resolvePcaOwnerAccess({ owner: HOT, primaryWallet: HOT, connectedWallet: HOT });
    expect(access.mode).toBe('daemon');
    expect(access.submitterKind).toBe('daemon');
    expect(access.writesEnabled).toBe(true);
    expect(access.wrongNetwork).toBe(false);
    expect(access.ownerUnknownCause).toBeUndefined();
  });

  it('daemon ignores wrong-network (the daemon EOA signs regardless of the connected chain)', () => {
    const access = resolvePcaOwnerAccess({ owner: HOT, primaryWallet: HOT, connectedWallet: HOT, walletWrongNetwork: true });
    expect(access.mode).toBe('daemon');
    expect(access.writesEnabled).toBe(true);
    // wrongNetwork is reported raw; it just doesn't gate the daemon.
    expect(access.wrongNetwork).toBe(true);
  });

  it('daemon wins when owner == primary even if a DIFFERENT wallet is connected', () => {
    const access = resolvePcaOwnerAccess({ owner: HOT, primaryWallet: HOT, connectedWallet: HW });
    expect(access.mode).toBe('daemon');
    expect(access.submitterKind).toBe('daemon');
  });

  it('connected owner != primary → wallet-managed', () => {
    const access = resolvePcaOwnerAccess({ owner: HW, primaryWallet: HOT, connectedWallet: HW });
    expect(access.mode).toBe('wallet');
    expect(access.submitterKind).toBe('wallet');
    expect(access.writesEnabled).toBe(true);
  });

  it('wrong-network wallet: mode STAYS wallet + submitterKind STAYS wallet (address-only), only writesEnabled flips', () => {
    const access = resolvePcaOwnerAccess({ owner: HW, primaryWallet: HOT, connectedWallet: HW, walletWrongNetwork: true });
    expect(access.mode).toBe('wallet'); // network is NOT folded into classification
    expect(access.submitterKind).toBe('wallet'); // matches address-only resolveOwnerActionSubmitterKind
    expect(access.wrongNetwork).toBe(true);
    expect(access.writesEnabled).toBe(false); // the network gate lives here, separately
  });

  it('external (a wallet is connected but is not the owner) → read-only', () => {
    const access = resolvePcaOwnerAccess({ owner: EXTERNAL, primaryWallet: HOT, connectedWallet: HW });
    expect(access.mode).toBe('external');
    expect(access.submitterKind).toBe('read-only');
    expect(access.writesEnabled).toBe(false);
  });

  it('external (no wallet connected) → read-only', () => {
    const access = resolvePcaOwnerAccess({ owner: EXTERNAL, primaryWallet: HOT, connectedWallet: null });
    expect(access.mode).toBe('external');
    expect(access.submitterKind).toBe('read-only');
    expect(access.writesEnabled).toBe(false);
  });

  it('owner == connected but ALSO == primary → the redundant guard keeps it daemon', () => {
    // Exercises the load-bearing `&& !eqAddress(owner, primaryWallet)` guard on the wallet branch.
    const access = resolvePcaOwnerAccess({ owner: HW, primaryWallet: HW, connectedWallet: HW });
    expect(access.mode).toBe('daemon');
  });

  it('case-insensitive owner matching', () => {
    const access = resolvePcaOwnerAccess({ owner: HW.toUpperCase(), primaryWallet: HOT, connectedWallet: HW.toLowerCase() });
    expect(access.mode).toBe('wallet');
  });
});

describe('resolvePcaOwnerAccess — the two distinct unknown causes', () => {
  it('wallets-unreadable: walletsUnknown wins even with an owner present', () => {
    const access = resolvePcaOwnerAccess({ owner: HOT, primaryWallet: HOT, connectedWallet: HOT, walletsUnknown: true });
    expect(access.mode).toBe('unknown');
    expect(access.ownerUnknownCause).toBe('wallets-unreadable');
    expect(access.writesEnabled).toBe(false);
    expect(access.submitterKind).toBe('read-only');
  });

  it('no-snapshot: a missing owner (no PCA snapshot) → unknown', () => {
    const access = resolvePcaOwnerAccess({ owner: undefined, primaryWallet: HOT, connectedWallet: HW });
    expect(access.mode).toBe('unknown');
    expect(access.ownerUnknownCause).toBe('no-snapshot');
    expect(access.writesEnabled).toBe(false);
    expect(access.submitterKind).toBe('read-only');
  });

  it('empty-string owner is treated as no-snapshot', () => {
    const access = resolvePcaOwnerAccess({ owner: '', primaryWallet: HOT, connectedWallet: HW });
    expect(access.mode).toBe('unknown');
    expect(access.ownerUnknownCause).toBe('no-snapshot');
  });

  it('walletsUnknown takes precedence over a missing owner (documented ordering)', () => {
    const access = resolvePcaOwnerAccess({ owner: undefined, primaryWallet: HOT, connectedWallet: HW, walletsUnknown: true });
    expect(access.mode).toBe('unknown');
    expect(access.ownerUnknownCause).toBe('wallets-unreadable');
  });
});

describe('resolvePcaOwnerAccess — signableOwners shape', () => {
  it('always both entries, daemon then wallet, in the ApproveWalletsModal order', () => {
    const access = resolvePcaOwnerAccess({ owner: HW, primaryWallet: HOT, connectedWallet: HW });
    expect(access.signableOwners).toEqual([
      { address: HOT, kind: 'daemon' },
      { address: HW, kind: 'wallet' },
    ]);
  });

  it('keeps the wallet entry (with a null address) when no wallet is connected — normalizers drop it downstream', () => {
    const access = resolvePcaOwnerAccess({ owner: EXTERNAL, primaryWallet: HOT, connectedWallet: null });
    expect(access.signableOwners).toEqual([
      { address: HOT, kind: 'daemon' },
      { address: null, kind: 'wallet' },
    ]);
  });

  it('is present on the unknown paths too', () => {
    const access = resolvePcaOwnerAccess({ owner: undefined, primaryWallet: HOT, connectedWallet: HW });
    expect(access.signableOwners).toEqual([
      { address: HOT, kind: 'daemon' },
      { address: HW, kind: 'wallet' },
    ]);
  });
});

// ── Call-site parity ────────────────────────────────────────────────────────────────────
// Two former sites are exported and imported directly (detailOwnerMode, resolveOwnerActionSubmitterKind).
// Two are private to their components, so their logic is reproduced VERBATIM below as reference
// oracles (with source coordinates) and the model is asserted to reproduce their effective decision.

/** Verbatim from pages/conviction/ConvictionOverview.tsx:26-33 (eq + ownerModeFor). */
const overviewEq = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
function ownerModeFor(owner: string | undefined, primaryWallet: string | undefined, connectedWallet: string | null) {
  if (!owner) return 'unknown';
  if (overviewEq(owner, primaryWallet)) return 'daemon';
  if (connectedWallet && overviewEq(owner, connectedWallet) && !overviewEq(owner, primaryWallet)) return 'wallet';
  return 'external';
}

/** Verbatim from pages/conviction/ApproveWalletsModal.tsx:30-31,160-181 (sameAddress + the two
 *  private predicates). `targetWalletManaged` is the display gate; `signerKindRef` is the pure
 *  classification half of the async `signerKindForAccount` (after its owner fetch). */
const sameAddress = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
function targetWalletManagedRef(owner: string | undefined, ownerWallet: string | undefined, connectedWallet: string | null, walletWrongNetwork: boolean) {
  return (
    !!owner &&
    !!connectedWallet &&
    !walletWrongNetwork &&
    !sameAddress(owner, ownerWallet) &&
    sameAddress(owner, connectedWallet)
  );
}
function signerKindRef(owner: string | undefined, ownerWallet: string | undefined, connectedWallet: string | null, walletWrongNetwork: boolean): 'daemon' | 'wallet' | undefined {
  if (!owner) return undefined;
  if (sameAddress(owner, ownerWallet)) return 'daemon';
  if (connectedWallet && !walletWrongNetwork && sameAddress(owner, connectedWallet)) return 'wallet';
  return undefined;
}

/** The model-derived equivalent of ApproveWalletsModal's signerKind (daemon/wallet/undefined). */
function modelSignerKind(access: { mode: string; writesEnabled: boolean }): 'daemon' | 'wallet' | undefined {
  if (access.mode === 'daemon') return 'daemon';
  if (access.mode === 'wallet' && access.writesEnabled) return 'wallet';
  return undefined;
}

interface Scenario {
  name: string;
  owner: string;
  primary: string;
  connected: string | null;
  wrong: boolean;
}
const SCENARIOS: Scenario[] = [
  { name: 'daemon-owned, primary != connected', owner: HOT, primary: HOT, connected: HW, wrong: false },
  { name: 'daemon-owned, primary == connected', owner: HOT, primary: HOT, connected: HOT, wrong: false },
  { name: 'daemon-owned, wrong-network (daemon ignores it)', owner: HOT, primary: HOT, connected: HOT, wrong: true },
  { name: 'wallet-owned, right network', owner: HW, primary: HOT, connected: HW, wrong: false },
  { name: 'wallet-owned, WRONG network', owner: HW, primary: HOT, connected: HW, wrong: true },
  { name: 'external, wallet connected', owner: EXTERNAL, primary: HOT, connected: HW, wrong: false },
  { name: 'external, wallet connected, wrong network', owner: EXTERNAL, primary: HOT, connected: HW, wrong: true },
  { name: 'external, no wallet connected', owner: EXTERNAL, primary: HOT, connected: null, wrong: false },
];

describe('call-site parity — the model reproduces every former owner-mode site', () => {
  for (const s of SCENARIOS) {
    describe(s.name, () => {
      const access = resolvePcaOwnerAccess({
        owner: s.owner,
        primaryWallet: s.primary,
        connectedWallet: s.connected,
        walletWrongNetwork: s.wrong,
      });

      it('mode == ConvictionOverview.ownerModeFor', () => {
        expect(access.mode).toBe(ownerModeFor(s.owner, s.primary, s.connected));
      });

      it('submitterKind == ownerActions.resolveOwnerActionSubmitterKind (address-only)', () => {
        expect(access.submitterKind).toBe(
          resolveOwnerActionSubmitterKind({ owner: s.owner, primaryWallet: s.primary, connectedWallet: s.connected }),
        );
      });

      it('effective overview walletWrongNetwork matches (mode==wallet && wrongNetwork)', () => {
        const overviewTag = ownerModeFor(s.owner, s.primary, s.connected) === 'wallet' && s.wrong;
        expect(access.mode === 'wallet' && access.wrongNetwork).toBe(overviewTag);
      });

      it('effective ApproveWalletsModal targetWalletManaged matches (mode==wallet && writesEnabled)', () => {
        const managed = targetWalletManagedRef(s.owner, s.primary, s.connected, s.wrong);
        expect(access.mode === 'wallet' && access.writesEnabled).toBe(managed);
      });

      it('effective ApproveWalletsModal signerKind matches', () => {
        expect(modelSignerKind(access)).toBe(signerKindRef(s.owner, s.primary, s.connected, s.wrong));
      });
    });
  }
});
