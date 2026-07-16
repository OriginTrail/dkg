/**
 * PR #1366 — PCA CG-registration deposit WAIVER (OT-RFC-53) devnet validation.
 *
 * The PR adds a quota-bounded waiver to the per-CG registration deposit:
 * a Context Graph whose publish authority is a DKGPublishingConvictionNFT
 * account (PCA) the creator owns (or is a registered agent of) is created
 * WITHOUT the registration deposit — up to a per-PCA quota of
 * `committedTRAC / deposit` CGs. A governance stake floor
 * (`ParametersStorage.minPcaCommitmentForCgWaiver`) gates the perk so a
 * dust / sub-floor PCA gets no free CGs.
 *
 * The deposit charge + waiver decision live in `ContextGraphs.createContextGraph`
 * (gated on `deposit > 0`): it calls `ContextGraphWaiverStorage.tryConsumeWaiver`
 * once and, when that returns false, `transferFrom`s the deposit from the creator.
 * The per-PCA quota counter (`waivedCgCount`) lives in the NEW standalone
 * `ContextGraphWaiverStorage`.
 *
 * ── PATH: contract (NOT daemon) ─────────────────────────────────────────
 * There is no node HTTP route that creates a CG with a PCA publish authority;
 * CG creation is the `ContextGraphs` facade (chain). So every assertion is
 * driven END-TO-END at the contract layer via the harness `contractAt` +
 * ethers — the real `createContextGraph` call, the real `tryConsumeWaiver`
 * call site, the real charge branch.
 *
 * ── The deposit is DORMANT (0) on this shared devnet ────────────────────
 * `ParametersStorage.contextGraphRegistrationDeposit()` ships at 0, so the
 * production gate `if (deposit > 0)` is normally skipped (no waiver, no charge).
 * To genuinely exercise the waiver we TEMPORARILY set the deposit non-zero with
 * the real Hub-owner key (account #0 / `0xf39F…2266`, which owns this devnet's
 * Hub), run every assertion, then RESET the deposit to its snapshot (0) in an
 * `afterAll` (runs even on failure) AND defensively before/after. The suite
 * leaves the global param exactly as found (verified == 0), so the later 10.0.2
 * sweep suites that assume a dormant deposit are unaffected.
 *
 *   deposit = floor / 2 (= 12_500 TRAC). One value satisfies all three cases:
 *     • committed 500_000  → quota 40   (waive)
 *     • committed 1_000    → < floor    (no waiver → charge)
 *     • committed = floor  → quota 2    (waive, waive, charge)
 *
 * ISOLATION: every PCA is a fresh `createFreshPca` (throwaway owner wallet,
 * funded via storage writes); the only state mutated is each fresh PCA's own
 * `waivedCgCount`, fresh CGs, and the global deposit param (snapshotted+reset).
 * No real node wallet/identity, no shared `devnet-test` CG. No time-warp.
 *
 * Preconditions: ./scripts/devnet.sh start 6
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ethers } from 'ethers';
import {
  detectDevnet,
  ensureAllIdentities,
  createFreshPca,
  contractAt,
  nextNonce,
  type DevnetState,
} from '../_bootstrap/harness.js';

// Hub owner on this devnet (verified: Hub.owner() == this address). Owns
// ParametersStorage's `onlyOwnerOrMultiSigOwner` setter, so it can flip the
// registration deposit. This is the well-known hardhat account #0.
const HUB_OWNER_PK =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const WAIVER_ABI = [
  'function tryConsumeWaiver(uint256 accountId, address creator, uint96 deposit) returns (bool)',
  'function waivedCgCount(uint256 accountId) view returns (uint256)',
  'event RegistrationDepositWaived(uint256 indexed accountId, address indexed creator, uint256 newWaivedCount, uint256 quota)',
];

const PARAMS_ABI = [
  'function contextGraphRegistrationDeposit() view returns (uint96)',
  'function minPcaCommitmentForCgWaiver() view returns (uint96)',
  'function setContextGraphRegistrationDeposit(uint96 amount)',
];

const CG_ABI = [
  'function createContextGraph(address[] participantAgents, uint256 metadataBatchId, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId, bytes32 nameHash) returns (uint256)',
  'function contextGraphStorage() view returns (address)',
  'event ContextGraphRegistrationDepositWaived(uint256 indexed contextGraphId, uint256 indexed accountId, address indexed creator)',
  'event ContextGraphRegistrationDeposited(uint256 indexed contextGraphId, address indexed payer, uint96 amount)',
];

const CG_STORAGE_ABI = [
  'event ContextGraphCreated(uint256 indexed contextGraphId, address indexed owner, bytes32 indexed nameHash, address[] participantAgents, uint256 metadataBatchId, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId)',
  'function getPublishAuthorityAccountId(uint256 contextGraphId) view returns (uint256)',
  'function getContextGraphOwner(uint256 contextGraphId) view returns (address)',
];

const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const waiverIface = new ethers.Interface(WAIVER_ABI);
const cgIface = new ethers.Interface(CG_ABI);
const cgStorageIface = new ethers.Interface(CG_STORAGE_ABI);

let uniqueCg = 0;
const freshNameHash = () =>
  ethers.keccak256(ethers.toUtf8Bytes(`pr1366cg-${Date.now()}-${++uniqueCg}`));

describe('PR #1366 — PCA CG-registration deposit waiver (OT-RFC-53)', () => {
  let state: DevnetState;
  let waiver: ethers.Contract; // ContextGraphWaiverStorage (read)
  let cgStorage: ethers.Contract; // ContextGraphStorage (read, resolved via ContextGraphs)
  let params: ethers.Contract; // ParametersStorage (read)
  let token: ethers.Contract; // Token (read)
  let cgAddr: string; // ContextGraphs facade address (spender for the deposit)
  let floor: bigint; // live minPcaCommitmentForCgWaiver (25_000 TRAC)
  let DEPOSIT: bigint; // = floor / 2 (12_500 TRAC) — used for the whole suite
  let depositSnapshot: bigint; // original (dormant) deposit, restored in afterAll
  let ownerWallet: ethers.Wallet;
  let depositActivated = false;

  // Set the global registration deposit using the real Hub-owner key.
  async function setDeposit(amount: bigint): Promise<void> {
    const paramsAsOwner = params.connect(ownerWallet) as ethers.Contract;
    const tx = await paramsAsOwner.setContextGraphRegistrationDeposit(amount, {
      nonce: await nextNonce(state.provider, ownerWallet.address),
    });
    await tx.wait();
    const got: bigint = await params.contextGraphRegistrationDeposit();
    if (got !== amount) {
      throw new Error(`setContextGraphRegistrationDeposit mismatch: wanted ${amount}, got ${got}`);
    }
  }

  beforeAll(async () => {
    const detected = await detectDevnet(6);
    if (!detected) {
      throw new Error(
        'No devnet detected — run `./scripts/devnet.sh start 6` before this suite.',
      );
    }
    state = detected;
    await ensureAllIdentities(state, 4);

    // ContextGraphs is the real Hub name; ContextGraphWaiverStorage too.
    // ContextGraphStorage is NOT Hub-registered — resolve it via the facade.
    cgAddr = state.addrs.ContextGraphs;
    expect(cgAddr, 'ContextGraphs must be registered in the Hub').toBeTruthy();
    waiver = contractAt(state, 'ContextGraphWaiverStorage', WAIVER_ABI);
    params = contractAt(state, 'ParametersStorage', PARAMS_ABI);
    token = new ethers.Contract(await state.token.getAddress(), TOKEN_ABI, state.provider);

    const cgRead = new ethers.Contract(cgAddr, CG_ABI, state.provider);
    const cgStorageAddr: string = await cgRead.contextGraphStorage();
    expect(cgStorageAddr, 'ContextGraphs must expose its storage contract').toBeTruthy();
    cgStorage = new ethers.Contract(cgStorageAddr, CG_STORAGE_ABI, state.provider);

    floor = await params.minPcaCommitmentForCgWaiver();
    expect(floor, 'minPcaCommitmentForCgWaiver should be a positive floor').toBeGreaterThan(0n);
    DEPOSIT = floor / 2n; // quota at committed==floor is exactly 2

    // The Hub owner key must actually be the Hub owner, else the setter reverts.
    ownerWallet = new ethers.Wallet(HUB_OWNER_PK, state.provider);
    const hubOwner: string = await (
      new ethers.Contract(
        state.addrs.Hub,
        ['function owner() view returns (address)'],
        state.provider,
      ).owner()
    );
    expect(
      hubOwner.toLowerCase(),
      'HUB_OWNER_PK must control the live Hub owner (else setter is unauthorized)',
    ).toBe(ownerWallet.address.toLowerCase());
    await state.provider.send('hardhat_setBalance', [
      ownerWallet.address,
      '0x' + ethers.parseEther('100').toString(16),
    ]);

    // Snapshot the dormant deposit, then activate it for the suite.
    depositSnapshot = await params.contextGraphRegistrationDeposit();
    await setDeposit(DEPOSIT);
    depositActivated = true;
  });

  afterAll(async () => {
    // Always restore the global param to its snapshot (0) — the rest of the
    // 10.0.2 sweep depends on a dormant deposit. Runs even on test failure.
    if (depositActivated) {
      await setDeposit(depositSnapshot);
      const restored: bigint = await params.contextGraphRegistrationDeposit();
      expect(restored, 'deposit must be reset to its dormant snapshot').toBe(depositSnapshot);
      expect(restored, 'deposit must be back to 0 for later sweep suites').toBe(0n);
    }
  });

  // Parse the waiver-storage event (carries newWaivedCount + quota).
  function parseWaivedEvent(receipt: ethers.TransactionReceipt | null) {
    for (const log of receipt?.logs ?? []) {
      try {
        const parsed = waiverIface.parseLog(log);
        if (parsed?.name === 'RegistrationDepositWaived') return parsed.args;
      } catch {
        /* unrelated log */
      }
    }
    return null;
  }

  // Did the facade emit its own "waived" / "deposited" markers on this receipt?
  function depositMarkers(receipt: ethers.TransactionReceipt | null) {
    let waived = false;
    let deposited = false;
    let depositedAmount = 0n;
    for (const log of receipt?.logs ?? []) {
      try {
        const p = cgIface.parseLog(log);
        if (p?.name === 'ContextGraphRegistrationDepositWaived') waived = true;
        if (p?.name === 'ContextGraphRegistrationDeposited') {
          deposited = true;
          depositedAmount = p.args.amount as bigint;
        }
      } catch {
        /* not a deposit event */
      }
    }
    return { waived, deposited, depositedAmount };
  }

  function cgIdFromReceipt(receipt: ethers.TransactionReceipt | null): bigint {
    for (const log of receipt?.logs ?? []) {
      try {
        const p = cgStorageIface.parseLog(log);
        if (p?.name === 'ContextGraphCreated') return p.args.contextGraphId as bigint;
      } catch {
        /* not the create event */
      }
    }
    return 0n;
  }

  // Create a curated, PCA-mode CG as `owner` (publishAuthority = owner, the PCA
  // owner). `approve` controls the charge path: WITHOUT an approval the charge
  // branch reverts (TooLowAllowance), so omit it on the waived path as a guard.
  async function createPcaCg(
    owner: ethers.Wallet,
    accountId: bigint,
    opts: { approveDeposit?: bigint } = {},
  ): Promise<ethers.TransactionReceipt | null> {
    if (opts.approveDeposit !== undefined) {
      const tokenAsOwner = token.connect(owner) as ethers.Contract;
      await (
        await tokenAsOwner.approve(cgAddr, opts.approveDeposit, {
          nonce: await nextNonce(state.provider, owner.address),
        })
      ).wait();
    }
    const cg = new ethers.Contract(cgAddr, CG_ABI, owner);
    const tx = await cg.createContextGraph([], 0n, 0, 0, owner.address, accountId, freshNameHash(), {
      nonce: await nextNonce(state.provider, owner.address),
    });
    return tx.wait();
  }

  it('waives the deposit for a well-funded PCA the creator owns: waivedCgCount 0→1, no TRAC pulled', async () => {
    // 500_000 TRAC committed ≫ floor (25_000) ⇒ eligible. quota = 500_000/12_500 = 40.
    const pca = await createFreshPca(state, { committedTrac: ethers.parseEther('500000') });
    const W = pca.admin;

    expect(await waiver.waivedCgCount(pca.accountId), 'fresh PCA starts with zero waived CGs').toBe(0n);
    const tracBefore: bigint = await token.balanceOf(W.address);

    // No approve on purpose: if the waiver silently failed, the charge branch
    // would revert on missing allowance — so a green create proves it waived.
    const receipt = await createPcaCg(W, pca.accountId);

    expect(await waiver.waivedCgCount(pca.accountId), 'one waived CG recorded after create').toBe(1n);
    // The waived path pulls NO deposit — the creator's liquid TRAC is untouched.
    expect(await token.balanceOf(W.address), 'no deposit may be pulled on the waived path').toBe(tracBefore);

    // Facade emitted the waive marker, not the charge marker.
    const markers = depositMarkers(receipt);
    expect(markers.waived, 'ContextGraphRegistrationDepositWaived must fire').toBe(true);
    expect(markers.deposited, 'no deposit may be charged on the waived path').toBe(false);

    // Waiver-storage event carries the consumed count + the per-PCA quota.
    const ev = parseWaivedEvent(receipt);
    expect(ev, 'RegistrationDepositWaived must be emitted by the waiver storage').not.toBeNull();
    expect(ev!.accountId).toBe(pca.accountId);
    expect((ev!.creator as string).toLowerCase()).toBe(W.address.toLowerCase());
    expect(ev!.newWaivedCount).toBe(1n);
    expect(ev!.quota, 'quota = committedTRAC / deposit').toBe(ethers.parseEther('500000') / DEPOSIT);
  });

  it('does NOT waive for a sub-floor (dust) PCA — the deposit IS charged, waivedCgCount unchanged', async () => {
    // 1_000 TRAC committed < floor (25_000) ⇒ Gate 2 blocks the waiver.
    const pca = await createFreshPca(state, { committedTrac: ethers.parseEther('1000') });
    const W = pca.admin;

    const before: bigint = await waiver.waivedCgCount(pca.accountId);
    const tracBefore: bigint = await token.balanceOf(W.address);

    // Approve the deposit so the (expected) charge branch can pull it.
    const receipt = await createPcaCg(W, pca.accountId, { approveDeposit: DEPOSIT });

    // No waiver consumed for a sub-floor PCA.
    expect(await waiver.waivedCgCount(pca.accountId), 'sub-floor PCA leaves waivedCgCount unchanged').toBe(before);
    expect(parseWaivedEvent(receipt), 'no waiver event for a sub-floor PCA').toBeNull();

    // The deposit WAS charged: facade emitted Deposited and the creator's TRAC fell by exactly the deposit.
    const markers = depositMarkers(receipt);
    expect(markers.waived, 'sub-floor PCA must not emit a waive marker').toBe(false);
    expect(markers.deposited, 'sub-floor PCA must pay the registration deposit').toBe(true);
    expect(markers.depositedAmount, 'charged amount equals the active deposit').toBe(DEPOSIT);
    expect(await token.balanceOf(W.address), 'creator TRAC decreases by exactly the deposit').toBe(
      tracBefore - DEPOSIT,
    );
  });

  it('enforces the per-PCA quota (committedTRAC / deposit): waives up to quota, then charges', async () => {
    // committed == floor, deposit == floor/2 ⇒ quota = 2 (waive, waive, then charge).
    const pca = await createFreshPca(state, { committedTrac: floor });
    const W = pca.admin;
    const expectedQuota = floor / DEPOSIT;
    expect(expectedQuota, 'fixture must yield a small quota').toBe(2n);

    // First `quota` creations are waived (no approve needed — would revert if not waived).
    for (let i = 1n; i <= expectedQuota; i++) {
      const receipt = await createPcaCg(W, pca.accountId);
      expect(await waiver.waivedCgCount(pca.accountId), `count after waived create #${i}`).toBe(i);
      expect(depositMarkers(receipt).waived, `create #${i} must be waived`).toBe(true);
    }

    // Quota now exhausted: the next create must CHARGE (approve so it can).
    const tracBefore: bigint = await token.balanceOf(W.address);
    const receipt = await createPcaCg(W, pca.accountId, { approveDeposit: DEPOSIT });

    expect(await waiver.waivedCgCount(pca.accountId), 'waivedCgCount caps at the quota').toBe(expectedQuota);
    expect(parseWaivedEvent(receipt), 'no waiver event once quota is exhausted').toBeNull();
    const markers = depositMarkers(receipt);
    expect(markers.deposited, 'over-quota create must pay the deposit').toBe(true);
    expect(markers.depositedAmount).toBe(DEPOSIT);
    expect(await token.balanceOf(W.address), 'creator charged exactly one deposit past quota').toBe(
      tracBefore - DEPOSIT,
    );
  });

  it('createContextGraph in PCA mode wires the PCA authority + owner into storage', async () => {
    // End-to-end: a fresh PCA owner mints a curated, PCA-mode CG; the waiver
    // fires (well-funded PCA) and storage records the authority + owner.
    const pca = await createFreshPca(state, { committedTrac: ethers.parseEther('500000') });
    const W = pca.admin;

    const receipt = await createPcaCg(W, pca.accountId);
    const cgId = cgIdFromReceipt(receipt);
    expect(cgId, 'a context graph must be minted').toBeGreaterThan(0n);

    expect(
      await cgStorage.getPublishAuthorityAccountId(cgId),
      'PCA-mode CG must store the PCA accountId as its publish authority',
    ).toBe(pca.accountId);
    expect(
      (await cgStorage.getContextGraphOwner(cgId)).toLowerCase(),
      'the creator wallet owns the CG',
    ).toBe(W.address.toLowerCase());
  });
});
