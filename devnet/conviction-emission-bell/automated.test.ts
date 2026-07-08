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
 *   step 3  A within-budget publish through a registered agent draws the
 *           per-window budget (`windowSpent` grows; `CostCovered` shows a
 *           base draw, no topUp) but emits NOTHING further to the pool — the
 *           base TRAC is already scheduled, so there is no double emission.
 *   step 4  `settle()` before expiry is a pure no-op.
 *   step 5  `migrateEmissionSchedule([id])` on a 10.0.8-created account is
 *           idempotent (the `lastSettledWindow == lock` marker skips it).
 *
 * Preconditions:
 *   ./scripts/devnet.sh clean
 *   ./scripts/devnet.sh start 6
 *   # ideally run AFTER the v10-end-to-end suite so the daemons are settled.
 *
 * Why a fresh nft-admin EOA + a core node's op-wallet as agent? Same reasons
 * as conviction-lazy-settle: a fresh PCA keeps `windowSpent[acct][0] == 0`,
 * and a CORE node (not an edge) gives an on-chain-confirmed publish so the
 * budget-gate assertion sees a real coverPublishingCost tx.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ethers } from 'ethers';

const REPO_ROOT = resolve(__dirname, '../..');
const RPC = 'http://127.0.0.1:8545';
const DEVNET_DIR = join(REPO_ROOT, '.devnet');
const CONTEXT_GRAPH = 'devnet-test';
const HARDHAT_DEPLOYER_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// Mirrors `PublishingConviction.STAKER_SHARD_ID` / `TREASURY_SHARD_ID`.
const STAKER_SHARD_ID = 1n;
const TREASURY_SHARD_ID = 2n;
// Shrunken lock so a full lifecycle fits in test time (same rationale as
// conviction-lazy-settle step 1).
const TEST_LOCK = 3n;

interface DevnetNode {
  num: number;
  apiPort: number;
  home: string;
  authToken: string;
  opWallets: Array<{ privateKey: string; address: string }>;
}

interface Contracts {
  provider: ethers.JsonRpcProvider;
  nft: ethers.Contract;
  logic: ethers.Contract;
  logicAddress: string;
  token: ethers.Contract;
  chronos: ethers.Contract;
  eps: ethers.Contract;
  epsAddress: string;
  parameters: ethers.Contract;
  paramsRw: ethers.Contract;
  cssAddress: string;
  hubOwner: ethers.Wallet;
}

function readNode(num: number): DevnetNode {
  const home = join(DEVNET_DIR, `node${num}`);
  if (!existsSync(home)) {
    throw new Error(`devnet node${num} home missing — run ./scripts/devnet.sh start 6 first`);
  }
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  const wallets = JSON.parse(readFileSync(join(home, 'wallets.json'), 'utf8'));
  const opWallets: Array<{ privateKey: string; address: string }> = wallets.wallets ?? [];
  if (opWallets.length === 0) {
    throw new Error(`devnet node${num} has no operational wallets`);
  }
  return { num, apiPort: config.apiPort, home, authToken: '', opWallets };
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

const NQUADS_TMP_DIR = mkdtempSync(join(tmpdir(), 'dkg-emission-bell-'));

function nquadsFile(name: string): string {
  const p = join(NQUADS_TMP_DIR, `${name}.nq`);
  const ts = Date.now();
  writeFileSync(
    p,
    `<urn:test:${name}:${ts}> <https://schema.org/name> "${name}-${ts}" .\n`,
  );
  return p;
}

async function dkgPublish(node: DevnetNode, file: string): Promise<{ kaId: bigint; txHash: string }> {
  return new Promise((res, rej) => {
    const child = spawn(
      process.execPath,
      [join(REPO_ROOT, 'packages/cli/dist/cli.js'), 'publish', CONTEXT_GRAPH, '--file', file],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DKG_NO_BLUE_GREEN: '1',
          DKG_HOME: node.home,
          DKG_API_PORT: String(node.apiPort),
        },
      },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rej(new Error(`dkg publish timeout (90s)\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 90_000);
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rej(new Error(`dkg publish exit=${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
        return;
      }
      const status = /Status:\s*(\w+)/i.exec(stdout)?.[1]?.toLowerCase() ?? 'unknown';
      const kcMatch = /KC ID:\s*(\d+)/i.exec(stdout);
      const txMatch = /TX hash:\s*(0x[0-9a-fA-F]+)/i.exec(stdout);
      if (!kcMatch || !txMatch) {
        rej(new Error(`could not parse publish output\n${stdout}`));
        return;
      }
      const publishOk = ['confirmed', 'finalized', 'tentative'];
      if (!publishOk.includes(status)) {
        rej(new Error(`dkg publish status="${status}", expected one of ${publishOk.join('/')}\n${stdout}`));
        return;
      }
      const kaId = BigInt(kcMatch[1]!);
      if (kaId <= 0n) {
        rej(new Error(`dkg publish surfaced non-positive kaId=${kaId}\n${stdout}`));
        return;
      }
      res({ kaId, txHash: txMatch[1]! });
    });
  });
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
  edge: DevnetNode | null;
  admin: ethers.HDNodeWallet | null;
  accountId: bigint;
  committed: bigint;
  originalPublishingConvictionEpochs: bigint;
} = {
  s: null,
  edge: null,
  admin: null,
  accountId: 0n,
  committed: 0n,
  originalPublishingConvictionEpochs: 0n,
};

