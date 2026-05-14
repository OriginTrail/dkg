/**
 * V10 conviction lazy-settlement devnet validation.
 *
 * Exercises the new `DKGPublishingConvictionNFT` economic model against a
 * live 6-node devnet:
 *
 *   - `createAccount` no longer distributes the committed TRAC upfront. It
 *     sits in escrow against per-billing-window budgets.
 *   - Active sink: `coverPublishingCost` (driven through `dkg publish` via
 *     a registered agent) distributes `discountedCost` across the published
 *     KC's chain-epoch range and increments `windowSpent[acct][currentWindow]`.
 *   - Passive sink: after a billing window closes, `settle(accountId)`
 *     sweeps `baseAllowance - windowSpent[w]` into the staker pool for the
 *     chain epochs that window overlaps and advances `lastSettledWindow`.
 *
 * Preconditions:
 *   ./scripts/devnet.sh clean
 *   ./scripts/devnet.sh start 6
 *   # ideally run this AFTER the v10-end-to-end suite so the time warp
 *   # we do at step 3 lands after the daemons' RS proof has been credited.
 *
 * Why a fresh nft-admin EOA?
 *   The other devnet suites reuse the edge's op-wallets on a single shared
 *   PCA account #1 (see ensurePcaAccountForOpWallets). Re-using that here
 *   would inherit whatever billing-window state already exists, making the
 *   "first publish on window 0" assertions racey. We mint a SECOND PCA with
 *   a fresh agent EOA so the windowSpent[acct][0] === 0 precondition holds.
 *
 * Why use direct ABI calls + `dkg publish` (no new HTTP routes)?
 *   The node operator's official surface for PCA discount is "publish via
 *   an agent that's registered on the NFT" — there is no `/api/pca` route
 *   for the V10 NFT yet (the existing one drives the legacy V9 contract).
 *   This is the same pattern devnet/agent-provenance and v10-end-to-end
 *   already use; we add NO new node-side surface here.
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
  token: ethers.Contract;
  chronos: ethers.Contract;
  eps: ethers.Contract;
  parameters: ethers.Contract;
  paramsRw: ethers.Contract;
  cssAddress: string;
  epsAddress: string;
  hubOwner: ethers.Wallet;
}

// Mirrors `DKGPublishingConvictionNFT.STAKER_SHARD_ID` — every active+passive
// sink distribution goes into the V8 EpochStorage staker-pool shard.
const STAKER_SHARD_ID = 1n;

// ------------------------------------------------------------------------

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
  let authToken = '';
  const tokenPath = join(home, 'auth.token');
  if (existsSync(tokenPath)) {
    authToken = readFileSync(tokenPath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('#')) ?? '';
  }
  return { num, apiPort: config.apiPort, home, authToken, opWallets };
}

async function loadContracts(): Promise<Contracts> {
  const contractsPath = join(
    REPO_ROOT,
    'packages/evm-module/deployments/localhost_contracts.json',
  );
  const contracts = JSON.parse(readFileSync(contractsPath, 'utf8'));
  const c = (n: string): string => contracts.contracts[n]?.evmAddress;

  const provider = new ethers.JsonRpcProvider(RPC, { chainId: 31337, name: 'localhost' });

  // Mining is on a 1s interval (see devnet.sh) — disable client-side caching
  // to avoid 0-block-old readbacks racing the interval miner.
  provider.pollingInterval = 250;

  const nft = new ethers.Contract(
    c('DKGPublishingConvictionNFT'),
    [
      'function createAccount(uint96) external returns (uint256)',
      'function registerAgent(uint256, address) external',
      'function deregisterAgent(uint256, address) external',
      'function agentToAccountId(address) view returns (uint256)',
      'function accounts(uint256) view returns (uint96 committedTRAC,uint40 createdAtEpoch,uint40 expiresAtEpoch,uint40 createdAtTimestamp,uint40 expiresAtTimestamp,uint16 lockDurationEpochs,uint16 discountBps,uint16 lastSettledWindow,bool fullySwept)',
      'function windowSpent(uint256, uint40) view returns (uint96)',
      'function topUpBalance(uint256) view returns (uint96)',
      'function getCurrentBillingWindow(uint256) view returns (uint40)',
      'function getWindowChainEpochRange(uint256, uint40) view returns (uint40 startEp, uint40 endEp)',
      'function settle(uint256) external',
      'function topUp(uint256, uint96) external',
      'event AccountCreated(uint256 indexed accountId, address indexed owner, uint96 committedTRAC, uint16 discountBps, uint40 createdAtEpoch, uint40 expiresAtEpoch)',
      // MUST mirror `DKGPublishingConvictionNFT.sol` (line ~135). A drift
      // here silently turns every `parseLog({ name: 'CostCovered' })` into
      // a parse miss in the test — the lazy-settle assertions then pass
      // even when the contract's distribution math is wrong. Keep the
      // signature literal in lock-step with the contract event.
      'event CostCovered(uint256 indexed accountId, uint40 indexed epoch, uint96 baseCost, uint96 discountedCost, uint96 drawnFromEpoch, uint96 drawnFromTopUp)',
      'event WindowSettled(uint256 indexed accountId, uint40 indexed billingWindow, uint40 startEp, uint40 endEp, uint96 remainder)',
      'event AccountFinalSwept(uint256 indexed accountId, uint96 leftoverTopUp, uint96 committedDust)',
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
  // Hub-registered name is "EpochStorageV8" (V8 shard contract); the V10
  // NFT resolves it via that key — see DKGPublishingConvictionNFT.initialize.
  const epsAddress = c('EpochStorageV8');
  const eps = new ethers.Contract(
    epsAddress,
    [
      'function getEpochPool(uint256 shardId, uint256 epoch) view returns (uint96)',
      // MUST mirror `EpochStorage.sol` (only `shardId` is indexed). The
      // lazy-settlement test asserts active/passive sink amounts from
      // per-tx events instead of shared `getEpochPool` deltas — the
      // pools are global on a live devnet and unrelated daemon
      // publishes in the same epoch range can both mask regressions
      // and cause flakes (Codex round-3 finding on PR #470).
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
    token,
    chronos,
    eps,
    parameters,
    paramsRw: parameters.connect(hubOwner) as ethers.Contract,
    cssAddress: c('ConvictionStakingStorage'),
    epsAddress,
    hubOwner,
  };
}

// ------------------------------------------------------------------------

async function ensureAdminWallet(s: Contracts, tracAmount: bigint): Promise<ethers.Wallet> {
  const admin = ethers.Wallet.createRandom().connect(s.provider);
  await s.provider.send('hardhat_setBalance', [
    admin.address,
    '0x' + ethers.parseEther('100').toString(16),
  ]);
  const tokenAsDeployer = s.token.connect(s.hubOwner) as ethers.Contract;
  await (await tokenAsDeployer.mint(admin.address, tracAmount)).wait();
  return admin;
}

// Per-process tmp directory for generated `*.nq` payloads. Previously
// the test wrote them into the tracked `devnet/conviction-lazy-settle/turns/`
// directory, which dirtied the worktree on every run (Codex round-2
// finding on PR #470). We create one tmpdir per process via mkdtempSync
// and let the OS sweep it.
const NQUADS_TMP_DIR = mkdtempSync(join(tmpdir(), 'dkg-lazy-settle-'));

function nquadsFile(name: string): string {
  const p = join(NQUADS_TMP_DIR, `${name}.nq`);
  const ts = Date.now();
  writeFileSync(
    p,
    `<urn:test:${name}:${ts}> <https://schema.org/name> "${name}-${ts}" .\n`,
  );
  return p;
}

async function dkgPublish(node: DevnetNode, file: string): Promise<{ kcId: bigint; txHash: string }> {
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
      const kcMatch = /KC ID:\s*(\d+)/i.exec(stdout);
      const txMatch = /TX hash:\s*(0x[0-9a-fA-F]+)/i.exec(stdout);
      if (!kcMatch || !txMatch) {
        rej(new Error(`could not parse publish output\n${stdout}`));
        return;
      }
      res({ kcId: BigInt(kcMatch[1]!), txHash: txMatch[1]! });
    });
  });
}

async function rawTxNonce(provider: ethers.JsonRpcProvider, addr: string): Promise<number> {
  const raw = await provider.send('eth_getTransactionCount', [addr, 'pending']);
  return parseInt(raw, 16);
}

// ------------------------------------------------------------------------

const state: {
  s: Contracts | null;
  edge: DevnetNode | null;
  admin: ethers.Wallet | null;
  accountId: bigint;
  /**
   * Original `publishingConvictionEpochs` captured at suite start.
   * Step 1 shrinks the parameter to `3` for test runtime; we MUST
   * restore it so any subsequent devnet suite (e.g. v10-end-to-end,
   * agent-provenance) that creates a PCA gets the production default
   * locked in instead of inheriting our shrunken horizon. `0n` flags
   * "never captured" — afterAll then skips the restore.
   */
  originalPublishingConvictionEpochs: bigint;
  /**
   * Lifecycle accumulators for the conservation assertion in step 6.
   * The lazy-settlement invariant is:
   *   `activeSinkTotal + passiveSinkTotal + leftoverTopUp + committedDust`
   *   == `committedTRAC + sum(topUps)`
   * We update them as each step runs so step 6 can prove the full
   * `committedTRAC` has been accounted for end-to-end (active publish
   * draws + passive window sweeps + final sweep tail) — instead of
   * only checking `fullySwept` and `committedDust` as a proxy
   * (Codex round-3 finding on PR #470).
   */
  activeSinkTotal: bigint;
  passiveSinkTotal: bigint;
} = {
  s: null,
  edge: null,
  admin: null,
  accountId: 0n,
  originalPublishingConvictionEpochs: 0n,
  activeSinkTotal: 0n,
  passiveSinkTotal: 0n,
};

