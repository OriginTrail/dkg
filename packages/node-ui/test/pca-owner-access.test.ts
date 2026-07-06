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

const { resolvePcaOwnerAccess, mayTargetWritePromptWallet, resolvePrimaryWalletState } = await import('../src/ui/pca/ownerAccess.js');
const { resolveOwnerActionSubmitterKind, submitterKindForOwnerMode } = await import('../src/ui/pca/ownerActions.js');

const HOT = `0x${'11'.repeat(20)}`; // this node's primary operational (daemon) wallet
const HW = `0x${'22'.repeat(20)}`; // a connected browser wallet
const EXTERNAL = `0x${'33'.repeat(20)}`; // a third-party owner

describe('resolvePcaOwnerAccess — core classification', () => {
  it('daemon wins even when the primary wallet is ALSO the connected wallet (inv-17 ordering)', () => {
    const access = resolvePcaOwnerAccess({ owner: HOT, primaryWallet: HOT, connectedWallet: HOT });
    expect(access.mode).toBe('daemon');
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
  });

  it('connected owner != primary → wallet-managed', () => {
    const access = resolvePcaOwnerAccess({ owner: HW, primaryWallet: HOT, connectedWallet: HW });
    expect(access.mode).toBe('wallet');
    expect(access.writesEnabled).toBe(true);
  });

  it('wrong-network wallet: mode STAYS wallet (address-only), only writesEnabled flips', () => {
    const access = resolvePcaOwnerAccess({ owner: HW, primaryWallet: HOT, connectedWallet: HW, walletWrongNetwork: true });
    expect(access.mode).toBe('wallet'); // network is NOT folded into classification
    expect(access.wrongNetwork).toBe(true);
    expect(access.writesEnabled).toBe(false); // the network gate lives here, separately
  });

  it('external (a wallet is connected but is not the owner) → not enabled', () => {
    const access = resolvePcaOwnerAccess({ owner: EXTERNAL, primaryWallet: HOT, connectedWallet: HW });
    expect(access.mode).toBe('external');
    expect(access.writesEnabled).toBe(false);
  });

  it('external (no wallet connected) → not enabled', () => {
    const access = resolvePcaOwnerAccess({ owner: EXTERNAL, primaryWallet: HOT, connectedWallet: null });
    expect(access.mode).toBe('external');
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
  it("wallets-unreadable: primaryWalletState 'unreadable' wins even with an owner present", () => {
    const access = resolvePcaOwnerAccess({ owner: HOT, primaryWallet: HOT, connectedWallet: HOT, primaryWalletState: 'unreadable' });
    expect(access.mode).toBe('unknown');
    expect(access.ownerUnknownCause).toBe('wallets-unreadable');
    expect(access.writesEnabled).toBe(false);
  });

  it('no-snapshot: a missing owner (no PCA snapshot) → unknown', () => {
    const access = resolvePcaOwnerAccess({ owner: undefined, primaryWallet: HOT, connectedWallet: HW });
    expect(access.mode).toBe('unknown');
    expect(access.ownerUnknownCause).toBe('no-snapshot');
    expect(access.writesEnabled).toBe(false);
  });

  it('empty-string owner is treated as no-snapshot', () => {
    const access = resolvePcaOwnerAccess({ owner: '', primaryWallet: HOT, connectedWallet: HW });
    expect(access.mode).toBe('unknown');
    expect(access.ownerUnknownCause).toBe('no-snapshot');
  });

  it("primaryWalletState 'unreadable' takes precedence over a missing owner (documented ordering)", () => {
    const access = resolvePcaOwnerAccess({ owner: undefined, primaryWallet: HOT, connectedWallet: HW, primaryWalletState: 'unreadable' });
    expect(access.mode).toBe('unknown');
    expect(access.ownerUnknownCause).toBe('wallets-unreadable');
  });
});

describe('resolvePcaOwnerAccess — primaryWalletState load model (#1470)', () => {
  it("'loading' → unknown + cause 'wallets-loading' + writesEnabled false", () => {
    const access = resolvePcaOwnerAccess({ owner: HOT, primaryWallet: HOT, connectedWallet: HOT, primaryWalletState: 'loading' });
    expect(access.mode).toBe('unknown');
    expect(access.ownerUnknownCause).toBe('wallets-loading');
    expect(access.writesEnabled).toBe(false);
  });

  it("'unreadable' → unknown + cause 'wallets-unreadable'", () => {
    const access = resolvePcaOwnerAccess({ owner: HOT, primaryWallet: HOT, connectedWallet: HOT, primaryWalletState: 'unreadable' });
    expect(access.mode).toBe('unknown');
    expect(access.ownerUnknownCause).toBe('wallets-unreadable');
    expect(access.writesEnabled).toBe(false);
  });

  it("'ready' with a valid owner/primary → classifies normally (daemon), no unknown cause", () => {
    const access = resolvePcaOwnerAccess({ owner: HOT, primaryWallet: HOT, connectedWallet: HOT, primaryWalletState: 'ready' });
    expect(access.mode).toBe('daemon');
    expect(access.ownerUnknownCause).toBeUndefined();
    expect(access.writesEnabled).toBe(true);
  });

  it("omitted primaryWalletState behaves as 'ready' (classifies normally)", () => {
    const access = resolvePcaOwnerAccess({ owner: HW, primaryWallet: HOT, connectedWallet: HW });
    expect(access.mode).toBe('wallet');
    expect(access.ownerUnknownCause).toBeUndefined();
  });
});

// `mayTargetWritePromptWallet(access, owner, connectedWallet)` is a pure helper OVER the model
// (not a field on it). Each case builds `access` then asserts the helper's verdict for the same
// owner/connectedWallet inputs.
describe('mayTargetWritePromptWallet — truth table (#1469 + R4)', () => {
  it('(i) loaded wallet-owned, right network ⇒ true', () => {
    const access = resolvePcaOwnerAccess({ owner: HW, primaryWallet: HOT, connectedWallet: HW });
    expect(access.mode).toBe('wallet');
    expect(access.writesEnabled).toBe(true);
    expect(mayTargetWritePromptWallet(access, HW, HW)).toBe(true);
  });

  it('(ii) loaded wallet-owned, WRONG network ⇒ false (mode wallet, writesEnabled false)', () => {
    const access = resolvePcaOwnerAccess({ owner: HW, primaryWallet: HOT, connectedWallet: HW, walletWrongNetwork: true });
    expect(access.mode).toBe('wallet');
    expect(access.writesEnabled).toBe(false);
    expect(mayTargetWritePromptWallet(access, HW, HW)).toBe(false);
  });

  it('(iii) daemon-owned (owner==primary, owner!=connected) ⇒ false', () => {
    const access = resolvePcaOwnerAccess({ owner: HOT, primaryWallet: HOT, connectedWallet: HW });
    expect(access.mode).toBe('daemon');
    expect(mayTargetWritePromptWallet(access, HOT, HW)).toBe(false);
  });

  it('(iv) #1469: primaryWalletState loading, owner undefined, connectedWallet set ⇒ true', () => {
    const access = resolvePcaOwnerAccess({ owner: undefined, primaryWallet: HOT, connectedWallet: HW, primaryWalletState: 'loading' });
    expect(access.mode).toBe('unknown');
    expect(access.ownerUnknownCause).toBe('wallets-loading');
    expect(mayTargetWritePromptWallet(access, undefined, HW)).toBe(true);
  });

  it('(v) R4: mode unknown (loading), owner == connectedWallet ⇒ true', () => {
    const access = resolvePcaOwnerAccess({ owner: HW, primaryWallet: HOT, connectedWallet: HW, primaryWalletState: 'loading' });
    expect(access.mode).toBe('unknown');
    expect(mayTargetWritePromptWallet(access, HW, HW)).toBe(true);
  });

  it('(vi) unknown (loading) + NO connected wallet ⇒ false', () => {
    const access = resolvePcaOwnerAccess({ owner: undefined, primaryWallet: HOT, connectedWallet: null, primaryWalletState: 'loading' });
    expect(access.mode).toBe('unknown');
    expect(mayTargetWritePromptWallet(access, undefined, null)).toBe(false);
  });

  it('(vii) unknown (loading) + owner present but != connectedWallet ⇒ false', () => {
    const access = resolvePcaOwnerAccess({ owner: EXTERNAL, primaryWallet: HOT, connectedWallet: HW, primaryWalletState: 'loading' });
    expect(access.mode).toBe('unknown');
    expect(mayTargetWritePromptWallet(access, EXTERNAL, HW)).toBe(false);
  });

  it("(viii) #1469 wallets-loaded-before-snapshot: owner undefined, primaryWalletState 'ready', connectedWallet set ⇒ no-snapshot + true", () => {
    // Distinct code path from (iv): wallets are READY but the PCA snapshot (owner) isn't loaded
    // yet, so classification falls through to the `!owner` → no-snapshot branch. The lock must
    // still arm for the connected wallet (the resolving submitter confirms the owner call-time).
    const access = resolvePcaOwnerAccess({ owner: undefined, primaryWallet: HOT, connectedWallet: HW, primaryWalletState: 'ready' });
    expect(access.mode).toBe('unknown');
    expect(access.ownerUnknownCause).toBe('no-snapshot');
    expect(mayTargetWritePromptWallet(access, undefined, HW)).toBe(true);
  });

  it('(ix) loaded EXTERNAL-owned (a wallet is connected but is not the owner) ⇒ false', () => {
    // Locks the `external` branch against a future fall-through: an external owner can never open a
    // wallet prompt (the connected wallet isn't the owner), so the lock must stay disarmed.
    const access = resolvePcaOwnerAccess({ owner: EXTERNAL, primaryWallet: HOT, connectedWallet: HW });
    expect(access.mode).toBe('external');
    expect(mayTargetWritePromptWallet(access, EXTERNAL, HW)).toBe(false);
  });
});

describe('resolvePrimaryWalletState', () => {
  it('data present ⇒ ready (even with a stale error)', () => {
    expect(resolvePrimaryWalletState({ wallets: [HOT] }, null)).toBe('ready');
    expect(resolvePrimaryWalletState({ wallets: [] }, new Error('stale'))).toBe('ready');
  });
  it('no data + error ⇒ unreadable', () => {
    expect(resolvePrimaryWalletState(null, new Error('balances down'))).toBe('unreadable');
    expect(resolvePrimaryWalletState(undefined, 'boom')).toBe('unreadable');
  });
  it('no data + no error ⇒ loading', () => {
    expect(resolvePrimaryWalletState(null, null)).toBe('loading');
    expect(resolvePrimaryWalletState(undefined, undefined)).toBe('loading');
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

      it('submitterKindForOwnerMode(mode) == ownerActions.resolveOwnerActionSubmitterKind (address-only)', () => {
        expect(submitterKindForOwnerMode(access.mode)).toBe(
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
