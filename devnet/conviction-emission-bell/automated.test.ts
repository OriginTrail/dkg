/**
 * V10 PCA emission (bell) — devnet validation (OT-RFC-27, PublishingConviction 10.2.0).
 *
 * Since 10.2.0 a Conviction Account pays at use time, as a wallet does: a
 * publish books its draw when it is made, and each billing window's unused
 * budget is booked once the window has closed, spread over the
 * `lockDurationEpochs` epoch-lengths after its close. That per-window spread is
 * the 10.0.8 schedule's own math, so an account whose windows are settled on
 * time still emits the 10.0.8 bell, window by window. This suite asserts that
 * against a live 6-node devnet, using PER-TX EpochStorage events (not shared
 * getEpochPool deltas) so unrelated daemon publishes in the same epoch range
 * can neither mask a regression nor cause a flake.
 *
 *   step 2  createAccount books NOTHING to the pool: no `EmissionScheduled`,
 *           no EpochStorage credit in the tx, and the booking cursor
 *           (`lastSettledWindow`) starts at window 0.
 *   step 3  A publish — `coverPublishingCost`, driven against the DEPLOYED
 *           logic by impersonating the NFT wrapper's onlyConvictionNFT gate —
 *           draws the window budget and books its whole discounted draw to the
 *           staker shard over the Knowledge Asset's epochs from the current
 *           epoch, exactly as a wallet publish spreads its payment.
 *   step 4  `settle()` before the first window closes books nothing.
 *   step 5  THE BELL: as each window closes, a `settle()` in the same epoch
 *           books B − spent (the `committed mod lock` dust with the last
 *           window) over the lock's epoch-lengths after that window's close —
 *           range for range the 10.0.8 bell's own credits for that window. The
 *           last window closes at expiry, where the same settle is the final
 *           sweep. Publish + windows == committedTRAC.
 *   step 6  THE MAINNET PATH for accounts created before 10.0.8 (it replaces
 *           the retired `migrateEmissionSchedule`): synthetic legacy accounts
 *           (planted in PublishingConvictionStorage with lastSettledWindow==0
 *           and a prior windowSpent) are booked by the permissionless batch
 *           `settleMany([...])` in exactly the same way, window by window;
 *           an unknown id reverts the batch; a repeat is a no-op.
 *   step 7  An account as 10.0.8 left it (its whole schedule written up front,
 *           `lastSettledWindow == lockDurationEpochs` while live) is left
 *           untouched by `settle()` and `settleMany()`.
 *
 * Coverage: steps 2-5 exercise REGULAR activity on a fresh account through its
 * whole lock; step 6 the booking of LEGACY accounts (the mainnet keeper path);
 * step 7 the accounts 10.0.8 scheduled.
 *
 * Windows close by moving the Hardhat clock (`evm_setNextBlockTimestamp`), as
 * the retired conviction-lazy-settle suite did: each window is settled seconds
 * after its close, in the epoch it closes in, so nothing is clamped and the
 * credits are exactly the bell's.
 *
 * All assertions run against the LIVE devnet-deployed contracts (real Hub, NFT
 * wrapper, PublishingConviction logic, EpochStorage) — validating the actual
 * deployed 10.2.0 bytecode, not a fresh unit-test deploy. The suite is
 * chain-driven (no node-daemon dependency): step 3 exercises the publish-cost
 * path by impersonating the NFT rather than driving the multi-step KA-lifecycle
 * publish flow, which keeps it robust. (An end-to-end node-publish variant is a
 * possible future addition once the KA-lifecycle CLI harness is updated — the
 * same update conviction-lazy-settle needed.)
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
  // Logic contract, not the NFT wrapper — events + the batch settle live
  // here. Signatures MUST mirror PublishingConviction.sol (10.2.0); a drift
  // silently turns a parseLog into a miss and the assertions pass vacuously.
  const logicAddress = c('PublishingConviction');
  const logic = new ethers.Contract(
    logicAddress,
    [
      'event AccountCreated(uint256 indexed accountId, address indexed owner, uint96 committedTRAC, uint16 discountBps, uint40 createdAtEpoch, uint40 expiresAtEpoch)',
      'event CostCovered(uint256 indexed accountId, uint40 indexed epoch, uint96 baseCost, uint96 discountedCost, uint96 drawnFromEpoch, uint96 drawnFromTopUp)',
      // 10.2.0: fires for each booking of closed windows `fromWindow`..`toWindow-1`.
      // `scheduled` = staker-shard total, `treasuryFee` = treasury-shard total
      // (0 while the protocol treasury is unset — the devnet default).
      'event EmissionScheduled(uint256 indexed accountId, uint40 fromWindow, uint40 toWindow, uint96 scheduled, uint96 treasuryFee)',
      'event AccountFinalSwept(uint256 indexed accountId, uint96 topUpSwept, uint96 dustSwept)',
      'event AgentRegistered(uint256 indexed accountId, address indexed agent)',
      'error UnknownAccount(uint256 accountId)',
      // The permissionless batch settle — the keeper path that books the
      // closed windows of many accounts in one transaction.
      'function settleMany(uint256[] accountIds) external',
      // Driven directly (via the onlyConvictionNFT gate, by impersonating the
      // NFT) in step 3 to exercise the deployed publish booking.
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
  // Application-state store — used to PLANT synthetic accounts (steps 6 and
  // 7). `onlyContracts` admits the Hub owner, so the deployer EOA can write a
  // legacy-shaped or 10.0.8-shaped account directly, exactly as the hardhat
  // property tests do.
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

type Range = { start: bigint; end: bigint; amount: bigint };

// Sum the `tokenAmount` of every TokensAddedToEpochRange(shardId) emitted in a
// specific tx, and collect the (startEpoch,endEpoch) ranges. Per-tx scoping
// makes this immune to unrelated daemon publishes in the same block/epoch.
function epsCreditsInTx(
  s: Contracts,
  receipt: ethers.TransactionReceipt,
  shardId: bigint,
): { total: bigint; ranges: Range[] } {
  const epsAddr = s.epsAddress.toLowerCase();
  let total = 0n;
  const ranges: Range[] = [];
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

// The Logic-contract events `name` a tx emitted, for `accountId` when given.
function logicEventsInTx(
  s: Contracts,
  receipt: ethers.TransactionReceipt,
  name: string,
  accountId?: bigint,
): ethers.LogDescription[] {
  const logicAddr = s.logicAddress.toLowerCase();
  const out: ethers.LogDescription[] = [];
  for (const log of receipt.logs) {
    if ((log.address ?? '').toLowerCase() !== logicAddr) continue;
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = s.logic.interface.parseLog({ topics: log.topics as string[], data: log.data });
    } catch { continue; }
    if (parsed?.name !== name) continue;
    if (accountId !== undefined && (parsed.args.accountId as bigint) !== accountId) continue;
    out.push(parsed);
  }
  return out;
}

// Byte-exact mirror of PublishingMathLib.prorateActiveSink: a partial first
// epoch, the full middle epochs, and a dust-corrected final epoch. Zero-amount
// ranges are not credited, so they are left out.
function prorateActiveSink(
  amount: bigint,
  anchorEpoch: bigint,
  epochs: bigint,
  epochLength: bigint,
  timeRemaining: bigint,
): Range[] {
  const base = amount / epochs;
  const cur = (base * timeRemaining) / epochLength;
  let fin = base - cur;
  const fulls = epochs - 1n;
  const totFull = base * fulls;
  const allocated = cur + totFull + fin;
  if (allocated < amount) fin += amount - allocated;
  const out: Range[] = [];
  if (cur > 0n) out.push({ start: anchorEpoch, end: anchorEpoch, amount: cur });
  if (fulls > 0n && totFull > 0n) out.push({ start: anchorEpoch + 1n, end: anchorEpoch + fulls, amount: totFull });
  if (fin > 0n) out.push({ start: anchorEpoch + epochs, end: anchorEpoch + epochs, amount: fin });
  return out;
}

// THE BELL, one window at a time: the credits the 10.0.8 schedule wrote for
// billing window `w` of an account created at `createdAt` — `amount` spread
// over `lock` epoch-lengths from the window's close, anchored on stored fields.
async function windowBell(
  s: Contracts,
  createdAt: bigint,
  w: bigint,
  amount: bigint,
  lock: bigint,
): Promise<{ close: bigint; anchor: bigint; ranges: Range[] }> {
  const epochLength: bigint = await s.chronos.epochLength();
  const close = createdAt + (w + 1n) * epochLength;
  const anchor: bigint = await s.chronos.epochAtTimestamp(close);
  const nextBoundary: bigint = await s.chronos.timestampForEpoch(anchor + 1n);
  const timeRemaining = nextBoundary > close ? nextBoundary - close : 0n;
  return { close, anchor, ranges: prorateActiveSink(amount, anchor, lock, epochLength, timeRemaining) };
}

// Move the Hardhat clock to `ts` (if it is not there yet) and mine a block at
// it. `evm_setNextBlockTimestamp` (not `evm_increaseTime`) so the destination
// is exact; the 1s interval miner picks up from there.
async function advanceTo(s: Contracts, ts: bigint): Promise<void> {
  const latest = await s.provider.getBlock('latest');
  if (BigInt(latest!.timestamp) >= ts) return;
  await s.provider.send('evm_setNextBlockTimestamp', [Number(ts)]);
  await s.provider.send('evm_mine', []);
}

async function epochOfReceipt(s: Contracts, receipt: ethers.TransactionReceipt): Promise<bigint> {
  const block = await s.provider.getBlock(receipt.blockNumber);
  return s.chronos.epochAtTimestamp(BigInt(block!.timestamp));
}

// Plant an account record directly in PublishingConvictionStorage (the Hub
// owner passes `onlyContracts`), created at `createdAt`, with `spent0` drawn
// from window 0 and its booking cursor at `lastSettledWindow`.
async function plantAccount(
  s: Contracts,
  opts: { id: bigint; committed: bigint; createdAt: bigint; spent0: bigint; lastSettledWindow: bigint },
): Promise<void> {
  const epochLength: bigint = await s.chronos.epochLength();
  const createdEpoch: bigint = await s.chronos.epochAtTimestamp(opts.createdAt);
  const expiresAt = opts.createdAt + TEST_LOCK * epochLength;
  const expiresEpoch: bigint = (await s.chronos.epochAtTimestamp(expiresAt - 1n)) + 1n;
  const pcsRw = s.pcs.connect(s.hubOwner) as ethers.Contract;
  let nonce = await rawTxNonce(s.provider, s.hubOwner.address);
  await (await pcsRw.createAccount(opts.id, {
    committedTRAC: opts.committed,
    createdAtEpoch: createdEpoch,
    expiresAtEpoch: expiresEpoch,
    createdAtTimestamp: opts.createdAt,
    expiresAtTimestamp: expiresAt,
    lockDurationEpochs: TEST_LOCK,
    discountBps: 0,
    lastSettledWindow: opts.lastSettledWindow,
    fullySwept: false,
    primaryNode: 0,
    lastPrimaryNodeChangeEpoch: createdEpoch,
  }, { nonce: nonce++ })).wait();
  if (opts.spent0 > 0n) {
    await (await pcsRw.increaseWindowSpent(opts.id, 0n, opts.spent0, { nonce })).wait();
  }
  expect(await s.pcs.accountExists(opts.id)).toBe(true);
}

const state: {
  s: Contracts | null;
  admin: ethers.HDNodeWallet | null;
  accountId: bigint;
  committed: bigint;
  createdAt: bigint;
  published: bigint;
  agent: string | null;
  originalPublishingConvictionEpochs: bigint;
} = {
  s: null,
  admin: null,
  accountId: 0n,
  committed: 0n,
  createdAt: 0n,
  published: 0n,
  agent: null,
  originalPublishingConvictionEpochs: 0n,
};

describe('V10 PCA emission (bell) — devnet validation', () => {
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

  it('step 2: createAccount books NOTHING to the pool — the account pays at use time', async () => {
    const s = state.s!;
    // Tier above 500k → 50% discount; + 2 wei so the `committed mod lock` dust
    // is live (it rides the last window, step 5).
    const committed = ethers.parseEther('600000') + 2n;
    state.committed = committed;
    const admin = await ensureAdminWallet(s, committed);
    state.admin = admin;

    const nftAddr = await s.nft.getAddress();
    const tokenRw = s.token.connect(admin) as ethers.Contract;
    const nftRw = s.nft.connect(admin) as ethers.Contract;

    const cssBalBefore: bigint = await s.token.balanceOf(s.cssAddress);

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
    const [created] = logicEventsInTx(s, receipt!, 'AccountCreated');
    expect(created, 'createAccount must emit AccountCreated').toBeDefined();
    const accountId = created.args.accountId as bigint;
    expect(accountId).toBeGreaterThan(0n);
    state.accountId = accountId;

    // Escrow moved (committed TRAC into the CSS vault).
    expect((await s.token.balanceOf(s.cssAddress)) - cssBalBefore).toBe(committed);

    // 10.2.0 INVARIANT — nothing is booked at creation: no EmissionScheduled,
    // and the tx credits neither shard.
    expect(logicEventsInTx(s, receipt!, 'EmissionScheduled', accountId), 'createAccount must not book').toHaveLength(0);
    expect(epsCreditsInTx(s, receipt!, STAKER_SHARD_ID).total, 'no staker-shard credit at creation').toBe(0n);
    expect(epsCreditsInTx(s, receipt!, TREASURY_SHARD_ID).total, 'no treasury-shard credit at creation').toBe(0n);

    // The booking cursor starts at window 0: a use-time account.
    const acct = await s.nft.accounts(accountId);
    expect(acct.lastSettledWindow as bigint).toBe(0n);
    expect(acct.fullySwept as boolean).toBe(false);
    expect(acct.lockDurationEpochs as bigint).toBe(TEST_LOCK);
    state.createdAt = acct.createdAtTimestamp as bigint;
  }, 120_000);

  it('step 3: a publish books its whole discounted draw over the Knowledge Asset epochs', async () => {
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
    // NFT wrapper (its onlyConvictionNFT gate) — this exercises the 10.2.0
    // publish booking on the real deployed contract without depending on the
    // multi-step KA-lifecycle publish flow. baseCost sits well within the
    // window budget; kaStartEpoch is deliberately off (the booking anchors at
    // the current epoch and ignores it).
    const currentEpoch: bigint = await s.chronos.getCurrentEpoch();
    const nftAddr = await s.nft.getAddress();
    await s.provider.send('hardhat_impersonateAccount', [nftAddr]);
    await s.provider.send('hardhat_setBalance', [nftAddr, '0x' + ethers.parseEther('10').toString(16)]);
    // Send via raw eth_sendTransaction (hardhat accepts `from` = an impersonated
    // account; ethers' getSigner would reject an address not in eth_accounts).
    const baseCost = ethers.parseEther('100');
    const kaEpochs = TEST_LOCK;
    const data = s.logic.interface.encodeFunctionData('coverPublishingCost', [
      agent.address, baseCost, currentEpoch + 5n, kaEpochs,
    ]);
    const sentHash: string = await s.provider.send('eth_sendTransaction', [
      { from: nftAddr, to: s.logicAddress, data, gas: '0x2DC6C0' },
    ]);
    await s.provider.send('hardhat_stopImpersonatingAccount', [nftAddr]);
    const receipt = await s.provider.waitForTransaction(sentHash);
    expect(receipt, 'coverPublishingCost tx receipt').not.toBeNull();

    // CostCovered: a base-budget draw, no topUp overflow.
    const [cost] = logicEventsInTx(s, receipt!, 'CostCovered', accountId);
    expect(cost, 'coverPublishingCost must emit CostCovered on this PCA').toBeDefined();
    const discounted = cost.args.discountedCost as bigint;
    expect(cost.args.drawnFromEpoch as bigint, 'base budget drawn').toBe(discounted);
    expect(cost.args.drawnFromTopUp as bigint, 'no topUp overflow for a within-budget spend').toBe(0n);
    state.published = discounted;

    // THE 10.2.0 INVARIANT: the draw is booked to the staker shard when it is
    // made, over the KA's epochs from the tx's epoch, with the time left in
    // that epoch — prorateActiveSink, as a wallet publish spreads its payment.
    const block = await s.provider.getBlock(receipt!.blockNumber);
    const txTs = BigInt(block!.timestamp);
    const txEpoch: bigint = await s.chronos.epochAtTimestamp(txTs);
    const epochLength: bigint = await s.chronos.epochLength();
    const timeLeft = (await s.chronos.timestampForEpoch(txEpoch + 1n)) - txTs;
    const staker = epsCreditsInTx(s, receipt!, STAKER_SHARD_ID);
    expect(staker.total, 'the publish books its whole discounted draw').toBe(discounted);
    expect(staker.ranges, 'the KA-epoch spread of a wallet publish').toEqual(
      prorateActiveSink(discounted, txEpoch, kaEpochs, epochLength, timeLeft),
    );
    // A publish books no window.
    expect(logicEventsInTx(s, receipt!, 'EmissionScheduled', accountId)).toHaveLength(0);

    // The window budget advanced by exactly the discounted cost.
    const window0After: bigint = await s.nft.windowSpent(accountId, 0n);
    expect(window0After - window0Before).toBe(discounted);
  }, 120_000);

  it('step 4: settle() before the first window closes books nothing', async () => {
    const s = state.s!;
    const admin = state.admin!;
    const accountId = state.accountId;
    const nftRw = s.nft.connect(admin) as ethers.Contract;
    expect(BigInt(await s.nft.getCurrentBillingWindow(accountId))).toBe(0n);

    const receipt = await (await nftRw.settle(accountId, {
      nonce: await rawTxNonce(s.provider, admin.address),
    })).wait();

    // No window has closed: nothing to book, and no topUp tail before expiry.
    expect(logicEventsInTx(s, receipt!, 'EmissionScheduled', accountId)).toHaveLength(0);
    expect(epsCreditsInTx(s, receipt!, STAKER_SHARD_ID).total, 'settle before a close must not move the pool').toBe(0n);
    const acct = await s.nft.accounts(accountId);
    expect(acct.lastSettledWindow as bigint).toBe(0n);
    expect(acct.fullySwept as boolean).toBe(false);
  }, 120_000);

  it('step 5: THE BELL — each window, settled on time once it closes, books B − spent as the 10.0.8 bell did', async () => {
    const s = state.s!;
    const accountId = state.accountId;
    const committed = state.committed;
    const createdAt = state.createdAt;
    expect(createdAt).toBeGreaterThan(0n);
    const nftRw = s.nft.connect(s.hubOwner) as ethers.Contract; // anyone may settle

    const B = committed / TEST_LOCK;
    const dust = committed - B * TEST_LOCK;
    let booked = 0n;

    for (let w = 0n; w < TEST_LOCK; w++) {
      const spent: bigint = await s.nft.windowSpent(accountId, w);
      const remainder = (spent < B ? B - spent : 0n) + (w === TEST_LOCK - 1n ? dust : 0n);
      const bell = await windowBell(s, createdAt, w, remainder, TEST_LOCK);

      // The window closes; settle it in the epoch it closes in (on time).
      await advanceTo(s, bell.close);
      const receipt = await (await nftRw.settle(accountId, {
        nonce: await rawTxNonce(s.provider, s.hubOwner.address),
      })).wait();
      expect(await epochOfReceipt(s, receipt!), `window ${w} settled in the epoch it closes in`).toBe(bell.anchor);

      const [ev] = logicEventsInTx(s, receipt!, 'EmissionScheduled', accountId);
      expect(ev, `window ${w} must be booked`).toBeDefined();
      expect(ev.args.fromWindow as bigint).toBe(w);
      expect(ev.args.toWindow as bigint).toBe(w + 1n);
      expect(ev.args.scheduled as bigint, `window ${w}: B − spent`).toBe(remainder);
      expect(ev.args.treasuryFee as bigint, 'no treasury fee (treasury unset)').toBe(0n);

      // Range for range, the 10.0.8 bell's credits for this window — the
      // window's own epoch first, then the full epochs, then the final one.
      const staker = epsCreditsInTx(s, receipt!, STAKER_SHARD_ID);
      expect(staker.ranges, `window ${w}: the bell's own ranges`).toEqual(bell.ranges);
      expect(staker.total).toBe(remainder);
      expect(epsCreditsInTx(s, receipt!, TREASURY_SHARD_ID).total).toBe(0n);
      for (const r of staker.ranges) expect(r.start, 'never before the window closes').toBeGreaterThanOrEqual(bell.anchor);
      booked += staker.total;

      if (w === TEST_LOCK - 1n) {
        // The last window closes at expiry: the same settle is the final
        // sweep, with no topUp tail to sweep.
        const [swept] = logicEventsInTx(s, receipt!, 'AccountFinalSwept', accountId);
        expect(swept, 'the expiry settle is the final sweep').toBeDefined();
        expect(swept.args.topUpSwept as bigint).toBe(0n);
      } else {
        expect((await s.nft.accounts(accountId)).lastSettledWindow as bigint, 'cursor below the lock while live').toBe(w + 1n);
      }
    }

    // Every wei of the commitment is booked once: the publish at use time,
    // the rest window by window.
    expect(state.published + booked, 'publish + windows == committedTRAC').toBe(committed);
    const acct = await s.nft.accounts(accountId);
    expect(acct.lastSettledWindow as bigint).toBe(TEST_LOCK);
    expect(acct.fullySwept as boolean).toBe(true);
  }, 300_000);

  it('step 6: settleMany([...]) books synthetic pre-10.0.8 accounts the same way (THE mainnet path)', async () => {
    // An account created BEFORE 10.0.8 has lastSettledWindow == 0 and some
    // windowSpent already booked under the old active sink. Since 10.2.0 it
    // pays at use time: its closed windows are booked as any account's are,
    // by any touch or by the permissionless batch — the keeper operation that
    // replaces the retired `migrateEmissionSchedule`. The devnet deploys the
    // current build from the start, so there are no genuine legacy accounts —
    // we PLANT them directly in PublishingConvictionStorage, mirroring the
    // hardhat property tests.
    const s = state.s!;
    const epochLength: bigint = await s.chronos.epochLength();
    // Unique per run so a re-run against a persistent devnet chain doesn't
    // collide with a previously-planted account (AccountAlreadyExists).
    const base = 900_000_000n + BigInt(await s.provider.getBlockNumber()) * 10n;
    const legacy = [
      { id: base, committed: ethers.parseEther('12000') + 5n, spent0: ethers.parseEther('111') },
      { id: base + 1n, committed: ethers.parseEther('30000') + 1n, spent0: 0n },
    ];
    // Window 0 of both closes a minute from now, so the batch books it on time.
    const nowTs = BigInt((await s.provider.getBlock('latest'))!.timestamp);
    const createdAt = nowTs + 60n - epochLength;
    for (const a of legacy) {
      await plantAccount(s, { id: a.id, committed: a.committed, createdAt, spent0: a.spent0, lastSettledWindow: 0n });
    }
    const bells = [];
    for (const a of legacy) {
      const B = a.committed / TEST_LOCK;
      bells.push({ ...a, remainder: B - a.spent0, ...(await windowBell(s, createdAt, 0n, B - a.spent0, TEST_LOCK)) });
    }

    // An id no account has reverts the whole batch, loudly.
    const keeper = s.logic.connect(state.admin ?? s.hubOwner) as ethers.Contract;
    const unknown = base + 9n;
    let refused: unknown = null;
    try {
      await keeper.settleMany.staticCall([legacy[0].id, unknown]);
    } catch (e) {
      refused = e;
    }
    expect(refused, 'settleMany with an unknown id must revert').not.toBeNull();
    expect((refused as { revert?: { name?: string } }).revert?.name).toBe('UnknownAccount');

    // The window closes; one batch books both accounts, on time.
    await advanceTo(s, bells[0].close);
    const receipt = await (await keeper.settleMany(legacy.map((a) => a.id), {
      nonce: await rawTxNonce(s.provider, (state.admin ?? s.hubOwner).address),
    })).wait();
    expect(await epochOfReceipt(s, receipt!), 'booked in the epoch window 0 closes in').toBe(bells[0].anchor);

    const expectedRanges: Range[] = [];
    for (const b of bells) {
      const [ev] = logicEventsInTx(s, receipt!, 'EmissionScheduled', b.id);
      expect(ev, `legacy account ${b.id} must be booked`).toBeDefined();
      expect(ev.args.fromWindow as bigint).toBe(0n);
      expect(ev.args.toWindow as bigint).toBe(1n);
      // B − alreadySpent: the spent portion was booked under the older build.
      expect(ev.args.scheduled as bigint, 'B − spent').toBe(b.remainder);
      expect(ev.args.treasuryFee as bigint).toBe(0n);
      expectedRanges.push(...b.ranges);
      // The cursor stops at the current window: the account pays at use time.
      expect((await s.pcs.getAccount(b.id)).lastSettledWindow as bigint).toBe(1n);
    }
    // In batch order, each account's window 0 is the bell's own window 0.
    expect(epsCreditsInTx(s, receipt!, STAKER_SHARD_ID).ranges).toEqual(expectedRanges);
    expect(epsCreditsInTx(s, receipt!, TREASURY_SHARD_ID).total, 'treasury shard empty').toBe(0n);

    // A repeat within the window is a pure no-op.
    const again = await (await keeper.settleMany(legacy.map((a) => a.id), {
      nonce: await rawTxNonce(s.provider, (state.admin ?? s.hubOwner).address),
    })).wait();
    expect(epsCreditsInTx(s, again!, STAKER_SHARD_ID).total, 're-settling must not double-credit').toBe(0n);
    expect(logicEventsInTx(s, again!, 'EmissionScheduled')).toHaveLength(0);
  }, 180_000);

  it('step 7: an account as 10.0.8 left it (scheduled up front) is left untouched by settle() and settleMany()', async () => {
    // 10.0.8 wrote an account's whole schedule at creation and left its
    // cursor at the lock. The schedule itself is already in EpochStorage; we
    // plant only the record, which is all settle reads — live, with a window
    // already closed.
    const s = state.s!;
    const epochLength: bigint = await s.chronos.epochLength();
    const id = 910_000_000n + BigInt(await s.provider.getBlockNumber()) * 10n;
    const nowTs = BigInt((await s.provider.getBlock('latest'))!.timestamp);
    await plantAccount(s, {
      id,
      committed: ethers.parseEther('20000'),
      createdAt: nowTs - epochLength - epochLength / 2n,
      spent0: 0n,
      lastSettledWindow: TEST_LOCK,
    });
    const before = await s.pcs.getAccount(id);
    expect(BigInt(nowTs) < (before.expiresAtTimestamp as bigint), 'the account is live').toBe(true);

    const nftRw = s.nft.connect(s.hubOwner) as ethers.Contract;
    const single = await (await nftRw.settle(id, {
      nonce: await rawTxNonce(s.provider, s.hubOwner.address),
    })).wait();
    const keeper = s.logic.connect(s.hubOwner) as ethers.Contract;
    const batch = await (await keeper.settleMany([id], {
      nonce: await rawTxNonce(s.provider, s.hubOwner.address),
    })).wait();

    for (const receipt of [single!, batch!]) {
      expect(logicEventsInTx(s, receipt, 'EmissionScheduled', id), 'a scheduled account books nothing').toHaveLength(0);
      expect(epsCreditsInTx(s, receipt, STAKER_SHARD_ID).total, 'no double emission').toBe(0n);
    }
    const after = await s.pcs.getAccount(id);
    expect(after.lastSettledWindow as bigint).toBe(TEST_LOCK);
    expect(after.fullySwept as boolean).toBe(false);
  }, 120_000);
});
