/**
 * V10 PCA deterministic emission (bell) — devnet validation (OT-RFC-58, 10.0.8).
 *
 * The SUCCESSOR to devnet/conviction-lazy-settle: 10.0.8 replaces the lazy
 * active/passive sink with an eager, deterministic emission schedule written
 * up front at account creation. This suite asserts the new invariants against
 * a live 6-node devnet, using PER-TX EpochStorage events (not shared
 * getEpochPool deltas) so unrelated daemon publishes in the same epoch range
 * can neither mask a regression nor cause a flake.
 *
 *   step 2  createAccount writes the FULL schedule: `EmissionScheduled` with
 *           `scheduled == committedTRAC` (treasury unset on devnet ⇒
 *           `treasuryFee == 0`), and the tx credits EpochStorage's staker
 *           shard forward of the creation epoch, summing to `committedTRAC`.
 *           (Inverts lazy-settle step 2, which asserted createAccount emits
 *           NOTHING.)
 *   step 3  `coverPublishingCost` (driven against the DEPLOYED logic by
 *           impersonating the NFT wrapper's onlyConvictionNFT gate) draws the
 *           per-window budget (`windowSpent` grows; `CostCovered` shows a base
 *           draw, no topUp) but emits NOTHING further to the pool — the base
 *           TRAC is already scheduled, so there is no double emission.
 *   step 4  `settle()` before expiry is a pure no-op.
 *   step 5  THE MAINNET MIGRATION PATH: a synthetic PRE-10.0.8 account
 *           (planted in PublishingConvictionStorage with lastSettledWindow==0
 *           and a prior windowSpent) is back-filled by `migrateEmissionSchedule`
 *           to exactly `committed − spent`, forward-spread; re-migrating is a
 *           no-op.
 *   step 6  `migrateEmissionSchedule([id])` on a 10.0.8-CREATED account is
 *           idempotent (the `lastSettledWindow == lock` marker skips it).
 *
 * Coverage: steps 2-4 exercise REGULAR activity on fresh 10.0.8 accounts;
 * step 5 exercises the one-time MIGRATION of legacy accounts (the exact
 * mainnet `migrateEmissionSchedule([1,2,3,…])` operation); step 6 the
 * migration's idempotence guard.
 *
 * All assertions run against the LIVE devnet-deployed contracts (real Hub, NFT
 * wrapper, PublishingConviction logic, EpochStorage) — validating the actual
 * deployed 10.0.8 bytecode, not a fresh unit-test deploy. The suite is
 * chain-driven (no node-daemon dependency): step 3 exercises the publish-cost
 * path by impersonating the NFT rather than driving the multi-step KA-lifecycle
 * publish flow, which keeps it robust. (An end-to-end node-publish variant is a
 * possible future addition once the KA-lifecycle CLI harness is updated — the
 * same update conviction-lazy-settle needs.)
 *
 * Preconditions:
 *   ./scripts/devnet.sh clean
 *   ./scripts/devnet.sh start 6
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ethers } from 'ethers';

const REPO_ROOT = resolve(__dirname, '../..');
const RPC = 'http://127.0.0.1:8545';
const HARDHAT_DEPLOYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// Mirrors `PublishingConviction.STAKER_SHARD_ID` / `TREASURY_SHARD_ID`.
const STAKER_SHARD_ID = 1n;
const TREASURY_SHARD_ID = 2n;
// Shrunken lock so a full lifecycle fits in test time (same rationale as
// conviction-lazy-settle step 1).
const TEST_LOCK = 3n;

interface Contracts {
  provider: ethers.JsonRpcProvider;
  nft: ethers.Contract;
  logic: ethers.Contract;
  logicAddress: string;
  pcs: ethers.Contract;
  token: ethers.Contract;
  chronos: ethers.Contract;
  eps: ethers.Contract;
  epsAddress: string;
  parameters: ethers.Contract;
  paramsRw: ethers.Contract;
  cssAddress: string;
  hubOwner: ethers.Wallet;
}

async function loadContracts(): Promise<Contracts> {
  const contractsPath = join(
    REPO_ROOT,
    'packages/evm-module/deployments/localhost_contracts.json',
  );
  const contracts = JSON.parse(readFileSync(contractsPath, 'utf8'));
  const c = (n: string): string => contracts.contracts[n]?.evmAddress;

  const provider = new ethers.JsonRpcProvider(RPC, { chainId: 31337, name: 'localhost' });
  // Mining is on a 1s interval (devnet.sh) — disable client-side caching to
  // avoid 0-block-old readbacks racing the interval miner.
  provider.pollingInterval = 250;

  // NFT wrapper = call entry point; state-mapping forwarders + createAccount.
  const nft = new ethers.Contract(
    c('DKGPublishingConvictionNFT'),
    [
      'function createAccount(uint96, uint72) external returns (uint256)',
      'function registerAgent(uint256, address) external',
      'function deregisterAgent(uint256, address) external',
      'function agentToAccountId(address) view returns (uint256)',
      'function accounts(uint256) view returns (uint96 committedTRAC,uint40 createdAtEpoch,uint40 expiresAtEpoch,uint40 createdAtTimestamp,uint40 expiresAtTimestamp,uint16 lockDurationEpochs,uint16 discountBps,uint16 lastSettledWindow,bool fullySwept,uint72 primaryNode,uint40 lastPrimaryNodeChangeEpoch)',
      'function windowSpent(uint256, uint40) view returns (uint96)',
      'function topUpBalance(uint256) view returns (uint96)',
      'function getCurrentBillingWindow(uint256) view returns (uint40)',
      'function settle(uint256) external',
    ],
    provider,
  );
  // Logic contract — events + owner-gated migration live here (post-PR-#650
  // split). Signatures MUST mirror PublishingConviction.sol (10.0.8); a drift
  // silently turns a parseLog into a miss and the assertions pass vacuously.
  const logicAddress = c('PublishingConviction');
  const logic = new ethers.Contract(
    logicAddress,
    [
      'event AccountCreated(uint256 indexed accountId, address indexed owner, uint96 committedTRAC, uint16 discountBps, uint40 createdAtEpoch, uint40 expiresAtEpoch)',
      'event CostCovered(uint256 indexed accountId, uint40 indexed epoch, uint96 baseCost, uint96 discountedCost, uint96 drawnFromEpoch, uint96 drawnFromTopUp)',
      // 10.0.8: fires once per account when its schedule is written. `scheduled`
      // = staker-shard total, `treasuryFee` = treasury-shard total (0 while the
      // protocol treasury is unset — the devnet default).
      'event EmissionScheduled(uint256 indexed accountId, uint40 fromWindow, uint40 toWindow, uint96 scheduled, uint96 treasuryFee)',
      'event AgentRegistered(uint256 indexed accountId, address indexed agent)',
      'function migrateEmissionSchedule(uint256[]) external',
      // Driven directly (via the onlyConvictionNFT gate, by impersonating the
      // NFT) in step 3 to exercise the deployed budget-gate.
      'function coverPublishingCost(address publishingAgent, uint96 baseCost, uint40 kaStartEpoch, uint40 kaEpochs) external returns (uint96 discountedCost)',
    ],
    provider,
  );
  const token = new ethers.Contract(
    c('Token'),
    [
      'function balanceOf(address) view returns (uint256)',
      'function approve(address, uint256) returns (bool)',
      'function mint(address, uint256)',
    ],
    provider,
  );
  const chronos = new ethers.Contract(
    c('Chronos'),
    [
      'function getCurrentEpoch() view returns (uint256)',
      'function epochLength() view returns (uint256)',
      'function epochAtTimestamp(uint256) view returns (uint256)',
      'function timestampForEpoch(uint256) view returns (uint256)',
    ],
    provider,
  );
  // Application-state store — used to PLANT a synthetic pre-10.0.8 account for
  // the migration test (step 5). `onlyContracts` admits the Hub owner, so the
  // deployer EOA can write a legacy-shaped account directly, exactly as the
  // hardhat P4/P5b property tests do.
  const pcs = new ethers.Contract(
    c('PublishingConvictionStorage'),
    [
      'function createAccount(uint256 accountId, (uint96 committedTRAC,uint40 createdAtEpoch,uint40 expiresAtEpoch,uint40 createdAtTimestamp,uint40 expiresAtTimestamp,uint16 lockDurationEpochs,uint16 discountBps,uint16 lastSettledWindow,bool fullySwept,uint72 primaryNode,uint40 lastPrimaryNodeChangeEpoch) acct) external',
      'function increaseWindowSpent(uint256, uint40, uint96) external',
      'function accountExists(uint256) view returns (bool)',
      'function getAccount(uint256) view returns (uint96 committedTRAC,uint40 createdAtEpoch,uint40 expiresAtEpoch,uint40 createdAtTimestamp,uint40 expiresAtTimestamp,uint16 lockDurationEpochs,uint16 discountBps,uint16 lastSettledWindow,bool fullySwept,uint72 primaryNode,uint40 lastPrimaryNodeChangeEpoch)',
    ],
    provider,
  );
  // Hub-registered name is "EpochStorageV8"; the V10 NFT resolves it via that key.
  const epsAddress = c('EpochStorageV8');
  const eps = new ethers.Contract(
    epsAddress,
    [
      'function getEpochPool(uint256 shardId, uint256 epoch) view returns (uint96)',
      // Only `shardId` is indexed — mirror EpochStorage.sol. We isolate MY
      // account's emission from daemon noise by parsing per-tx logs of this event.
      'event TokensAddedToEpochRange(uint256 indexed shardId, uint256 startEpoch, uint256 endEpoch, uint96 tokenAmount, uint96 remainder)',
    ],
    provider,
  );
  const parameters = new ethers.Contract(
    c('ParametersStorage'),
    [
      'function publishingConvictionEpochs() view returns (uint256)',
      'function setPublishingConvictionEpochs(uint256)',
    ],
    provider,
  );
  const hubOwner = new ethers.Wallet(HARDHAT_DEPLOYER_KEY, provider);
  return {
    provider,
    nft,
    logic,
    logicAddress,
    pcs,
    token,
    chronos,
    eps,
    epsAddress,
    parameters,
    paramsRw: parameters.connect(hubOwner) as ethers.Contract,
    cssAddress: c('ConvictionStakingStorage'),
    hubOwner,
  };
}

async function ensureAdminWallet(s: Contracts, tracAmount: bigint): Promise<ethers.HDNodeWallet> {
  const admin = ethers.Wallet.createRandom().connect(s.provider);
  await s.provider.send('hardhat_setBalance', [
    admin.address,
    '0x' + ethers.parseEther('100').toString(16),
  ]);
  const tokenAsDeployer = s.token.connect(s.hubOwner) as ethers.Contract;
  await (await tokenAsDeployer.mint(admin.address, tracAmount)).wait();
  return admin;
}

async function rawTxNonce(provider: ethers.JsonRpcProvider, addr: string): Promise<number> {
  const raw = await provider.send('eth_getTransactionCount', [addr, 'pending']);
  return parseInt(raw, 16);
}

// Sum the `tokenAmount` of every TokensAddedToEpochRange(shardId) emitted in a
// specific tx, and collect the (startEpoch,endEpoch) ranges. Per-tx scoping
// makes this immune to unrelated daemon publishes in the same block/epoch.
function epsCreditsInTx(
  s: Contracts,
  receipt: ethers.TransactionReceipt,
  shardId: bigint,
): { total: bigint; ranges: Array<{ start: bigint; end: bigint; amount: bigint }> } {
  const epsAddr = s.epsAddress.toLowerCase();
  let total = 0n;
  const ranges: Array<{ start: bigint; end: bigint; amount: bigint }> = [];
  for (const log of receipt.logs) {
    if ((log.address ?? '').toLowerCase() !== epsAddr) continue;
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = s.eps.interface.parseLog({ topics: log.topics as string[], data: log.data });
    } catch { continue; }
    if (parsed?.name !== 'TokensAddedToEpochRange') continue;
    if ((parsed.args.shardId as bigint) !== shardId) continue;
    total += parsed.args.tokenAmount as bigint;
    ranges.push({
      start: parsed.args.startEpoch as bigint,
      end: parsed.args.endEpoch as bigint,
      amount: parsed.args.tokenAmount as bigint,
    });
  }
  return { total, ranges };
}

const state: {
  s: Contracts | null;
  admin: ethers.HDNodeWallet | null;
  accountId: bigint;
  committed: bigint;
  agent: string | null;
  originalPublishingConvictionEpochs: bigint;
} = {
  s: null,
  admin: null,
  accountId: 0n,
  committed: 0n,
  agent: null,
  originalPublishingConvictionEpochs: 0n,
};

describe('V10 PCA deterministic emission (bell) — devnet validation', () => {
  beforeAll(async () => {
    state.s = await loadContracts();
  }, 60_000);

  afterAll(async () => {
    if (!state.s) return;
    const s = state.s;
    // Deregister the agent we bound so later suites don't route through this PCA.
    if (state.agent && state.accountId > 0n) {
      const admin = state.admin ?? s.hubOwner;
      const nftRw = s.nft.connect(admin) as ethers.Contract;
      try {
        const bound: bigint = await s.nft.agentToAccountId(state.agent);
        if (bound === state.accountId) {
          await (await nftRw.deregisterAgent(state.accountId, state.agent, {
            nonce: await rawTxNonce(s.provider, admin.address),
          })).wait();
        }
      } catch { /* best-effort */ }
    }
    // Restore publishingConvictionEpochs so later suites get the default back.
    if (state.originalPublishingConvictionEpochs > 0n) {
      try {
        const current: bigint = await s.parameters.publishingConvictionEpochs();
        if (current !== state.originalPublishingConvictionEpochs) {
          await (await s.paramsRw.setPublishingConvictionEpochs(
            state.originalPublishingConvictionEpochs,
            { nonce: await rawTxNonce(s.provider, s.hubOwner.address) },
          )).wait();
        }
      } catch { /* tolerated — a later suite surfaces a clearer message */ }
    }
  }, 120_000);

  it('step 1: shrink publishingConvictionEpochs so the bell fits in test time', async () => {
    const s = state.s!;
    const current: bigint = await s.parameters.publishingConvictionEpochs();
    state.originalPublishingConvictionEpochs = current;
    if (current !== TEST_LOCK) {
      await (await s.paramsRw.setPublishingConvictionEpochs(TEST_LOCK, {
        nonce: await rawTxNonce(s.provider, s.hubOwner.address),
      })).wait();
    }
    expect(await s.parameters.publishingConvictionEpochs()).toBe(TEST_LOCK);
  }, 60_000);

  it('step 2: createAccount writes the FULL eager schedule (scheduled == committed; forward of the creation epoch)', async () => {
    const s = state.s!;
    const committed = ethers.parseEther('600000'); // tier above 500k → 50% discount
    state.committed = committed;
    const admin = await ensureAdminWallet(s, committed);
    state.admin = admin;

    const nftAddr = await s.nft.getAddress();
    const tokenRw = s.token.connect(admin) as ethers.Contract;
    const nftRw = s.nft.connect(admin) as ethers.Contract;

    const cssBalBefore: bigint = await s.token.balanceOf(s.cssAddress);
    const currentEpoch: bigint = await s.chronos.getCurrentEpoch();

    await (await tokenRw.approve(nftAddr, committed, {
      nonce: await rawTxNonce(s.provider, admin.address),
    })).wait();

    // primaryNode = 0n: this suite validates the MONEY path (staker-pool
    // emission), not the K_n publishing-allocation seeding, so no node is
    // designated (keeps the assertions about EpochStorage credits clean).
    const receipt = await (await nftRw.createAccount(committed, 0n, {
      nonce: await rawTxNonce(s.provider, admin.address),
    })).wait();

    // AccountCreated → capture accountId.
    let accountId = 0n;
    let scheduledEvent: ethers.LogDescription | null = null;
    for (const log of receipt!.logs) {
      try {
        const parsed = s.logic.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === 'AccountCreated') accountId = parsed.args.accountId as bigint;
        if (parsed?.name === 'EmissionScheduled') scheduledEvent = parsed;
      } catch { /* not a Logic-contract event */ }
    }
    expect(accountId).toBeGreaterThan(0n);
    state.accountId = accountId;

    // Escrow moved (committed TRAC into the CSS vault).
    expect((await s.token.balanceOf(s.cssAddress)) - cssBalBefore).toBe(committed);

    // 10.0.8 INVARIANT — the full commitment is scheduled at creation.
    // EmissionScheduled(accountId, fromWindow=0, toWindow=lock, scheduled=committed, treasuryFee=0).
    expect(scheduledEvent, 'createAccount must emit EmissionScheduled (eager schedule)').not.toBeNull();
    expect(scheduledEvent!.args.accountId as bigint).toBe(accountId);
    expect(scheduledEvent!.args.fromWindow as bigint).toBe(0n);
    expect(scheduledEvent!.args.toWindow as bigint).toBe(TEST_LOCK);
    // Devnet has no protocol treasury wired ⇒ the whole commitment is staker-bound.
    expect(scheduledEvent!.args.treasuryFee as bigint).toBe(0n);
    expect(scheduledEvent!.args.scheduled as bigint).toBe(committed);

    // The createAccount tx credits the STAKER shard for the whole commitment,
    // forward of the creation epoch (never in or before it). Per-tx scoping
    // isolates this from daemon publishes.
    const staker = epsCreditsInTx(s, receipt!, STAKER_SHARD_ID);
    expect(staker.total, 'Σ staker-shard credits in createAccount == committedTRAC').toBe(committed);
    expect(staker.ranges.length, 'createAccount forward-spreads the schedule').toBeGreaterThan(0);
    for (const r of staker.ranges) {
      expect(r.start, `emission must be forward of the creation epoch ${currentEpoch}`).toBeGreaterThan(currentEpoch);
    }
    // Treasury shard receives nothing while the treasury is unset.
    const treasury = epsCreditsInTx(s, receipt!, TREASURY_SHARD_ID);
    expect(treasury.total, 'treasury shard stays empty (treasury unset)').toBe(0n);

    // Marker set: the schedule is written in one shot.
    const acct = await s.nft.accounts(accountId);
    expect(acct.lastSettledWindow as bigint).toBe(TEST_LOCK);
    expect(acct.fullySwept as boolean).toBe(false);
  }, 120_000);

  it('step 3: coverPublishingCost draws the window budget but emits NOTHING to the pool (budget gate)', async () => {
    const s = state.s!;
    const admin = state.admin!;
    const accountId = state.accountId;
    expect(accountId).toBeGreaterThan(0n);

    // Register a fresh agent EOA on the PCA.
    const agent = ethers.Wallet.createRandom();
    state.agent = agent.address;
    const nftRw = s.nft.connect(admin) as ethers.Contract;
    await (await nftRw.registerAgent(accountId, agent.address, {
      nonce: await rawTxNonce(s.provider, admin.address),
    })).wait();

    const window0Before: bigint = await s.nft.windowSpent(accountId, 0n);

    // Drive coverPublishingCost against the DEPLOYED logic by impersonating the
    // NFT wrapper (its onlyConvictionNFT gate) — this exercises the 10.0.8
    // budget-gate on the real deployed contract without depending on the
    // multi-step KA-lifecycle publish flow. baseCost sits well within the
    // window budget; kaStartEpoch is deliberately off (10.0.8 ignores it).
    const currentEpoch: bigint = await s.chronos.getCurrentEpoch();
    const nftAddr = await s.nft.getAddress();
    await s.provider.send('hardhat_impersonateAccount', [nftAddr]);
    await s.provider.send('hardhat_setBalance', [nftAddr, '0x' + ethers.parseEther('10').toString(16)]);
    // Send via raw eth_sendTransaction (hardhat accepts `from` = an impersonated
    // account; ethers' getSigner would reject an address not in eth_accounts).
    const baseCost = ethers.parseEther('100');
    const data = s.logic.interface.encodeFunctionData('coverPublishingCost', [
      agent.address, baseCost, currentEpoch + 5n, TEST_LOCK,
    ]);
    const sentHash: string = await s.provider.send('eth_sendTransaction', [
      { from: nftAddr, to: s.logicAddress, data, gas: '0x2DC6C0' },
    ]);
    await s.provider.send('hardhat_stopImpersonatingAccount', [nftAddr]);
    const receipt = await s.provider.waitForTransaction(sentHash);
    expect(receipt, 'coverPublishingCost tx receipt').not.toBeNull();

    // CostCovered: a base-budget draw, no topUp overflow.
    let cost: ethers.LogDescription | null = null;
    for (const log of receipt!.logs) {
      try {
        const parsed = s.logic.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === 'CostCovered' && (parsed.args.accountId as bigint) === accountId) cost = parsed;
      } catch { /* not a Logic event */ }
    }
    expect(cost, 'coverPublishingCost must emit CostCovered on this PCA').not.toBeNull();
    expect(cost!.args.drawnFromEpoch as bigint, 'base budget drawn').toBeGreaterThan(0n);
    expect(cost!.args.drawnFromTopUp as bigint, 'no topUp overflow for a within-budget spend').toBe(0n);

    // THE 10.0.8 INVARIANT: the base draw emits NOTHING further to the pool —
    // that TRAC was already scheduled at createAccount. `windowSpent` is a pure
    // budget gate now. So the spend tx adds ZERO staker-shard credits.
    const staker = epsCreditsInTx(s, receipt!, STAKER_SHARD_ID);
    expect(staker.total, 'a within-budget spend must NOT re-emit to the staker pool (no double emission)').toBe(0n);

    // Budget gate advanced by exactly the discounted cost.
    const window0After: bigint = await s.nft.windowSpent(accountId, 0n);
    expect(window0After - window0Before).toBe(cost!.args.discountedCost as bigint);
  }, 120_000);

  it('step 4: settle() before expiry is a pure no-op (the schedule is already written)', async () => {
    const s = state.s!;
    const admin = state.admin!;
    const accountId = state.accountId;
    const nftRw = s.nft.connect(admin) as ethers.Contract;

    const receipt = await (await nftRw.settle(accountId, {
      nonce: await rawTxNonce(s.provider, admin.address),
    })).wait();

    // Nothing to sweep: the base budget is scheduled and there is no topUp tail.
    const staker = epsCreditsInTx(s, receipt!, STAKER_SHARD_ID);
    expect(staker.total, 'pre-expiry settle must not move the pool').toBe(0n);
    // Marker unchanged.
    const acct = await s.nft.accounts(accountId);
    expect(acct.lastSettledWindow as bigint).toBe(TEST_LOCK);
    expect(acct.fullySwept as boolean).toBe(false);
  }, 120_000);

  it('step 5: migrateEmissionSchedule back-fills a synthetic pre-10.0.8 account (THE mainnet upgrade path)', async () => {
    // This is the exact operation run on mainnet at upgrade: an account created
    // BEFORE 10.0.8 (lastSettledWindow == 0, with some windowSpent already
    // emitted under the old active sink) gets its remaining schedule
    // (committed − spent, forward-spread) written by the owner-gated batch.
    // The devnet deploys 10.0.8 from the start, so there are no genuine legacy
    // accounts — we PLANT one directly in PublishingConvictionStorage (the Hub
    // owner passes `onlyContracts`), mirroring the hardhat P4/P5b property tests.
    const s = state.s!;
    // Unique per run so a re-run against a persistent devnet chain doesn't
    // collide with a previously-planted account (AccountAlreadyExists).
    const synthId = 900_000_000n + BigInt(await s.provider.getBlockNumber());
    const committed = ethers.parseEther('12000') + 5n; // NOT divisible by lock → dust path live
    const spent0 = ethers.parseEther('111');
    const epLen: bigint = await s.chronos.epochLength();
    const nowBlock = await s.provider.getBlock('latest');
    const nowTs = BigInt(nowBlock!.timestamp);
    const createdAt = nowTs - epLen / 3n; // mid-window-0, mid-epoch → windows close in the FUTURE (no clamp)
    const createdEpoch: bigint = await s.chronos.epochAtTimestamp(createdAt);
    const expiresAt = createdAt + TEST_LOCK * epLen;
    const expiresEpoch: bigint = (await s.chronos.epochAtTimestamp(expiresAt - 1n)) + 1n;

    const pcsRw = s.pcs.connect(s.hubOwner) as ethers.Contract;
    let nonce = await rawTxNonce(s.provider, s.hubOwner.address);
    await (await pcsRw.createAccount(synthId, {
      committedTRAC: committed,
      createdAtEpoch: createdEpoch,
      expiresAtEpoch: expiresEpoch,
      createdAtTimestamp: createdAt,
      expiresAtTimestamp: expiresAt,
      lockDurationEpochs: TEST_LOCK,
      discountBps: 0,
      lastSettledWindow: 0, // ← the pre-10.0.8 marker: schedule NOT yet written
      fullySwept: false,
      primaryNode: 0,
      lastPrimaryNodeChangeEpoch: createdEpoch,
    }, { nonce: nonce++ })).wait();
    // Some window-0 spend "already emitted under the old rules".
    await (await pcsRw.increaseWindowSpent(synthId, 0n, spent0, { nonce: nonce++ })).wait();
    expect(await s.pcs.accountExists(synthId)).toBe(true);

    const currentEpoch: bigint = await s.chronos.getCurrentEpoch();

    // Batch-migrate the legacy account (owner-gated).
    const logicRw = s.logic.connect(s.hubOwner) as ethers.Contract;
    const receipt = await (await logicRw.migrateEmissionSchedule([synthId], {
      nonce: await rawTxNonce(s.provider, s.hubOwner.address),
    })).wait();

    // Migration schedules exactly committed − spent0 (the spent portion was
    // already emitted under 10.0.7, so it is NOT re-emitted — conservation).
    let scheduled: ethers.LogDescription | null = null;
    for (const log of receipt!.logs) {
      try {
        const parsed = s.logic.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === 'EmissionScheduled' && (parsed.args.accountId as bigint) === synthId) scheduled = parsed;
      } catch { /* not a Logic event */ }
    }
    expect(scheduled, 'migration must emit EmissionScheduled for the legacy account').not.toBeNull();
    expect(scheduled!.args.fromWindow as bigint).toBe(0n);
    expect(scheduled!.args.toWindow as bigint).toBe(TEST_LOCK);
    expect(scheduled!.args.treasuryFee as bigint).toBe(0n);
    expect(scheduled!.args.scheduled as bigint, 'schedule == committed − alreadySpent').toBe(committed - spent0);

    // The migrate tx credits the staker shard by exactly committed − spent0,
    // forward of the current epoch (createdAt chosen so no window has elapsed).
    const staker = epsCreditsInTx(s, receipt!, STAKER_SHARD_ID);
    expect(staker.total, 'Σ staker-shard credits from migration == committed − spent0').toBe(committed - spent0);
    for (const r of staker.ranges) {
      // Never retroactively credits an already-elapsed epoch. For a
      // freshly-created legacy account no window has closed, so emission lands
      // at or after the current epoch (a window closing right at the boundary
      // legitimately anchors AT the current epoch).
      expect(r.start, 'migration never credits an epoch before the current one').toBeGreaterThanOrEqual(currentEpoch);
    }
    expect(epsCreditsInTx(s, receipt!, TREASURY_SHARD_ID).total, 'treasury shard empty').toBe(0n);

    // Marker advanced → the account is now fully scheduled.
    const acct = await s.pcs.getAccount(synthId);
    expect(acct.lastSettledWindow as bigint).toBe(TEST_LOCK);

    // Idempotent: a second migrate of the SAME legacy account is a pure no-op.
    const again = await (await logicRw.migrateEmissionSchedule([synthId], {
      nonce: await rawTxNonce(s.provider, s.hubOwner.address),
    })).wait();
    expect(epsCreditsInTx(s, again!, STAKER_SHARD_ID).total, 're-migrating must not double-credit').toBe(0n);
  }, 180_000);

  it('step 6: migrateEmissionSchedule on a 10.0.8-created account is idempotent (marker skips it)', async () => {
    const s = state.s!;
    const accountId = state.accountId;
    const logicRw = s.logic.connect(s.hubOwner) as ethers.Contract;

    const receipt = await (await logicRw.migrateEmissionSchedule([accountId], {
      nonce: await rawTxNonce(s.provider, s.hubOwner.address),
    })).wait();

    // Already scheduled at createAccount ⇒ _scheduleRemaining returns early:
    // no EmissionScheduled re-fire, no EpochStorage credit.
    let reScheduled = false;
    for (const log of receipt!.logs) {
      try {
        const parsed = s.logic.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === 'EmissionScheduled' && (parsed.args.accountId as bigint) === accountId) reScheduled = true;
      } catch { /* not a Logic event */ }
    }
    expect(reScheduled, 'migrating an already-scheduled account must not re-emit EmissionScheduled').toBe(false);
    const staker = epsCreditsInTx(s, receipt!, STAKER_SHARD_ID);
    expect(staker.total, 'idempotent migration must not double-credit the pool').toBe(0n);
  }, 120_000);
});