describe('V10 PCA deterministic emission (bell) — devnet validation', () => {
  beforeAll(async () => {
    state.s = await loadContracts();
    // A CORE node (node 2) has an on-chain identity so `dkg publish` confirms
    // (edge nodes short-circuit to tentative/kaId=0). Node 1 is reserved for RS.
    state.edge = readNode(2);
  }, 60_000);

  afterAll(async () => {
    if (!state.s) return;
    const s = state.s;
    // Deregister any agent we bound so later suites don't route through this PCA.
    if (state.edge && state.accountId > 0n) {
      const admin = state.admin ?? s.hubOwner;
      const nftRw = s.nft.connect(admin) as ethers.Contract;
      for (const w of state.edge.opWallets) {
        try {
          const bound: bigint = await s.nft.agentToAccountId(w.address);
          if (bound === state.accountId) {
            await (await nftRw.deregisterAgent(state.accountId, w.address, {
              nonce: await rawTxNonce(s.provider, admin.address),
            })).wait();
          }
        } catch { /* best-effort */ }
      }
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

  it('step 3: a within-budget publish draws windowSpent but emits NOTHING to the pool (budget gate)', async () => {
    const s = state.s!;
    const edge = state.edge!;
    const admin = state.admin!;
    const accountId = state.accountId;
    expect(accountId).toBeGreaterThan(0n);

    // Register the core node's first op-wallet as a publishing agent.
    const agent = edge.opWallets[0]!.address;
    const nftRw = s.nft.connect(admin) as ethers.Contract;
    if ((await s.nft.agentToAccountId(agent)) !== accountId) {
      await (await nftRw.registerAgent(accountId, agent, {
        nonce: await rawTxNonce(s.provider, admin.address),
      })).wait();
    }

    const window0Before: bigint = await s.nft.windowSpent(accountId, 0n);

    // Publish a tiny KC through the agent — funded via the PCA discount branch.
    const { txHash } = await dkgPublish(edge, nquadsFile('emission-bell'));
    const receipt = await s.provider.getTransactionReceipt(txHash);
    expect(receipt, 'publish tx receipt').not.toBeNull();

    // CostCovered: a base-budget draw, no topUp overflow.
    let cost: ethers.LogDescription | null = null;
    for (const log of receipt!.logs) {
      try {
        const parsed = s.logic.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === 'CostCovered' && (parsed.args.accountId as bigint) === accountId) cost = parsed;
      } catch { /* not a Logic event */ }
    }
    expect(cost, 'publish via the agent must drive CostCovered on this PCA').not.toBeNull();
    expect(cost!.args.drawnFromEpoch as bigint, 'base budget drawn').toBeGreaterThan(0n);
    expect(cost!.args.drawnFromTopUp as bigint, 'no topUp overflow for a within-budget publish').toBe(0n);

    // THE 10.0.8 INVARIANT: the base draw emits NOTHING further to the pool —
    // that TRAC was already scheduled at createAccount. `windowSpent` is a pure
    // budget gate now. So the publish tx adds ZERO staker-shard credits.
    const staker = epsCreditsInTx(s, receipt!, STAKER_SHARD_ID);
    expect(staker.total, 'a within-budget publish must NOT re-emit to the staker pool (no double emission)').toBe(0n);

    // Budget gate advanced by exactly the discounted cost.
    const window0After: bigint = await s.nft.windowSpent(accountId, 0n);
    expect(window0After - window0Before).toBe(cost!.args.discountedCost as bigint);
  }, 180_000);

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

  it('step 5: migrateEmissionSchedule on a 10.0.8 account is idempotent (marker skips it)', async () => {
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