describe('V10 PCA lazy settlement — devnet validation', () => {
  beforeAll(async () => {
    state.s = await loadContracts();
    // Use a CORE node (node 2). Edge nodes don't have an on-chain identity
    // by default and `dkg publish` short-circuits to status="tentative" with
    // kcId=0 — we need an actual on-chain confirmation to assert the active
    // sink (the discounted cost lands in EpochStorage via the conviction
    // path). Node 1 is reserved for RS in the v10-end-to-end run; node 2
    // is the next idle core with free op wallets.
    state.edge = readNode(2);
  }, 60_000);

  // Cleanup: deregister every op wallet we bound to PCA #1 as a publishing
  // agent. The test warps chain time past `expiresAtTimestamp`, so leaving
  // these mappings in place would cause every subsequent publish from the
  // same daemon (e.g. the v10-e2e or agent-provenance suites) to route
  // through the EXPIRED PCA and revert `AccountExpired`. Real networks
  // don't see this because chain time can't be rewound and operators
  // wouldn't register a long-lived daemon wallet on a PCA they let expire.
  afterAll(async () => {
    if (!state.s) return;
    const s = state.s;

    // 1) Deregister agents so subsequent suites don't accidentally route
    //    through the expired PCA.
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
        } catch {
          // best-effort cleanup; the next suite will re-check.
        }
      }
    }

    // 2) Restore `publishingConvictionEpochs` to whatever it was before
    //    step 1 shrank it (typically the production default of 12).
    //    Otherwise the next devnet suite that creates a PCA inherits
    //    our 3-window lifetime and its assertions become flaky
    //    (Codex round-2 finding on PR #470).
    if (state.originalPublishingConvictionEpochs > 0n) {
      try {
        const current: bigint = await s.parameters.publishingConvictionEpochs();
        if (current !== state.originalPublishingConvictionEpochs) {
          await (await s.paramsRw.setPublishingConvictionEpochs(
            state.originalPublishingConvictionEpochs,
            { nonce: await rawTxNonce(s.provider, s.hubOwner.address) },
          )).wait();
        }
      } catch {
        // Tolerated: if governance ownership changed mid-test or the
        // parameter is already where we want it, the next suite's
        // assertion that requires the production default will surface
        // the issue with a clearer message than we can produce here.
      }
    }
  }, 120_000);

  it('step 1: shrink publishingConvictionEpochs so a full lifecycle fits in test time', async () => {
    const s = state.s!;
    const current: bigint = await s.parameters.publishingConvictionEpochs();
    // Capture the original BEFORE we shrink — afterAll restores it so
    // subsequent suites get the production default back.
    state.originalPublishingConvictionEpochs = current;
    // We pick 3 windows for the lifetime so:
    //   - the active-sink test sits in window 0,
    //   - the passive-sink test closes window 0 (advances 1 epoch),
    //   - the post-expiry final sweep test closes the remaining 2.
    // Using the default 12 windows means 12 × 30 days = 360 days of warp,
    // which (a) blows past the daemons' tolerance for clock skew and
    // (b) takes a long time to walk through `_finalSweep` (loops over
    // every unsettled window). 3 is the smallest count that still
    // exercises both the "windows still elapsing" and "post-expiry
    // tail" branches of `settle()`.
    if (current !== 3n) {
      const tx = await s.paramsRw.setPublishingConvictionEpochs(3, {
        nonce: await rawTxNonce(s.provider, s.hubOwner.address),
      });
      await tx.wait();
    }
    const after: bigint = await s.parameters.publishingConvictionEpochs();
    expect(after).toBe(3n);
  }, 60_000);

  it('step 2: createAccount holds TRAC in escrow only — no upfront epoch pool growth', async () => {
    const s = state.s!;
    const committed = ethers.parseEther('600000'); // tier above 500k → 50% discount
    const admin = await ensureAdminWallet(s, committed);
    state.admin = admin;

    const nftAddr = await s.nft.getAddress();
    const tokenRw = s.token.connect(admin) as ethers.Contract;
    const nftRw = s.nft.connect(admin) as ethers.Contract;

    const cssBalBefore: bigint = await s.token.balanceOf(s.cssAddress);
    const adminBalBefore: bigint = await s.token.balanceOf(admin.address);
    const currentEpoch: bigint = await s.chronos.getCurrentEpoch();
    // Sample the staker pool at the chain epoch the new account will live in.
    // The lazy-settlement model expects this to NOT grow on createAccount;
    // only `addTokensToEpochRange` driven by publish or settle() should
    // increment it. (Background daemon activity may add a small delta — we
    // log it but only assert the createAccount delta itself is zero.)
    const epochPoolBefore: bigint = await s.eps.getEpochPool(STAKER_SHARD_ID, currentEpoch);

    await (await tokenRw.approve(nftAddr, committed, {
      nonce: await rawTxNonce(s.provider, admin.address),
    })).wait();

    const tx = await nftRw.createAccount(committed, {
      nonce: await rawTxNonce(s.provider, admin.address),
    });
    const receipt = await tx.wait();

    let accountId = 0n;
    for (const log of receipt!.logs) {
      try {
        const parsed = s.nft.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (parsed?.name === 'AccountCreated') {
          accountId = parsed.args.accountId as bigint;
          break;
        }
      } catch { /* not from NFT */ }
    }
    expect(accountId).toBeGreaterThan(0n);
    state.accountId = accountId;

    const cssBalAfter: bigint = await s.token.balanceOf(s.cssAddress);
    const adminBalAfter: bigint = await s.token.balanceOf(admin.address);
    expect(cssBalAfter - cssBalBefore).toBe(committed);
    expect(adminBalBefore - adminBalAfter).toBe(committed);

    // Critical lazy-settlement invariant: createAccount must NOT call
    // `addTokensToEpochRange`. If it did, the conviction-account TRAC would
    // be paid to stakers upfront whether or not anyone actually published.
    // Parse the actual receipt for EpochPoolAdded-from-NFT events: the
    // direct on-chain check below (delta) is sensitive to background daemon
    // publishes; the event check isn't.
    const epsAddr = (s.epsAddress).toLowerCase();
    const nftAddrLower = nftAddr.toLowerCase();
    let nftEmittedEpsEvent = false;
    for (const log of receipt!.logs) {
      if ((log.address ?? '').toLowerCase() === epsAddr) {
        // EpochStorage emits TokensAddedToEpochRange(shardId, startEpoch, endEpoch, tokensAmount).
        // Just observing ANY event from EPS during the createAccount tx is
        // already a violation — no other contract should have moved tokens
        // during the same tx.
        nftEmittedEpsEvent = true;
      }
      void nftAddrLower;
    }
    expect(nftEmittedEpsEvent, 'createAccount must NOT trigger any EpochStorage emission (escrow-only)').toBe(false);

    // Sanity log (informational): if the staker pool moved during the
    // tx, it was from a daemon-driven publish in the same block, not us.
    const epochPoolAfter: bigint = await s.eps.getEpochPool(STAKER_SHARD_ID, currentEpoch);
    // eslint-disable-next-line no-console
    console.log(
      `step 2: createAccount → accountId=${accountId} committed=${ethers.formatEther(committed)} TRAC ` +
      `(epochPool[${currentEpoch}] before=${ethers.formatEther(epochPoolBefore)} after=${ethers.formatEther(epochPoolAfter)})`,
    );
  }, 120_000);

  it('step 3: register agent + publish → ACTIVE SINK: windowSpent grows, EpochStorage funded for KC range', async () => {
    const s = state.s!;
    const edge = state.edge!;
    const admin = state.admin!;
    const accountId = state.accountId;
    expect(accountId).toBeGreaterThan(0n);

    const nftRw = s.nft.connect(admin) as ethers.Contract;
    // Register every op wallet — the daemon's publisher rotates wallets per
    // publish, so registering just opWallets[0] would race the rotation.
    for (const w of edge.opWallets) {
      const already: bigint = await s.nft.agentToAccountId(w.address);
      if (already > 0n && already !== accountId) {
        throw new Error(`op wallet ${w.address} is already on a different PCA (${already})`);
      }
      if (already === 0n) {
        await (await nftRw.registerAgent(accountId, w.address, {
          nonce: await rawTxNonce(s.provider, admin.address),
        })).wait();
      }
    }

    const window0: bigint = BigInt(await s.nft.getCurrentBillingWindow(accountId));
    expect(window0).toBe(0n);

    const [windowStartEp, windowEndEp] = await s.nft.getWindowChainEpochRange(accountId, 0n);
    // eslint-disable-next-line no-console
    console.log(`step 3: window 0 overlaps chain epochs [${windowStartEp}, ${windowEndEp}]`);

    const spent0Before: bigint = await s.nft.windowSpent(accountId, 0n);

    const file = nquadsFile('lazy-settle-publish');
    const result = await dkgPublish(edge, file);
    expect(result.kcId).toBeGreaterThan(0n);

    // Source of truth for the active-sink amount is the publish tx
    // receipt's `CostCovered` + `TokensAddedToEpochRange` events — not
    // cumulative `EpochStorage.getEpochPool` deltas. Those pools are
    // global on a live devnet and unrelated daemon publishes in the
    // same epoch range can both mask regressions AND cause flakes
    // (Codex round-3 finding on PR #470).
    const receipt = await s.provider.getTransactionReceipt(result.txHash);
    expect(receipt).not.toBeNull();

    let costCoveredEvents = 0;
    let costCoveredDiscounted = 0n;
    let costCoveredFromEpoch = 0n;
    let activeSinkFromEvents = 0n;
    for (const log of receipt!.logs) {
      // NFT-emitted `CostCovered`: deltaSpent for window 0 = drawnFromEpoch.
      if (log.address.toLowerCase() === (await s.nft.getAddress()).toLowerCase()) {
        try {
          const parsed = s.nft.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed?.name === 'CostCovered' && BigInt(parsed.args.accountId) === accountId) {
            costCoveredEvents++;
            costCoveredDiscounted = BigInt(parsed.args.discountedCost);
            costCoveredFromEpoch = BigInt(parsed.args.drawnFromEpoch);
          }
        } catch { /* not from NFT */ }
      }
      // EpochStorage-emitted `TokensAddedToEpochRange`: this is the
      // active-sink write. `coverPublishingCost` -> `_distributeProrated`
      // can emit up to 3 such events (head partial + middle range +
      // tail partial). Sum the `tokenAmount` field to recover the full
      // discounted cost actually distributed.
      if (log.address.toLowerCase() === s.epsAddress.toLowerCase()) {
        try {
          const parsed = s.eps.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed?.name === 'TokensAddedToEpochRange') {
            activeSinkFromEvents += BigInt(parsed.args.tokenAmount);
          }
        } catch { /* not from EpochStorage */ }
      }
    }
    expect(costCoveredEvents).toBe(1);

    // windowSpent delta MUST equal the on-chain `drawnFromEpoch`
    // reported in `CostCovered` (window 0 has full base allowance
    // remaining so the entire discounted cost is drawn from the
    // window — `drawnFromTopUp == 0`).
    const spent0After: bigint = await s.nft.windowSpent(accountId, 0n);
    expect(spent0After - spent0Before).toBe(costCoveredFromEpoch);

    // Active sink: sum of `TokensAddedToEpochRange.tokenAmount` over
    // the publish receipt equals the discounted cost distributed.
    expect(activeSinkFromEvents).toBe(costCoveredDiscounted);

    // Record for the conservation assertion in step 6. The active
    // sink across the account's lifetime is the sum of all
    // `drawnFromEpoch + drawnFromTopUp` across `CostCovered`. With
    // no topUps in this suite, `drawnFromTopUp == 0` so we can use
    // `discountedCost` directly.
    state.activeSinkTotal += costCoveredDiscounted;

    // eslint-disable-next-line no-console
    console.log(
      `step 3: published kcId=${result.kcId} → CostCovered.discountedCost=${ethers.formatEther(costCoveredDiscounted)} TRAC, ` +
      `activeSink(from events)=${ethers.formatEther(activeSinkFromEvents)} TRAC, ` +
      `windowSpent[acct][0] += ${ethers.formatEther(spent0After - spent0Before)} TRAC`,
    );
  }, 180_000);

  it('step 4: PASSIVE SINK: advance one billing window, settle() sweeps the unspent base remainder', async () => {
    const s = state.s!;
    const accountId = state.accountId;
    expect(accountId).toBeGreaterThan(0n);

    const epochLength: bigint = await s.chronos.epochLength();
    const acctBefore = await s.nft.accounts(accountId);
    const committedTRAC: bigint = acctBefore.committedTRAC;
    const lockDurationEpochs: number = Number(acctBefore.lockDurationEpochs);
    const baseAllowance: bigint = committedTRAC / BigInt(lockDurationEpochs);
    const drawnInWindow0: bigint = await s.nft.windowSpent(accountId, 0n);
    const expectedRemainder: bigint = baseAllowance > drawnInWindow0
      ? baseAllowance - drawnInWindow0
      : 0n;
    expect(expectedRemainder).toBeGreaterThan(0n);

    // Advance Hardhat clock past window 0's boundary. The next tx will mine
    // a block at exactly `target`; the 1s interval miner picks up from
    // there. We use `evm_setNextBlockTimestamp` (not `evm_increaseTime`)
    // so we can ASSERT the destination timestamp precisely.
    const before = await s.provider.getBlock('latest');
    const targetTs = BigInt(before!.timestamp) + epochLength + 2n;
    await s.provider.send('evm_setNextBlockTimestamp', [Number(targetTs)]);
    await s.provider.send('evm_mine', []);

    const windowNow: bigint = BigInt(await s.nft.getCurrentBillingWindow(accountId));
    expect(windowNow).toBeGreaterThanOrEqual(1n);

    const [w0Start, w0End] = await s.nft.getWindowChainEpochRange(accountId, 0n);

    // Anyone can call settle — pick the deployer (it's already funded).
    const nftRw = s.nft.connect(s.hubOwner) as ethers.Contract;
    const tx = await nftRw.settle(accountId, {
      nonce: await rawTxNonce(s.provider, s.hubOwner.address),
    });
    const receipt = await tx.wait();

    // Parse WindowSettled + TokensAddedToEpochRange events from the
    // settle() receipt. We assert against per-tx events instead of
    // global `EpochStorage.getEpochPool` deltas — the pools are
    // global on a live devnet, so any other write touching
    // `[w0Start..w0End]` between snapshots would fail an exact-equality
    // pool-delta assertion even when `settle()` is correct (Codex
    // round-3 finding on PR #470).
    const nftAddr = (await s.nft.getAddress()).toLowerCase();
    const epsAddrLc = s.epsAddress.toLowerCase();
    let sweptForWindow0 = 0n;
    let settledWindows = 0;
    let sweepDistributedFromEvents = 0n;
    for (const log of receipt!.logs) {
      if (log.address.toLowerCase() === nftAddr) {
        try {
          const parsed = s.nft.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed?.name === 'WindowSettled' && BigInt(parsed.args.accountId) === accountId) {
            settledWindows++;
            if (BigInt(parsed.args.billingWindow) === 0n) {
              sweptForWindow0 = BigInt(parsed.args.remainder);
            }
          }
        } catch { /* not from NFT */ }
      }
      if (log.address.toLowerCase() === epsAddrLc) {
        try {
          const parsed = s.eps.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed?.name === 'TokensAddedToEpochRange') {
            sweepDistributedFromEvents += BigInt(parsed.args.tokenAmount);
          }
        } catch { /* not from EpochStorage */ }
      }
    }
    expect(settledWindows).toBeGreaterThanOrEqual(1);
    expect(sweptForWindow0).toBe(expectedRemainder);

    // Conservation: the sum of `tokenAmount` across all
    // `TokensAddedToEpochRange` emits within this `settle()` receipt
    // MUST equal the sum of `remainder` across all `WindowSettled`
    // emits — passive sweep funds exactly the unspent base allowance
    // for each settled window. Each window emits 1 or 2 such writes
    // depending on chain-epoch overlap (see `_sweepWindowProrated`).
    let sweptTotalFromWindows = 0n;
    for (const log of receipt!.logs) {
      if (log.address.toLowerCase() !== nftAddr) continue;
      try {
        const parsed = s.nft.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (parsed?.name === 'WindowSettled' && BigInt(parsed.args.accountId) === accountId) {
          sweptTotalFromWindows += BigInt(parsed.args.remainder);
        }
      } catch { /* not from NFT */ }
    }
    expect(sweepDistributedFromEvents).toBe(sweptTotalFromWindows);

    // Accumulate passive-sink total for step 6's conservation check.
    state.passiveSinkTotal += sweptTotalFromWindows;

    const acctAfter = await s.nft.accounts(accountId);
    expect(Number(acctAfter.lastSettledWindow)).toBeGreaterThanOrEqual(1);
    expect(acctAfter.fullySwept).toBe(false);

    // eslint-disable-next-line no-console
    console.log(
      `step 4: settle() swept window 0 → +${ethers.formatEther(sweptForWindow0)} TRAC across chain epochs [${w0Start},${w0End}]; ` +
      `settledWindows=${settledWindows}, distributedFromEvents=${ethers.formatEther(sweepDistributedFromEvents)} TRAC; ` +
      `lastSettledWindow=${acctAfter.lastSettledWindow}`,
    );
  }, 240_000);

  it('step 5: idempotent settle — second call inside the same window is a no-op', async () => {
    const s = state.s!;
    const accountId = state.accountId;
    expect(accountId).toBeGreaterThan(0n);

    const acctBefore = await s.nft.accounts(accountId);
    const lastBefore = Number(acctBefore.lastSettledWindow);

    const nftRw = s.nft.connect(s.hubOwner) as ethers.Contract;
    const tx = await nftRw.settle(accountId, {
      nonce: await rawTxNonce(s.provider, s.hubOwner.address),
    });
    const receipt = await tx.wait();

    let windowSettledEvents = 0;
    for (const log of receipt!.logs) {
      try {
        const parsed = s.nft.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (parsed?.name === 'WindowSettled' && BigInt(parsed.args.accountId) === accountId) {
          windowSettledEvents++;
        }
      } catch { /* not from NFT */ }
    }
    expect(windowSettledEvents).toBe(0);

    const acctAfter = await s.nft.accounts(accountId);
    expect(Number(acctAfter.lastSettledWindow)).toBe(lastBefore);
  }, 60_000);

  it('step 6: POST-EXPIRY final sweep: walk past expiresAtTimestamp; settle() emits AccountFinalSwept', async () => {
    const s = state.s!;
    const accountId = state.accountId;
    expect(accountId).toBeGreaterThan(0n);

    const acctBefore = await s.nft.accounts(accountId);
    const expiresAt: bigint = acctBefore.expiresAtTimestamp;
    const committedTRAC: bigint = acctBefore.committedTRAC;
    const lockDurationEpochs: number = Number(acctBefore.lockDurationEpochs);

    const target = expiresAt + 5n;
    const latest = await s.provider.getBlock('latest');
    if (BigInt(latest!.timestamp) < target) {
      await s.provider.send('evm_setNextBlockTimestamp', [Number(target)]);
      await s.provider.send('evm_mine', []);
    }

    const nftRw = s.nft.connect(s.hubOwner) as ethers.Contract;
    const tx = await nftRw.settle(accountId, {
      nonce: await rawTxNonce(s.provider, s.hubOwner.address),
    });
    const receipt = await tx.wait();

    let sawFinalSweep = false;
    let leftoverTopUp = 0n;
    let committedDust = 0n;
    const windowsSettled: number[] = [];
    let sweptTotal = 0n;
    for (const log of receipt!.logs) {
      try {
        const parsed = s.nft.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (parsed?.name === 'AccountFinalSwept' && BigInt(parsed.args.accountId) === accountId) {
          sawFinalSweep = true;
          leftoverTopUp = BigInt(parsed.args.leftoverTopUp);
          committedDust = BigInt(parsed.args.committedDust);
        } else if (parsed?.name === 'WindowSettled' && BigInt(parsed.args.accountId) === accountId) {
          windowsSettled.push(Number(parsed.args.billingWindow));
          sweptTotal += BigInt(parsed.args.remainder);
        }
      } catch { /* not from NFT */ }
    }
    expect(sawFinalSweep).toBe(true);

    // Accumulate the post-expiry passive sweeps (windows settled by
    // this final-sweep call, e.g. windows 1..N-1 if step 4 already
    // settled window 0).
    state.passiveSinkTotal += sweptTotal;

    // No topUps were ever performed on this account, so the final
    // sweep's leftoverTopUp tail MUST be exactly zero.
    expect(leftoverTopUp).toBe(0n);

    // ── CONSERVATION INVARIANT ─────────────────────────────────────
    // For an account with no topUps, the lazy-settlement model
    // promises:
    //
    //     activeSinkTotal + passiveSinkTotal + leftoverTopUp +
    //     committedDust == committedTRAC
    //
    // where
    //   - `activeSinkTotal` = sum of `CostCovered.discountedCost`
    //     across all publishes (step 3 in this suite),
    //   - `passiveSinkTotal` = sum of `WindowSettled.remainder`
    //     across all settle() calls (step 4 + step 6),
    //   - `leftoverTopUp` = `AccountFinalSwept.leftoverTopUp` (== 0
    //     here since no topUps),
    //   - `committedDust` = `committedTRAC %
    //     lockDurationEpochs` (the truncation crumb in the per-window
    //     base allowance).
    //
    // The contract's final sweep writes `committedDust` to the
    // staker pool too, so this equation captures full token
    // conservation: every wei the publisher escrowed at create has
    // either funded the published KC (active sink) or the staker
    // pool (passive sweeps + final dust). Asserting the equation
    // directly is what Codex round-3 asked for — `fullySwept` and
    // `committedDust == expectedDust` alone don't prove
    // conservation.
    const baseAllowance = committedTRAC / BigInt(lockDurationEpochs);
    const expectedDust = committedTRAC - baseAllowance * BigInt(lockDurationEpochs);
    expect(committedDust).toBe(expectedDust);

    const totalAccounted =
      state.activeSinkTotal +
      state.passiveSinkTotal +
      leftoverTopUp +
      committedDust;
    expect(totalAccounted).toBe(committedTRAC);

    const acctAfter = await s.nft.accounts(accountId);
    expect(acctAfter.fullySwept).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      `step 6: final sweep: leftoverTopUp=${ethers.formatEther(leftoverTopUp)} dust=${committedDust} ` +
      `windowsSettled=[${windowsSettled.join(',')}] additionalSweptTotal=${ethers.formatEther(sweptTotal)} TRAC`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `step 6: CONSERVATION: active=${ethers.formatEther(state.activeSinkTotal)} + ` +
      `passive=${ethers.formatEther(state.passiveSinkTotal)} + ` +
      `leftoverTopUp=${ethers.formatEther(leftoverTopUp)} + ` +
      `dust=${committedDust} = ${ethers.formatEther(totalAccounted)} == ` +
      `committedTRAC=${ethers.formatEther(committedTRAC)} ✓`,
    );
  }, 240_000);

  it('step 7: post-final settle is a no-op (idempotency past fullySwept)', async () => {
    const s = state.s!;
    const accountId = state.accountId;
    expect(accountId).toBeGreaterThan(0n);

    const nftRw = s.nft.connect(s.hubOwner) as ethers.Contract;
    const tx = await nftRw.settle(accountId, {
      nonce: await rawTxNonce(s.provider, s.hubOwner.address),
    });
    const receipt = await tx.wait();

    let anyEvent = false;
    for (const log of receipt!.logs) {
      try {
        const parsed = s.nft.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (parsed && (parsed.name === 'WindowSettled' || parsed.name === 'AccountFinalSwept')) {
          if (BigInt(parsed.args.accountId) === accountId) anyEvent = true;
        }
      } catch { /* not from NFT */ }
    }
    expect(anyEvent).toBe(false);
  }, 60_000);
});
