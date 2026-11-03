// =============================================================================
// rfc27-testnet-fork-rehearsal.ts — OT-RFC-27 testnet deploy rehearsal on a
// LOCAL anvil fork of Base Sepolia
// =============================================================================
//
// Rehearses the testnet deploy of the OT-RFC-27 contract stack with the
// repository's own deploy pipeline, against an anvil fork of Base Sepolia, then
// drives one full marketplace cycle on the fork. Every write goes to the local
// anvil; the upstream RPC is only ever read, by anvil.
//
// The stack: ConvictionServiceStorage (052c), ServiceSubscriptions and
// ServiceSubscriptionsWallet (052d), QueryInferenceStorage (052e),
// QueryInferenceSettlement (052f), StakingV10Ledger (054a) and
// ConvictionWithdrawalStorage (054b) are new; PublishingConviction moves to
// 10.2.0, StakingV10 to 10.1.0 (055) and StakingKPI to 10.1.0 (024); 998
// registers and initializes everything in one Hub transaction, and 998b
// leaves the activation epoch to the Hub owner, after it.
//
// Why an external anvil fork: Hardhat's in-process fork has no Base hardfork
// history (see scripts/fork-rehearsal.ts). The deploy pipeline runs through
// scripts/rfc27-testnet-fork.config.ts, which keeps the network name
// `base_sepolia_v10` and the `testnet` environment, hard-codes the URL to the
// local anvil and uses anvil's remote accounts, so no key is involved. The
// deployer is anvil's first development account, which is not the Hub owner:
// 998 then prints the Hub transaction, decoded, and the `hub` phase sends it
// as the impersonated Hub owner.
//
// Usage (from packages/evm-module; unset every *BASE_SEPOLIA* / *PRIVATE_KEY* /
// *MNEMONIC* variable first, e.g. with `env -u`):
//
//   anvil --fork-url <base-sepolia-rpc> --fork-block-number <N> --port 8545 &
//   CFG=scripts/rfc27-testnet-fork.config.ts
//   RUN="npx hardhat run scripts/rfc27-testnet-fork-rehearsal.ts --network base_sepolia_v10 --config $CFG"
//
//   # 1. what the live contracts do before the upgrade, inside a reverted snapshot
//   PHASE=pre $RUN
//
//   # 2. the real deploy pipeline. The three upgrades are redeployed by marking
//   #    their entries not deployed, as 052d and 052e document; the run
//   #    rewrites the deployments file, which is restored afterwards and never
//   #    committed. flip marks the given entries not deployed:
//   flip() { node -e "const f='deployments/base_sepolia_v10_contracts.json',j=require('./'+f);for(const n of process.argv.slice(1))j.contracts[n].deployed=false;require('fs').writeFileSync(f,JSON.stringify(j,null,4))" "$@"; }
//   #    2a. the guard: with StakingV10 left deployed, 052e refuses the run, before any transaction
//   flip PublishingConviction StakingKPI
//   npx hardhat deploy --network base_sepolia_v10 --config $CFG    # fails: StakingV10 10.0.4 is kept
//   git checkout -- deployments/base_sepolia_v10_contracts.json
//   #    2b. the real run
//   flip PublishingConviction StakingV10 StakingKPI
//   npx hardhat deploy --network base_sepolia_v10 --config $CFG | tee cache/rfc27-fork/deploy.log
//   cp deployments/base_sepolia_v10_contracts.json cache/rfc27-fork/contracts.deployed.json
//   git checkout -- deployments/base_sepolia_v10_contracts.json
//
//   # 3. the activation refused before the Hub transaction (and, in a reverted
//   #    snapshot, while the settlement or StakingV10 does not read the pool),
//   #    then the Hub owner's transaction 998 printed, then the activation
//   PHASE=hub DEPLOY_LOG=cache/rfc27-fork/deploy.log $RUN
//
//   # 4. existing accounts and positions after the upgrade, with every
//   #    position's first-claim gas and the longest history's withdrawal gas;
//   # 5. one full cycle, with a withdrawal in the middle of an epoch and its
//   #    claimWithdrawnEpoch, and the settlement removed in a reverted snapshot;
//   # 6. an account untouched for several epochs, booked late;
//   # 7. the close falling more than maxCloseStepsPerClaim epochs behind;
//   # 8. the unused share of every closed epoch, read from storage
//   PHASE=existing $RUN
//   PHASE=cycle $RUN
//   PHASE=late-booking $RUN
//   PHASE=close-behind $RUN
//   PHASE=unused $RUN
//
// Each phase writes cache/rfc27-fork/<phase>.json (REHEARSAL_DIR overrides the
// directory) and reads what the earlier phases wrote.
//
// Fork-only shortcuts, each named where it is taken:
//   - the Hub owner, the KnowledgeAssetsLifecycle contract, RandomSampling,
//     node operational keys and position owners are impersonated;
//   - the KnowledgeAssetsLifecycle impersonation calls the publishing NFT's
//     `coverPublishingCost` as a publish would, without the publish's node
//     signatures;
//   - node scores for the epochs after the fork are written through the
//     contract the Hub holds as RandomSampling, as a valid proof writes them
//     (the proofs themselves cannot be produced on a fork), each node scoring
//     what it scored in the last full epoch before the fork;
//   - test buyers get their TRAC from the Hub owner's balance;
//   - an anvil account is added as an admin key of the first seller, through
//     the contract the Hub holds as Identity, so that its operator fee can be
//     set through Profile.updateOperatorFee and withdrawn through
//     StakingV10Ledger (every testnet node charges 0 %).
// anvil does not enforce EIP-7825's 2^24 per-transaction gas cap, which Base
// Sepolia does, so every transaction's gas is compared with it here; and its
// gas estimates get a margin (see padGasEstimates).

import * as fs from 'fs';
import * as path from 'path';

import hre, { ethers } from 'hardhat';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const DIR = process.env.REHEARSAL_DIR ?? 'cache/rfc27-fork';
const PHASE = process.env.PHASE ?? '';
const TX_GAS_CAP = 1n << 24n; // EIP-7825
const TRAC = 10n ** 18n;
const DAY = 86_400n;
const FUND = '0x56BC75E2D63100000'; // 100 ETH for impersonated senders
const LIVE_JSON = 'deployments/base_sepolia_v10_contracts.json';

// Cycle parameters.
const COMMITTED = BigInt(process.env.COMMITTED ?? String(100_000n * TRAC)); // the 30 % tier
const LATE_COMMITTED = 12_000n * TRAC; // an account left untouched, booked late
const CA_PERIOD_VALUE = 10n * TRAC; // a 7 TRAC cost at the 30 % tier
const WALLET_PERIOD_VALUE = 5n * TRAC;
const PUBLISH_BASE_COST = 20n * TRAC;
const PUBLISH_KA_EPOCHS = 2n;
const UNIT_ASK = 10n ** 15n; // 0.001 TRAC per unit
const PRICE_CAP = 10n ** 16n;
const CLASS_INFERENCE = 1;
const SELLERS = (process.env.SELLERS ?? '3,1').split(',').map((s) => BigInt(s));

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

const fmt = (x: bigint) => ethers.formatEther(x);
const big = (x: Any) => BigInt(x.toString());
const jsonable = (x: Any): Any =>
  JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

function save(name: string, data: Any) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, `${name}.json`), JSON.stringify(jsonable(data), null, 2));
  console.log(`\n→ wrote ${path.join(DIR, `${name}.json`)}`);
}
function load(name: string): Any {
  const f = path.join(DIR, `${name}.json`);
  if (!fs.existsSync(f)) throw new Error(`${f} is missing: run PHASE=${name} first`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

const rawSend = hre.network.provider.send.bind(hre.network.provider);
const rawRequest = hre.network.provider.request.bind(hre.network.provider);
const rpc = (method: string, params: Any[] = []) => rawSend(method, params);

/**
 * anvil's eth_estimateGas has come out a few thousand gas short of what the
 * mined transaction needed, where a call's 63/64 forwarding meets storage
 * refunds (claims and withdrawals ran out of gas in Ask.recalculateActiveSet
 * at their estimate). Every estimate the signers use gets a margin; the gas
 * used, which is what the rehearsal reports, does not change.
 */
function padGasEstimates() {
  const pad = (x: Any) => ethers.toQuantity((BigInt(x) * 5n) / 4n + 50_000n);
  const p = hre.network.provider as Any;
  p.send = async (method: string, params?: Any[]) => {
    const r = await rawSend(method, params);
    return method === 'eth_estimateGas' ? pad(r) : r;
  };
  p.request = async (a: Any) => {
    const r = await rawRequest(a);
    return a.method === 'eth_estimateGas' ? pad(r) : r;
  };
}

async function impersonate(addr: string) {
  await rpc('anvil_impersonateAccount', [addr]);
  await rpc('anvil_setBalance', [addr, FUND]);
  return ethers.getSigner(addr);
}

async function now(): Promise<bigint> {
  return BigInt((await ethers.provider.getBlock('latest'))!.timestamp);
}

/** Move the chain to `ts` (at least one second ahead) with evm_increaseTime + evm_mine. */
async function warpTo(ts: bigint) {
  const t = await now();
  if (ts > t) await rpc('evm_increaseTime', [Number(ts - t)]);
  await rpc('evm_mine', []);
}

const live = JSON.parse(fs.readFileSync(LIVE_JSON, 'utf8')).contracts;
const HUB = live.Hub.evmAddress as string;

let hub: Any;
async function hubContract() {
  hub ??= await ethers.getContractAt('Hub', HUB);
  return hub;
}
async function addr(name: string): Promise<string> {
  return (await hubContract()).getContractAddress(name);
}
async function at(name: string, abiName = name) {
  return ethers.getContractAt(abiName, await addr(name));
}

// Every interface whose events or errors a receipt may carry.
const IFACE_NAMES = [
  'Hub',
  'EpochStorage',
  'PublishingConviction',
  'DKGPublishingConvictionNFT',
  'StakingV10',
  'StakingV10Ledger',
  'StakingKPI',
  'QueryInferenceSettlement',
  'QueryInferenceStorage',
  'ServiceSubscriptions',
  'ServiceSubscriptionsWallet',
  'ConvictionServiceStorage',
  'ConvictionStakingStorage',
  'DKGStakingConvictionNFT',
  'Token',
];
let ifaces: Any[] | undefined;
async function interfaces() {
  ifaces ??= await Promise.all(IFACE_NAMES.map(async (n) => (await ethers.getContractFactory(n)).interface));
  return ifaces;
}

async function decodeError(data: string | undefined): Promise<string> {
  if (!data || data === '0x') return 'revert (no data)';
  for (const i of await interfaces()) {
    try {
      const e = i.parseError(data);
      if (e) return `${e.name}(${e.args.map((a: Any) => String(a)).join(', ')})`;
    } catch {
      // not this interface
    }
  }
  return `revert ${data.slice(0, 10)}`;
}

function errorData(e: Any): string | undefined {
  for (const c of [e?.data, e?.error?.data, e?.info?.error?.data, e?.error?.error?.data]) {
    if (typeof c === 'string' && c.startsWith('0x')) return c;
    if (c && typeof c.data === 'string') return c.data;
  }
  return undefined;
}

/** The deepest failing frame of a mined transaction, from anvil's call tracer. */
async function deepestFailure(hash: string): Promise<string> {
  try {
    const trace = await rpc('debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
    let found = '';
    const walk = (c: Any) => {
      if (c.error) found = `${c.error} in a call to ${c.to} (${String(c.input).slice(0, 10)}) with ${BigInt(c.gas)} gas`;
      for (const s of c.calls ?? []) walk(s);
    };
    walk(trace);
    return found || 'reverted';
  } catch {
    return 'reverted';
  }
}

type Ev = { address: string; name: string; args: Any };
async function eventsOf(receipt: Any): Promise<Ev[]> {
  const out: Ev[] = [];
  for (const log of receipt.logs) {
    for (const i of await interfaces()) {
      try {
        const p = i.parseLog({ topics: [...log.topics], data: log.data });
        if (p) {
          out.push({ address: log.address, name: p.name, args: p.args });
          break;
        }
      } catch {
        // another contract's log
      }
    }
  }
  return out;
}

const txLog: Any[] = [];
/** Send, wait, record gas and events; a revert is recorded and rethrown. */
async function send(label: string, p: Promise<Any>): Promise<{ receipt: Any; events: Ev[] }> {
  let tx;
  try {
    tx = await p;
  } catch (e: Any) {
    const why = await decodeError(errorData(e));
    txLog.push({ label, status: 'reverted before inclusion', error: why });
    console.log(`  ✗ ${label}: ${why}`);
    throw e;
  }
  let receipt;
  try {
    receipt = await tx.wait();
  } catch (e: Any) {
    const r = await ethers.provider.getTransactionReceipt(tx.hash);
    const why = await deepestFailure(tx.hash);
    txLog.push({ label, hash: tx.hash, status: 0, gasUsed: r ? big(r.gasUsed) : undefined, gasLimit: big(tx.gasLimit), error: why });
    console.log(`  ✗ ${label}: reverted on chain, ${why}`);
    throw e;
  }
  const gas = big(receipt.gasUsed);
  const entry = {
    label,
    hash: receipt.hash,
    block: receipt.blockNumber,
    from: receipt.from,
    to: receipt.to,
    gasUsed: gas,
    gasLimit: big(tx.gasLimit),
    overTxGasCap: gas > TX_GAS_CAP,
    status: receipt.status,
  };
  txLog.push(entry);
  console.log(`  ✓ ${label}: gas ${gas}${gas > TX_GAS_CAP ? '  ⚠ ABOVE the 2^24 transaction gas cap' : ''}`);
  return { receipt, events: await eventsOf(receipt) };
}

/** A call that must revert: its decoded error. */
async function expectRevert(label: string, p: Promise<Any>): Promise<string> {
  try {
    await p;
  } catch (e: Any) {
    const why = await decodeError(errorData(e));
    console.log(`  ✓ ${label} reverts: ${why}`);
    return why;
  }
  console.log(`  ✗ ${label} did NOT revert`);
  return 'did not revert';
}

/**
 * The smallest gas limit a transaction goes through with, found by bisection,
 * each try sent and reverted in its own snapshot. The sender must be an anvil
 * account or impersonated.
 */
async function minGasLimit(from: string, to: string, data: string, hi = 30_000_000n): Promise<bigint> {
  return (await measureTx(from, to, data, hi)).minGasLimit;
}

/**
 * A transaction's gas used, sent with a generous limit, and the smallest gas
 * limit it goes through with, all in reverted snapshots: the state is left as
 * it was.
 */
async function measureTx(from: string, to: string, data: string, hi = 30_000_000n) {
  // A cold fork fetches every slot a large claim reads from the upstream
  // endpoint, which can fail transiently (an HTTP 502 or 429): one call first,
  // retried, fills anvil's cache, which the snapshots below keep.
  for (let i = 0; ; i++) {
    try {
      await rpc('eth_call', [{ from, to, data, gas: ethers.toQuantity(hi) }, 'latest']);
      break;
    } catch (e: Any) {
      if (i >= 5 || !/Fork Error|50[234]|429|timed out|ECONNRESET/i.test(String(e?.message ?? e))) throw e;
      console.log(`  (upstream error while warming the fork, retrying: ${String(e?.message ?? e).slice(0, 80)})`);
      await new Promise((res) => setTimeout(res, 10_000 * (i + 1)));
    }
  }
  const attempt = async (gas: bigint): Promise<{ ok: boolean; gasUsed: bigint }> => {
    const snap = await rpc('evm_snapshot', []);
    try {
      const hash = await rpc('eth_sendTransaction', [{ from, to, data, gas: ethers.toQuantity(gas) }]);
      // A fork still fetching upstream state can take minutes to mine a large
      // claim; the snapshot is reverted only once the transaction is in.
      for (let i = 0; i < 6_000; i++) {
        const r = await ethers.provider.getTransactionReceipt(hash);
        if (r) return { ok: r.status === 1, gasUsed: big(r.gasUsed) };
        await new Promise((res) => setTimeout(res, 200));
      }
      throw new Error(`no receipt for ${hash} after 20 minutes`);
    } finally {
      await rpc('evm_revert', [snap]);
    }
  };
  const full = await attempt(hi);
  if (!full.ok) throw new Error(`the transaction fails even with a gas limit of ${hi}`);
  let lo = 21_000n;
  let top = hi;
  while (top - lo > 1_000n) {
    const mid = (lo + top) / 2n;
    if ((await attempt(mid)).ok) top = mid;
    else lo = mid;
  }
  return { gasUsed: full.gasUsed, minGasLimit: top, marginTo2pow24: TX_GAS_CAP - top };
}

const stakerCredits = (events: Ev[]) =>
  events
    .filter((e) => e.name === 'TokensAddedToEpochRange' && big(e.args.shardId) === 1n)
    .map((e) => ({ start: big(e.args.startEpoch), end: big(e.args.endEpoch), amount: big(e.args.tokenAmount) }));
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

const checks: [string, boolean, string?][] = [];
function check(label: string, ok: boolean, detail?: string) {
  checks.push([label, ok, detail]);
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Shared reads
// ---------------------------------------------------------------------------

async function positions() {
  const snft = await at('DKGStakingConvictionNFT');
  const css = await at('ConvictionStakingStorage');
  const next = big(await snft.nextTokenId());
  const out: Any[] = [];
  for (let t = 1n; t <= next; t++) {
    const p = await css.getPosition(t);
    if (big(p.identityId) === 0n) continue;
    out.push({
      tokenId: t,
      owner: await snft.ownerOf(t),
      node: big(p.identityId),
      raw: big(p.raw),
      lastClaimedEpoch: big(p.lastClaimedEpoch),
      migrationEpoch: big(p.migrationEpoch),
      expiryTimestamp: big(p.expiryTimestamp),
      cumulativeRewardsClaimed: big(p.cumulativeRewardsClaimed),
    });
  }
  return out;
}

/** The operational key of each node that sent a recent proof challenge. */
async function operationalKeys(span = 1800): Promise<Record<string, string>> {
  const rsAddr = await addr('RandomSampling');
  const ids = await at('IdentityStorage');
  const topic = ethers.id('ChallengeGenerated(uint72,uint256,uint256,uint256,uint256,uint256)');
  const head = Number(process.env.FORK_BLOCK ?? (await ethers.provider.getBlockNumber()));
  const out: Record<string, string> = {};
  for (let to = head; to > head - span; to -= 199) {
    const logs = await ethers.provider.getLogs({ address: rsAddr, topics: [topic], fromBlock: to - 198, toBlock: to });
    for (const l of logs) {
      const node = BigInt(l.topics[1]).toString();
      if (out[node]) continue;
      const tx = await ethers.provider.getTransaction(l.transactionHash);
      if ((await ids.getIdentityId(tx!.from)).toString() === node) out[node] = tx!.from;
    }
  }
  return out;
}

/** Per node and epoch of the claim windows: StakingKPI's net and the split state. */
async function nodeEpochNets(nodes: bigint[], from: bigint, to: bigint, kpiAddress: string) {
  const kpi = await ethers.getContractAt('StakingKPI', kpiAddress);
  const css = await at('ConvictionStakingStorage');
  const rss = await at('RandomSamplingStorage');
  const out: Record<string, Any> = {};
  for (const n of nodes) {
    for (let e = from; e <= to; e++) {
      if (big(await rss.getEpochLastScorePerStake(n, e)) === 0n && big(await rss.getNodeEpochScore(e, n)) === 0n) continue;
      out[`${n}:${e}`] = {
        kpiNet: big(await kpi.getNetNodeRewards(n, e)),
        split: await css.isOperatorFeeClaimedForEpoch(n, e),
        storedNet: big(await css.getNetNodeEpochRewards(n, e)),
      };
    }
  }
  return out;
}

async function storedNets(keys: string[]) {
  const css = await at('ConvictionStakingStorage');
  const out: Record<string, Any> = {};
  for (const k of keys) {
    const [n, e] = k.split(':').map((x) => BigInt(x));
    out[k] = { split: await css.isOperatorFeeClaimedForEpoch(n, e), storedNet: big(await css.getNetNodeEpochRewards(n, e)) };
  }
  return out;
}

/** Claim every position as its owner, through the staking NFT; the reward is the cumulative-rewards delta. */
async function claimAll(pos: Any[], tag: string) {
  const snft = await at('DKGStakingConvictionNFT');
  const css = await at('ConvictionStakingStorage');
  const out: Any[] = [];
  for (const p of pos) {
    const owner = await impersonate(p.owner);
    const before = await css.getPosition(p.tokenId);
    const { receipt } = await send(`${tag} claim token ${p.tokenId} (node ${p.node})`, (snft as Any).connect(owner).claim(p.tokenId));
    const after = await css.getPosition(p.tokenId);
    out.push({
      tokenId: p.tokenId,
      node: p.node,
      reward: big(after.cumulativeRewardsClaimed) - big(before.cumulativeRewardsClaimed),
      rawDelta: big(after.raw) - big(before.raw),
      lastClaimedEpoch: big(after.lastClaimedEpoch),
      gasUsed: big(receipt.gasUsed),
    });
  }
  return out;
}

/** coverPublishingCost through the publishing NFT, as KnowledgeAssetsLifecycle (impersonated) calls it. */
async function publishAs(accountId: bigint, agent: string, baseCost: bigint, kaEpochs: bigint, tag: string) {
  const nft = await at('DKGPublishingConvictionNFT');
  const pcs = await at('PublishingConvictionStorage');
  const kal = await impersonate(await addr('KnowledgeAssetsLifecycle'));
  const chronos = await at('Chronos');
  // anvil stamps a block with the wall clock: mine one first, so the views
  // below and the publish read the same billing window and epoch.
  await rpc('evm_mine', []);
  const E = big(await chronos.getCurrentEpoch());
  const discounted = big(await (nft as Any).connect(kal).coverPublishingCost.staticCall(agent, baseCost, E, kaEpochs));
  const { events, receipt } = await send(
    `${tag} publish ${fmt(baseCost)} TRAC base from account ${accountId}`,
    (nft as Any).connect(kal).coverPublishingCost(agent, baseCost, E, kaEpochs),
  );
  // The window and the draws as of the publish's own block.
  const blockTs = BigInt((await ethers.provider.getBlock(receipt.blockNumber))!.timestamp);
  const a = await pcs.getAccount(accountId);
  const w = (blockTs - big(a.createdAtTimestamp)) / big(await chronos.epochLength());
  const prior = { blockTag: receipt.blockNumber - 1 };
  const cc = events.find((e) => e.name === 'CostCovered');
  return {
    epoch: cc ? big(cc.args.epoch) : E,
    window: w,
    discountedCost: discounted,
    windowSpentDelta: big(await pcs.windowSpent(accountId, w)) - big(await pcs.windowSpent(accountId, w, prior)),
    topUpDelta: big(await pcs.topUpBalance(accountId)) - big(await pcs.topUpBalance(accountId, prior)),
    drawnFromEpoch: cc ? big(cc.args.drawnFromEpoch) : undefined,
    drawnFromTopUp: cc ? big(cc.args.drawnFromTopUp) : undefined,
    stakerCredits: stakerCredits(events),
    gasUsed: big(receipt.gasUsed),
  };
}

async function accountsSummary() {
  const nft = await at('DKGPublishingConvictionNFT');
  const pcs = await at('PublishingConvictionStorage');
  const supply = big(await nft.totalSupply());
  const t = await now();
  const out: Any[] = [];
  for (let id = 1n; id <= supply; id++) {
    if (!(await pcs.accountExists(id))) continue;
    const a = await pcs.getAccount(id);
    out.push({
      id,
      owner: await nft.ownerOf(id),
      committed: big(a.committedTRAC),
      createdAtTimestamp: big(a.createdAtTimestamp),
      expiresAtTimestamp: big(a.expiresAtTimestamp),
      lock: big(a.lockDurationEpochs),
      lastSettledWindow: big(a.lastSettledWindow),
      fullySwept: a.fullySwept,
      topUp: big(await pcs.topUpBalance(id)),
      scheduled: big(a.lastSettledWindow) >= big(a.lockDurationEpochs),
      live: t < big(a.expiresAtTimestamp),
      createdBefore1008: Number(a.createdAtTimestamp) * 1000 < Number(live.PublishingConviction.deploymentTimestamp),
    });
  }
  return out;
}

const SCHEDULED_ACCOUNT = BigInt(process.env.SCHEDULED_ACCOUNT ?? '22');

// ---------------------------------------------------------------------------
// PHASE pre — the live contracts (PublishingConviction 10.0.8, StakingV10
// 10.0.4, StakingKPI 10.0.2), inside a snapshot that is reverted
// ---------------------------------------------------------------------------

async function phasePre() {
  const block = await ethers.provider.getBlock('latest');
  const chronos = await at('Chronos');
  const E = big(await chronos.getCurrentEpoch());
  console.log(`Fork block ${block!.number} (ts ${block!.timestamp}), epoch ${E}, epoch length ${await chronos.epochLength()}`);
  const versions: Record<string, string> = {};
  for (const n of ['PublishingConviction', 'StakingV10', 'StakingKPI', 'DKGPublishingConvictionNFT', 'DKGStakingConvictionNFT']) {
    versions[n] = await (await ethers.getContractAt(['function version() view returns (string)'], await addr(n))).version();
  }
  console.log('live versions', versions);

  const pos = await positions();
  const accounts = await accountsSummary();
  const operational = await operationalKeys();
  console.log('operational keys from recent challenges', operational);
  const nodes = [...new Set(pos.map((p) => p.node))].sort((a, b) => Number(a - b));
  const from = pos.reduce((m, p) => (p.lastClaimedEpoch + 1n < m ? p.lastClaimedEpoch + 1n : m), E);

  console.log(`\nStakingKPI ${versions.StakingKPI} nets for nodes ${nodes.join(',')} over epochs ${from}..${E - 1n}`);
  const kpiBefore = await nodeEpochNets(nodes, from, E - 1n, await addr('StakingKPI'));

  const snap = await rpc('evm_snapshot', []);
  console.log(`\nsnapshot ${snap}: the 10.0.8 / 10.0.4 behaviour, then revert`);

  const agent = (await (await at('PublishingConvictionStorage')).getRegisteredAgents(SCHEDULED_ACCOUNT))[0];
  const publish = await publishAs(SCHEDULED_ACCOUNT, agent, 10n * TRAC, 2n, '10.0.8');
  const nft = await at('DKGPublishingConvictionNFT');
  const [anyone] = await ethers.getSigners();
  const settleScheduled = await send(`10.0.8 settle(${SCHEDULED_ACCOUNT})`, (nft as Any).connect(anyone).settle(SCHEDULED_ACCOUNT));
  const expired = accounts.filter((a) => !a.live).map((a) => a.id);
  const settles: Any[] = [];
  for (const id of expired) {
    const { events } = await send(`10.0.8 settle(${id})`, (nft as Any).connect(anyone).settle(id));
    settles.push({ id, stakerCredits: stakerCredits(events), events: events.map((e) => e.name) });
  }
  const claims = await claimAll(pos, '10.0.4');
  const netsAfterOldClaims = await storedNets(Object.keys(kpiBefore));
  await rpc('evm_revert', [snap]);
  console.log(`reverted to ${snap}`);

  save('pre', {
    forkBlock: block!.number,
    forkTimestamp: block!.timestamp,
    epoch: E,
    versions,
    operational,
    positions: pos,
    accounts,
    kpiBefore,
    old: {
      publish,
      settleScheduled: stakerCredits(settleScheduled.events),
      settles,
      claims,
      netsAfterOldClaims,
    },
    txs: txLog,
  });
}

// ---------------------------------------------------------------------------
// PHASE hub — the Hub owner's transaction 998 printed, then the activation
// ---------------------------------------------------------------------------

async function phaseHub() {
  const pre = load('pre');
  const logFile = process.env.DEPLOY_LOG ?? path.join(DIR, 'deploy.log');
  const line = fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .find((l) => l.includes('Hub owner transaction (JSON):'));
  if (!line) throw new Error(`${logFile} holds no "Hub owner transaction (JSON)" line`);
  const hubTx = JSON.parse(line.slice(line.indexOf('{')));
  if (hubTx.to.toLowerCase() !== HUB.toLowerCase()) throw new Error(`the printed transaction is to ${hubTx.to}, not the Hub`);

  const h = await hubContract();
  const ownerAddr = await h.owner();
  const owner = await impersonate(ownerAddr);
  const decoded = h.interface.parseTransaction({ data: hubTx.data });
  const [newContracts, newAssetStorages, reinit, forwards] = decoded.args;
  console.log(
    `Hub.setAndReinitializeContracts: ${newContracts.length} registrations, ${newAssetStorages.length} asset storages, ` +
      `${reinit.length} initialize() calls, ${forwards.reduce((s: number, f: Any) => s + f.encodedData.length, 0)} forwarded calls`,
  );
  const before: Record<string, string> = {};
  for (const c of newContracts) {
    try {
      before[c.name] = await h.getContractAddress(c.name);
    } catch {
      before[c.name] = ethers.ZeroAddress;
    }
  }
  // The activation guard, before the Hub transaction. The storage is not in
  // the Hub yet, so the Hub refuses the forward itself; inside a reverted
  // snapshot, with the pool's contracts registered piecewise, the storage's
  // own guard refuses while either reader is missing.
  const qisNew = newContracts.find((c: Any) => c.name === 'QueryInferenceStorage').addr;
  const qsNew = newContracts.find((c: Any) => c.name === 'QueryInferenceSettlement').addr;
  const cssvcNew = newContracts.find((c: Any) => c.name === 'ConvictionServiceStorage').addr;
  const qisIface = (await ethers.getContractFactory('QueryInferenceStorage')).interface;
  const activateData = (e: bigint) => qisIface.encodeFunctionData('setActivationEpoch', [e]);
  const E0 = big(await (await at('Chronos')).getCurrentEpoch());
  const guards: Record<string, string> = {};
  guards.beforeHubTransaction = await expectRevert(
    'Hub.forwardCall(QueryInferenceStorage, setActivationEpoch) before the Hub transaction',
    h.connect(owner).forwardCall.staticCall(qisNew, activateData(E0 + 1n)),
  );
  check('before the Hub transaction the activation is refused', guards.beforeHubTransaction.startsWith('InvalidTargetContract'), guards.beforeHubTransaction);
  const piecewise = await rpc('evm_snapshot', []);
  const init = (await ethers.getContractFactory('QueryInferenceSettlement')).interface.encodeFunctionData('initialize');
  await (await h.connect(owner).setContractAddress('QueryInferenceStorage', qisNew)).wait();
  guards.storageOnly = await expectRevert(
    'setActivationEpoch with only QueryInferenceStorage registered',
    h.connect(owner).forwardCall.staticCall(qisNew, activateData(E0 + 1n)),
  );
  await (await h.connect(owner).setContractAddress('ConvictionServiceStorage', cssvcNew)).wait();
  await (await h.connect(owner).setContractAddress('QueryInferenceSettlement', qsNew)).wait();
  await (await h.connect(owner).forwardCall(qsNew, init)).wait();
  guards.stakingV10Old = await expectRevert(
    `setActivationEpoch with the settlement registered and StakingV10 ${pre.versions.StakingV10}`,
    h.connect(owner).forwardCall.staticCall(qisNew, activateData(E0 + 1n)),
  );
  await rpc('evm_revert', [piecewise]);
  check('PoolNotWired while the Hub holds no settlement', guards.storageOnly === 'PoolNotWired(QueryInferenceSettlement)', guards.storageOnly);
  check(`PoolNotWired while StakingV10 is ${pre.versions.StakingV10}`, guards.stakingV10Old === 'PoolNotWired(StakingV10)', guards.stakingV10Old);

  const estimate = big(await rpc('eth_estimateGas', [{ from: ownerAddr, to: HUB, data: hubTx.data }]));
  console.log(`estimated gas ${estimate}${estimate > TX_GAS_CAP ? ' ⚠ above the 2^24 transaction gas cap' : ''}`);
  const hubSend = await send('Hub owner: Hub.setAndReinitializeContracts (998)', owner.sendTransaction({ to: HUB, data: hubTx.data }));

  let stateDiff: Any;
  try {
    const trace = await rpc('debug_traceTransaction', [
      hubSend.receipt.hash,
      { tracer: 'prestateTracer', tracerConfig: { diffMode: true } },
    ]);
    const names = new Map<string, string>();
    for (const c of await h.getAllContracts()) names.set(c.addr.toLowerCase(), c.name);
    stateDiff = {};
    for (const [a, post] of Object.entries<Any>(trace.post ?? {})) {
      const slots = Object.keys(post.storage ?? {});
      if (slots.length) stateDiff[names.get(a.toLowerCase()) ?? a] = slots.length;
    }
  } catch (e: Any) {
    stateDiff = `prestateTracer unavailable: ${e.message}`;
  }

  const chronos = await at('Chronos');
  const E = big(await chronos.getCurrentEpoch());
  const qis = await at('QueryInferenceStorage');
  const activation = E + 1n;
  await send(
    `Hub owner: Hub.forwardCall(QueryInferenceStorage, setActivationEpoch(${activation}))`,
    h.connect(owner).forwardCall(await qis.getAddress(), qis.interface.encodeFunctionData('setActivationEpoch', [activation])),
  );

  // The wiring and parameters the rest of the rehearsal depends on.
  console.log('\nAfter the Hub transaction:');
  const v = async (n: string) => (await ethers.getContractAt(['function version() view returns (string)'], await addr(n))).version();
  const versions: Record<string, string> = {};
  for (const n of [
    'ConvictionServiceStorage',
    'ServiceSubscriptions',
    'ServiceSubscriptionsWallet',
    'QueryInferenceStorage',
    'QueryInferenceSettlement',
    'StakingV10Ledger',
    'ConvictionWithdrawalStorage',
    'PublishingConviction',
    'StakingV10',
    'StakingKPI',
  ]) {
    versions[n] = await v(n);
  }
  console.log(versions);
  const qs = await addr('QueryInferenceSettlement');
  const sv10 = await at('StakingV10');
  const kpi = await at('StakingKPI');
  const snft = await at('DKGStakingConvictionNFT');
  const cssvc = await at('ConvictionServiceStorage');
  check('PublishingConviction is 10.2.0', versions.PublishingConviction === '10.2.0');
  check('StakingV10 is 10.1.0', versions.StakingV10 === '10.1.0');
  check('StakingKPI is 10.1.0', versions.StakingKPI === '10.1.0');
  check('StakingV10 reads the settlement and the pool storage from the Hub',
    (await sv10.queryInferenceSettlement()) === qs && (await sv10.queryInferenceStorage()) === (await qis.getAddress()));
  check('the Hub holds StakingV10Ledger and ConvictionWithdrawalStorage, which the ledger wired',
    (await h['isContract(string)']('StakingV10Ledger')) &&
      (await ((await at('StakingV10Ledger')) as Any).withdrawalStorage()) === (await addr('ConvictionWithdrawalStorage')));
  check('StakingKPI reads the settlement from the Hub', (await kpi.queryInferenceSettlement()) === qs);
  check('DKGStakingConvictionNFT re-read StakingV10', (await (snft as Any).stakingV10()) === (await sv10.getAddress()));
  const params = {
    receiptGraceSeconds: big(await qis.receiptGraceSeconds()),
    maxItemsPerBatch: big(await qis.maxItemsPerBatch()),
    maxGroupsPerBatch: big(await qis.maxGroupsPerBatch()),
    maxCloseStepsPerClaim: big(await qis.maxCloseStepsPerClaim()),
    lambdaBps: big(await qis.lambdaBps()),
    latestLambdaBps: big(await qis.latestLambdaBps()),
    latestReceiptGraceSeconds: big(await qis.latestReceiptGraceSeconds()),
    activationEpoch: big(await qis.activationEpoch()),
    closedThrough: big(await qis.closedThrough()),
    maxBucketsPerPeriod: big(await cssvc.maxBucketsPerPeriod()),
  };
  console.log(params);
  check(
    'QueryInferenceStorage holds parameters.json "testnet" (3600, 256, 32, 32, 5000)',
    params.receiptGraceSeconds === 3600n &&
      params.maxItemsPerBatch === 256n &&
      params.maxGroupsPerBatch === 32n &&
      params.maxCloseStepsPerClaim === 32n &&
      params.lambdaBps === 5000n,
  );
  check('ConvictionServiceStorage.maxBucketsPerPeriod is 16', params.maxBucketsPerPeriod === 16n);
  check(`activation epoch ${activation} = current + 1, closedThrough ${E}`, params.activationEpoch === activation && params.closedThrough === E);
  for (const n of ['PublishingConviction', 'StakingV10', 'StakingKPI']) {
    check(`the old ${n} ${pre.versions[n]} left the Hub's contract set`, !(await h['isContract(address)'](live[n].evmAddress)));
  }

  save('hub', {
    guards,
    hubTransaction: {
      to: hubTx.to,
      dataBytes: (hubTx.data.length - 2) / 2,
      registrations: newContracts.map((c: Any) => ({ name: c.name, addr: c.addr, was: before[c.name] })),
      initializeCalls: reinit.length,
      forwardedCalls: forwards.map((f: Any) => ({ contract: f.contractName, calls: f.encodedData.length })),
      estimate,
    },
    stateDiff,
    epochAtActivation: E,
    activation,
    versions,
    params,
    txs: txLog,
    checks,
  });
}

// ---------------------------------------------------------------------------
// PHASE existing — accounts and positions created before the upgrade
// ---------------------------------------------------------------------------

async function phaseExisting() {
  const pre = load('pre');
  const chronos = await at('Chronos');
  const E = big(await chronos.getCurrentEpoch());
  if (E !== big(pre.epoch)) console.log(`⚠ epoch moved from ${pre.epoch} to ${E}; comparisons assume the same epoch`);
  const [anyone] = await ethers.getSigners();
  const pc = await at('PublishingConviction');
  const ss = await at('ServiceSubscriptions');
  const nft = await at('DKGPublishingConvictionNFT');

  console.log(`\nScheduled account ${SCHEDULED_ACCOUNT} (10.0.8 schedule) on PublishingConviction 10.2.0:`);
  const agent = (await (await at('PublishingConvictionStorage')).getRegisteredAgents(SCHEDULED_ACCOUNT))[0];
  const publish = await publishAs(SCHEDULED_ACCOUNT, agent, 10n * TRAC, 2n, '10.2.0');
  const old = pre.old.publish;
  check(
    'a scheduled account publishes as before: same discounted cost, same window and top-up draws, same staker credits',
    String(publish.discountedCost) === old.discountedCost &&
      String(publish.windowSpentDelta) === old.windowSpentDelta &&
      String(publish.topUpDelta) === old.topUpDelta &&
      JSON.stringify(jsonable(publish.stakerCredits)) === JSON.stringify(old.stakerCredits),
    `cost ${fmt(publish.discountedCost)}, window +${fmt(publish.windowSpentDelta)}, top-up ${fmt(publish.topUpDelta)}, credits ${publish.stakerCredits.length}`,
  );
  const settled = await send(`10.2.0 settle(${SCHEDULED_ACCOUNT})`, (pc as Any).connect(anyone).settle(SCHEDULED_ACCOUNT));
  check('settle books nothing for the scheduled account', stakerCredits(settled.events).length === 0);
  const ownerOf = await impersonate(await nft.ownerOf(SCHEDULED_ACCOUNT));
  const refused = await expectRevert(
    `setServiceSpending(${SCHEDULED_ACCOUNT}, true) by its owner`,
    (ss as Any).connect(ownerOf).setServiceSpending.staticCall(SCHEDULED_ACCOUNT, true),
  );
  check('service spending is refused for the scheduled account', refused.startsWith('EmissionAlreadyScheduled'), refused);

  console.log('\nsettleMany over the expired accounts:');
  const expired = pre.accounts.filter((a: Any) => !a.live).map((a: Any) => BigInt(a.id));
  const many = await send(`settleMany(${expired.length} expired accounts)`, (pc as Any).connect(anyone).settleMany(expired));
  const swept = many.events.filter((e) => e.name === 'AccountFinalSwept').map((e) => ({ id: big(e.args.accountId), topUp: big(e.args.topUpSwept ?? e.args[1]) }));
  const credits = stakerCredits(many.events);
  const oldCredits = pre.old.settles.flatMap((s: Any) => s.stakerCredits.map((c: Any) => BigInt(c.amount)));
  check(
    'settleMany books what 10.0.8 settle booked, account by account',
    sum(credits.map((c) => c.amount)) === sum(oldCredits) && credits.length === oldCredits.length,
    `${fmt(sum(credits.map((c) => c.amount)))} TRAC in ${credits.length} credits (10.0.8: ${fmt(sum(oldCredits))} in ${oldCredits.length})`,
  );
  const before1008 = pre.accounts.filter((a: Any) => a.createdBefore1008).map((a: Any) => String(a.id));
  console.log(`accounts created before 10.0.8: ${before1008.join(', ') || 'none'}`);

  console.log('\nStakingV10 10.0.4 positions, claimed on 10.1.0:');
  const pos = await positions();
  // The longest unclaimed history: the position with the most unclaimed
  // epochs in which its node scored. `_claim` walks every one of them in one
  // transaction, so its gas limit is what EIP-7825's cap is measured against.
  const rssC = await at('RandomSamplingStorage');
  const history: Any[] = [];
  for (const p of pos) {
    let scored = 0n;
    for (let e = p.lastClaimedEpoch + 1n; e <= E - 1n; e++) {
      if (big(await rssC.getEpochLastScorePerStake(p.node, e)) > 0n) scored++;
    }
    history.push({ tokenId: p.tokenId, node: p.node, unclaimedEpochs: E - 1n - p.lastClaimedEpoch, scoredEpochs: scored });
  }
  const longest = history.reduce((a, b) => (b.scoredEpochs > a.scoredEpochs ? b : a));
  const snftC = await at('DKGStakingConvictionNFT');
  const snftAddr = await snftC.getAddress();
  // Every position's claim as the first on its node, which splits each epoch's
  // operator fee and so costs the most, and the longest history's withdrawal
  // (its claim, then the record of the epoch in progress): gas used and the
  // smallest gas limit, each in reverted snapshots.
  console.log(`\nfirst-claim gas of every position, and the withdrawal of token ${longest.tokenId}, against 2^24 = ${TX_GAS_CAP}:`);
  const firstClaims: Any[] = [];
  for (const h of history) {
    const owner = pos.find((p) => p.tokenId === h.tokenId)!.owner;
    await impersonate(owner);
    const m = await measureTx(owner, snftAddr, snftC.interface.encodeFunctionData('claim', [h.tokenId]));
    firstClaims.push({ ...h, ...m });
    console.log(
      `  token ${h.tokenId} (node ${h.node}): ${h.scoredEpochs} scored epochs, gas used ${m.gasUsed}, ` +
        `smallest limit ${m.minGasLimit}, margin to 2^24 ${m.marginTo2pow24}`,
    );
  }
  const longestOwner = pos.find((p) => p.tokenId === longest.tokenId)!.owner;
  await impersonate(longestOwner);
  const longestWithdraw = await measureTx(longestOwner, snftAddr, snftC.interface.encodeFunctionData('withdraw', [longest.tokenId]));
  console.log(
    `  withdraw token ${longest.tokenId}: gas used ${longestWithdraw.gasUsed}, smallest limit ${longestWithdraw.minGasLimit}, ` +
      `margin to 2^24 ${longestWithdraw.marginTo2pow24}`,
  );
  const longestLimit = firstClaims.find((c) => c.tokenId === longest.tokenId)!.minGasLimit;
  check(
    'every first claim and the longest withdrawal fit 2^24',
    firstClaims.every((c) => c.minGasLimit <= TX_GAS_CAP) && longestWithdraw.minGasLimit <= TX_GAS_CAP,
  );
  const claims = await claimAll(pos, '10.1.0');
  for (const c of claims) {
    const o = pre.old.claims.find((x: Any) => String(x.tokenId) === String(c.tokenId));
    check(
      `token ${c.tokenId}: the 10.1.0 claim pays what the 10.0.4 claim paid`,
      o && String(c.reward) === o.reward && String(c.lastClaimedEpoch) === o.lastClaimedEpoch,
      `${fmt(c.reward)} TRAC, through epoch ${c.lastClaimedEpoch}; gas ${c.gasUsed} (10.0.4: ${o?.gasUsed})`,
    );
  }
  const nets = await storedNets(Object.keys(pre.kpiBefore));
  let same = 0;
  let diff: string[] = [];
  for (const [k, v] of Object.entries<Any>(nets)) {
    const kb = pre.kpiBefore[k];
    if (String(v.storedNet) === kb.kpiNet) same++;
    else diff.push(`${k}: kpi ${kb.kpiNet} stored ${v.storedNet}`);
  }
  check(
    'every node-epoch net the claims split equals the StakingKPI 10.0.2 preview from before the upgrade',
    diff.length === 0,
    `${same} node-epochs equal${diff.length ? `; differing: ${diff.slice(0, 5).join('; ')}` : ''}`,
  );

  const longestClaim = claims.find((c) => c.tokenId === longest.tokenId)!;
  check(
    `the longest history's claim fits EIP-7825's 2^24 transaction gas cap`,
    longestLimit <= TX_GAS_CAP,
    `gas used ${longestClaim.gasUsed}, smallest gas limit ${longestLimit}, ${(Number(longestClaim.gasUsed) / Number(longest.scoredEpochs)).toFixed(0)} gas per scored epoch`,
  );
  save('existing', {
    epoch: E,
    publish,
    refused,
    settleMany: { swept, credits, gasUsed: big(many.receipt.gasUsed) },
    history,
    firstClaims,
    longest: { ...longest, gasUsed: longestClaim.gasUsed, minGasLimit: longestLimit, withdraw: longestWithdraw },
    claims,
    nets,
    txs: txLog,
    checks,
  });
}

// ---------------------------------------------------------------------------
// PHASE cycle — one full marketplace cycle
// ---------------------------------------------------------------------------

const REQUEST_TYPES = {
  ServiceRequest: [
    { name: 'subscriptionId', type: 'bytes32' },
    { name: 'bucketId', type: 'bytes32' },
    { name: 'seller', type: 'uint72' },
    { name: 'nonce', type: 'uint64' },
    { name: 'acceptedAskWeiPerUnit', type: 'uint96' },
    { name: 'maxUnits', type: 'uint64' },
    { name: 'maxValueWei', type: 'uint96' },
    { name: 'issuedAt', type: 'uint40' },
    { name: 'expiry', type: 'uint40' },
  ],
};
const ASSIGNMENT_TYPES = {
  ServiceAssignment: [
    { name: 'accountId', type: 'uint256' },
    { name: 'assignee', type: 'address' },
    { name: 'maxCostPerPeriod', type: 'uint96' },
    { name: 'expiresAt', type: 'uint40' },
    { name: 'nonce', type: 'uint64' },
  ],
};
const subscriptionIdOf = (buyer: string, epoch: bigint) =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [buyer, epoch]));

/** Requests of one bucket signed by the period's session key (eth_signTypedData_v4 on anvil), as batch items. */
async function signedItems(o: {
  domain: Any;
  session: Any;
  subscriptionId: string;
  bucketId: string;
  seller: bigint;
  firstNonce: bigint;
  values: bigint[];
  issuedAt: bigint;
}) {
  const items: Any[] = [];
  for (let i = 0; i < o.values.length; i++) {
    const units = o.values[i] / UNIT_ASK;
    const r = {
      subscriptionId: o.subscriptionId,
      bucketId: o.bucketId,
      seller: o.seller,
      nonce: o.firstNonce + BigInt(i),
      acceptedAskWeiPerUnit: UNIT_ASK,
      maxUnits: units,
      maxValueWei: units * UNIT_ASK,
      issuedAt: o.issuedAt,
      expiry: o.issuedAt + DAY,
    };
    const sig = ethers.Signature.from(await o.session.signTypedData(o.domain, REQUEST_TYPES, r));
    items.push({
      nonce: r.nonce,
      acceptedAskWeiPerUnit: r.acceptedAskWeiPerUnit,
      maxUnits: r.maxUnits,
      maxValueWei: r.maxValueWei,
      issuedAt: r.issuedAt,
      expiry: r.expiry,
      units,
      valueWei: units * UNIT_ASK,
      resultCommitment: ethers.keccak256(ethers.toUtf8Bytes(`result ${o.subscriptionId} ${o.seller} ${r.nonce}`)),
      completedAt: r.issuedAt,
      sigR: sig.r,
      sigVS: sig.yParityAndS,
    });
  }
  return items;
}

/**
 * FORK-ONLY SHORTCUT. Write `node`'s score for the current epoch as a valid
 * proof does (RandomSampling.submitProof's writes), through the contract the
 * Hub holds as RandomSampling, impersonated: no proof can be produced on a fork.
 */
async function writeProofScore(node: bigint, score18: bigint) {
  const rsSigner = await impersonate(await addr('RandomSampling'));
  const rss = (await at('RandomSamplingStorage')).connect(rsSigner) as Any;
  const css = (await at('ConvictionStakingStorage')).connect(rsSigner) as Any;
  const e = big(await (await at('Chronos')).getCurrentEpoch());
  await send(`fork-only: CSS.settleNodeTo(${node}) as RandomSampling`, css.settleNodeTo(node, await now()));
  const eff = big(await css.getNodeRunningEffectiveStake(node));
  await send(`fork-only: proof count ${node}@${e}`, rss.incrementEpochNodeValidProofsCount(e, node));
  await send(`fork-only: proof-period score ${node}@${e}`, rss.addToNodeEpochProofPeriodScore(e, big(await rss.getActiveProofPeriodStartBlock()), node, score18));
  await send(`fork-only: node score ${node}@${e}`, rss.addToNodeEpochScore(e, node, score18));
  await send(`fork-only: all-nodes score @${e}`, rss.addToAllNodesEpochScore(e, score18));
  const last = big(await rss.getEpochLastScorePerStake(node, e));
  const tsNow = await now();
  await send(`fork-only: score-per-stake checkpoint ${node}@${e}`, rss.appendCheckpoint(node, e, tsNow, last + (score18 * TRAC) / eff));
}

/** The reward `_claim` pays position `p` for epochs `from..to`, from views, for a position whose boost has expired. */
async function expectedReward(p: Any, from: bigint, to: bigint, nets: Record<string, bigint>) {
  const rss = await at('RandomSamplingStorage');
  const css = await at('ConvictionStakingStorage');
  const pos = await css.getPosition(p.tokenId);
  const raw = big(pos.raw);
  const key = ethers.zeroPadValue(ethers.toBeHex(p.tokenId), 32);
  let total = 0n;
  const per: Record<string, bigint> = {};
  for (let e = from; e <= to; e++) {
    const cur = big(await rss.getEpochLastScorePerStake(p.node, e));
    if (cur === 0n) continue;
    const settled = big(await rss.getEpochNodeDelegatorScore(e, p.node, key));
    const last = big(await rss.getDelegatorLastSettledNodeEpochScorePerStake(e, p.node, key));
    const d = settled + (cur > last ? (raw * (cur - last)) / TRAC : 0n);
    const nodeScore = big(await rss.getNodeEpochScore(e, p.node));
    const net = nets[`${p.node}:${e}`] ?? 0n;
    const r = nodeScore === 0n || d === 0n ? 0n : (d * net) / nodeScore;
    per[String(e)] = r;
    total += r;
  }
  return { total, per };
}

async function phaseCycle() {
  const pre = load('pre');
  const hubState = load('hub');
  const chronos = await at('Chronos');
  const signers = await ethers.getSigners();
  const [, walletBuyer, caOwner, buyerKey, caSession, agent, keeper, walletSession, nodeAdmin, lateOwner] = signers;
  const token = await at('Token');
  const vault = await addr('ConvictionStakingStorage');
  const nft = await at('DKGPublishingConvictionNFT');
  const pc = await at('PublishingConviction');
  const pcs = await at('PublishingConvictionStorage');
  const ss = await at('ServiceSubscriptions');
  const ssw = await at('ServiceSubscriptionsWallet');
  const qis = await at('QueryInferenceStorage');
  const qs = await at('QueryInferenceSettlement');
  const cssvc = await at('ConvictionServiceStorage');
  const css = await at('ConvictionStakingStorage');
  const rss = await at('RandomSamplingStorage');
  const kpi = await at('StakingKPI');
  const snft = await at('DKGStakingConvictionNFT');
  const es = await ethers.getContractAt('EpochStorage', await addr('EpochStorageV8'));
  const A = big(hubState.activation);
  const E0 = A - 1n;
  const out: Any = { activation: A };

  // Scores of the last full epoch before the fork, per active node, mirrored into the cycle's epochs.
  const operational: Record<string, string> = pre.operational;
  const activeNodes = Object.keys(operational).map((n) => BigInt(n));
  const mirror: Record<string, bigint> = {};
  for (const n of activeNodes) mirror[String(n)] = big(await rss.getNodeEpochScore(E0 - 1n, n));
  out.mirroredScores = mirror;

  // ---- epoch A: an operator fee, funding, publishing, serving ----
  await warpTo(big(await chronos.timestampForEpoch(A)) + 120n);
  console.log(`\nEpoch ${await chronos.getCurrentEpoch()} (activation ${A}): the first seller's operator fee`);
  // Every testnet node charges 0 %, so the first seller's admin sets 10 % for
  // A + 1, the pool epoch, through Profile.updateOperatorFee. FORK-ONLY: the
  // admin is an anvil account added as an admin key of the node through the
  // contract the Hub holds as Identity (impersonated); the node's own admin
  // keys are not known here.
  const feeNode = SELLERS[0];
  const OPERATOR_FEE = 1_000n; // 10 % of maxOperatorFee 10,000
  const identity = await impersonate(await addr('Identity'));
  await send(
    `fork-only: an admin key for node ${feeNode}, added as Identity`,
    ((await at('IdentityStorage')) as Any)
      .connect(identity)
      .addKey(feeNode, ethers.keccak256(ethers.solidityPacked(['address'], [nodeAdmin.address])), 1, 1),
  );
  // updateOperatorFee needs the previous epoch's operator fee split, which any claim on the node does.
  const firstPos = (await positions()).find((p: Any) => p.node === feeNode)!;
  const splitOwner = await impersonate(firstPos.owner);
  await send(`token ${firstPos.tokenId} owner: claim (splits epoch ${A - 1n} on node ${feeNode})`, (snft as Any).connect(splitOwner).claim(firstPos.tokenId));
  const feeBalance0 = big(await css.getOperatorFeeBalance(feeNode));
  await send(`node ${feeNode} admin: Profile.updateOperatorFee(${OPERATOR_FEE})`, ((await at('Profile')) as Any).connect(nodeAdmin).updateOperatorFee(feeNode, OPERATOR_FEE));
  const ps = await at('ProfileStorage');
  check(
    `node ${feeNode}'s 10 % fee applies to epoch ${A + 1n} and not to ${A}`,
    big(await ps.getOperatorFeePercentageByTimestampReverse(feeNode, big(await chronos.timestampForEpoch(A + 2n)) - 1n)) === OPERATOR_FEE &&
      big(await ps.getOperatorFeePercentageByTimestampReverse(feeNode, big(await chronos.timestampForEpoch(A + 1n)) - 1n)) === 0n,
  );

  console.log(`\nEpoch ${await chronos.getCurrentEpoch()}: funding`);
  const owner = await impersonate(await (await hubContract()).owner());
  await send('fork-only: Hub owner sends TRAC to the wallet buyer', (token as Any).connect(owner).transfer(walletBuyer.address, 100n * TRAC));
  await send('fork-only: Hub owner sends TRAC to the account owner', (token as Any).connect(owner).transfer(caOwner.address, COMMITTED));
  await send('fork-only: Hub owner sends TRAC to a second account owner', (token as Any).connect(owner).transfer(lateOwner.address, LATE_COMMITTED));
  const vault0 = big(await token.balanceOf(vault));

  // A wallet-funded period.
  await send('wallet buyer: approve ServiceSubscriptionsWallet', (token as Any).connect(walletBuyer).approve(await ssw.getAddress(), WALLET_PERIOD_VALUE));
  const bucket0 = ethers.toBeHex(1, 32);
  const walletFund = await send(
    `wallet buyer: fundFromWallet(epoch ${A}, ${fmt(WALLET_PERIOD_VALUE)} TRAC)`,
    (ssw as Any).connect(walletBuyer).fundFromWallet({
      epoch: A,
      sessionKey: walletSession.address,
      planDigest: ethers.id('rehearsal wallet plan'),
      buckets: [{ bucketId: bucket0, serviceClass: CLASS_INFERENCE, value: WALLET_PERIOD_VALUE, maxAskWeiPerUnit: PRICE_CAP }],
    }),
  );
  const walletPeriod = subscriptionIdOf(walletBuyer.address, A);

  // A new 10.2.0 Conviction Account: create, opt in, assign a buyer key, fund a period from it.
  await send('account owner: approve the publishing NFT', (token as Any).connect(caOwner).approve(await nft.getAddress(), COMMITTED));
  const created = await send(`account owner: createAccount(${fmt(COMMITTED)} TRAC)`, (nft as Any).connect(caOwner).createAccount(COMMITTED, 0));
  const accountId = big(created.events.find((e) => e.name === 'AccountCreated')!.args.accountId);
  const acct = await pcs.getAccount(accountId);
  const B = COMMITTED / big(acct.lockDurationEpochs);
  out.account = { accountId, discountBps: big(acct.discountBps), lock: big(acct.lockDurationEpochs), B, createdAtTimestamp: big(acct.createdAtTimestamp) };
  check('createAccount books nothing to the staker pool (10.2.0)', stakerCredits(created.events).length === 0);
  await send(`account owner: setServiceSpending(${accountId}, true)`, (ss as Any).connect(caOwner).setServiceSpending(accountId, true));
  const terms = {
    accountId,
    assignee: buyerKey.address,
    maxCostPerPeriod: 1_000n * TRAC,
    expiresAt: big(acct.expiresAtTimestamp),
    nonce: big(await cssvc.assignmentNonce(accountId)),
  };
  const ssDomain = { name: 'DKGConvictionServices', version: '1', chainId: 84532n, verifyingContract: await ss.getAddress() };
  const consent = await buyerKey.signTypedData(ssDomain, ASSIGNMENT_TYPES, terms);
  await send('account owner: assign the buyer key (the key consents by EIP-712 signature)', (ss as Any).connect(caOwner).assign(terms, '0x', consent));
  const caFund = await send(
    `buyer key: fundFromConviction(account ${accountId}, epoch ${A}, ${fmt(CA_PERIOD_VALUE)} TRAC value)`,
    (ss as Any).connect(buyerKey).fundFromConviction({
      accountId,
      epoch: A,
      sessionKey: caSession.address,
      planDigest: ethers.id('rehearsal account plan'),
      buckets: [{ bucketId: bucket0, serviceClass: CLASS_INFERENCE, value: CA_PERIOD_VALUE, maxAskWeiPerUnit: PRICE_CAP }],
    }),
  );
  const caPeriod = subscriptionIdOf(buyerKey.address, A);
  const cost = big(caFund.events.find((e) => e.name === 'PeriodFunded')!.args.cost);
  check('the account period books no staker credit and moves no TRAC', stakerCredits(caFund.events).length === 0 && !caFund.events.some((e) => e.name === 'Transfer'));
  check(
    `the period's cost is the value at the account's discount (${fmt(cost)} TRAC)`,
    cost === (CA_PERIOD_VALUE * (10_000n - big(acct.discountBps))) / 10_000n,
  );

  // A second 10.2.0 account, which nothing touches until the late-booking phase.
  await send('second account owner: approve the publishing NFT', (token as Any).connect(lateOwner).approve(await nft.getAddress(), LATE_COMMITTED));
  const lateCreated = await send(`second account owner: createAccount(${fmt(LATE_COMMITTED)} TRAC)`, (nft as Any).connect(lateOwner).createAccount(LATE_COMMITTED, 0));
  const lateId = big(lateCreated.events.find((e) => e.name === 'AccountCreated')!.args.accountId);
  const lateAcct = await pcs.getAccount(lateId);
  out.lateAccount = { accountId: lateId, committed: LATE_COMMITTED, createdAtTimestamp: big(lateAcct.createdAtTimestamp), lock: big(lateAcct.lockDurationEpochs) };

  // A publish from the account.
  await send('account owner: registerAgent', (nft as Any).connect(caOwner).registerAgent(accountId, agent.address));
  const publish = await publishAs(accountId, agent.address, PUBLISH_BASE_COST, PUBLISH_KA_EPOCHS, 'fork-only (KnowledgeAssetsLifecycle impersonated):');
  check(
    'a use-time publish books its whole draw to the staker pool over the Knowledge Asset epochs',
    sum(publish.stakerCredits.map((c: Any) => c.amount)) === publish.discountedCost &&
      publish.stakerCredits.every((c: Any) => c.start >= A && c.end <= A + PUBLISH_KA_EPOCHS),
    `${fmt(publish.discountedCost)} TRAC over ${JSON.stringify(jsonable(publish.stakerCredits))}`,
  );
  out.funding = { walletPeriod, caPeriod, walletValue: WALLET_PERIOD_VALUE, caValue: CA_PERIOD_VALUE, cost, publish };
  check(
    `due in epoch ${A + 1n}: wallet ${fmt(WALLET_PERIOD_VALUE)} and account cost ${fmt(cost)}`,
    (await qis.dueIn(A + 1n)).toString() === [WALLET_PERIOD_VALUE, cost].toString(),
  );

  // Serving: requests signed by each period's session key, receipts submitted by real Core Nodes.
  const qiDomain = { name: 'DKGQueryInference', version: '1', chainId: 84532n, verifyingContract: await qis.getAddress() };
  const issuedAt = await now();
  const plan: Record<string, { ca: bigint[]; wallet: bigint[] }> = {
    // The account bucket is claimed above its cap (8 of 7), the wallet bucket
    // below it (3 of 5): the epoch's money is 12, its served value 10.
    [String(SELLERS[0])]: { ca: [2n * TRAC, 2n * TRAC], wallet: [2n * TRAC] },
    [String(SELLERS[1])]: { ca: [4n * TRAC], wallet: [1n * TRAC] },
  };
  out.batches = [];
  for (const seller of SELLERS) {
    const op = operational[String(seller)];
    if (!op) throw new Error(`no operational key seen for node ${seller}`);
    const groups = [
      {
        subscriptionId: caPeriod,
        bucketIndex: 0,
        items: await signedItems({ domain: qiDomain, session: caSession, subscriptionId: caPeriod, bucketId: bucket0, seller, firstNonce: 0n, values: plan[String(seller)].ca, issuedAt }),
      },
      {
        subscriptionId: walletPeriod,
        bucketIndex: 0,
        items: await signedItems({ domain: qiDomain, session: walletSession, subscriptionId: walletPeriod, bucketId: bucket0, seller, firstNonce: 0n, values: plan[String(seller)].wallet, issuedAt }),
      },
    ];
    const opSigner = await impersonate(op);
    const b = await send(`node ${seller} operational key: submitReceiptBatch (2 groups)`, (qs as Any).connect(opSigner).submitReceiptBatch(groups));
    const acc = b.events.find((e) => e.name === 'ReceiptBatchAccepted')!;
    out.batches.push({ seller, items: big(acc.args.itemCount), value: big(acc.args.value), stakeFactor18: big(acc.args.stakeFactor18), gasUsed: big(b.receipt.gasUsed) });
  }
  out.fundedCap = { ca: big(await qs.fundedCap(caPeriod, 0)), wallet: big(await qs.fundedCap(walletPeriod, 0)) };

  // FORK-ONLY: the active nodes keep scoring in epoch A, as they scored before the fork.
  for (const n of activeNodes) await writeProofScore(n, mirror[String(n)]);

  // ---- epoch A + 1: finalization after the deadline ----
  const deadline = big(await chronos.timestampForEpoch(A + 1n)) + big(await qis.receiptGraceSecondsAt(A));
  await warpTo(deadline + 1n);
  console.log(`\nEpoch ${await chronos.getCurrentEpoch()}: finalization (deadline ${deadline})`);
  for (const n of activeNodes) await writeProofScore(n, mirror[String(n)]);
  const refs = SELLERS.flatMap((seller) => [
    { subscriptionId: caPeriod, bucketIndex: 0, seller },
    { subscriptionId: walletPeriod, bucketIndex: 0, seller },
  ]);
  const fin = await send('keeper: finalizeClaims (4 claims)', (qs as Any).connect(keeper).finalizeClaims(refs));
  out.finalized = fin.events.filter((e) => e.name === 'ClaimsFinalized').map((e) => ({
    sub: e.args.subscriptionId === caPeriod ? 'account' : 'wallet',
    seller: big(e.args.seller),
    claimed: big(e.args.claimed),
    value: big(e.args.value),
    score: big(e.args.score),
  }));
  out.skipped = fin.events.filter((e) => e.name === 'ClaimSkipped').map((e) => jsonable(e.args));
  check('all four claims finalized', out.finalized.length === 4 && out.skipped.length === 0);
  const caFinal = sum(out.finalized.filter((f: Any) => f.sub === 'account').map((f: Any) => f.value));
  check(`the account bucket's claims shrank to its funded cap ${fmt(out.fundedCap.ca)}`, caFinal <= out.fundedCap.ca && caFinal >= out.fundedCap.ca - 2n);

  // A withdrawal in the middle of A + 1: the smallest position of the first
  // seller, a real delegator of a real node. Its score in A + 1, the epoch in
  // progress, up to the withdrawal, is recorded and paid by
  // claimWithdrawnEpoch once A + 1 ends, as a position holding that score is
  // paid at the epoch's end. The node proves once more after the withdrawal,
  // and the withdrawn stake takes no share of that proof.
  await warpTo(big(await chronos.timestampForEpoch(A + 1n)) + big(await chronos.epochLength()) / 2n);
  const w = (await positions()).filter((p: Any) => p.node === SELLERS[0]).sort((a: Any, b: Any) => (a.raw < b.raw ? -1 : 1))[0];
  const wKey = ethers.zeroPadValue(ethers.toBeHex(w.tokenId), 32);
  // The score a position staying to the end of A + 1 holds in it, from views:
  // what `_claim` integrates for an epoch after the position's boost expired.
  const cur = big(await rss.getEpochLastScorePerStake(w.node, A + 1n));
  const lastSettled = big(await rss.getDelegatorLastSettledNodeEpochScorePerStake(A + 1n, w.node, wKey));
  const settledScore = big(await rss.getEpochNodeDelegatorScore(A + 1n, w.node, wKey));
  const rawBefore = big((await css.getPosition(w.tokenId)).raw);
  const stayed = settledScore + (cur > lastSettled ? (rawBefore * (cur - lastSettled)) / TRAC : 0n);
  // Real nodes keep proving after a withdrawal. The counterfactual, in a
  // reverted snapshot: the node's next proof with the position still staked.
  const counterfactual = await rpc('evm_snapshot', []);
  await writeProofScore(w.node, mirror[String(w.node)]);
  const curStaying = big(await rss.getEpochLastScorePerStake(w.node, A + 1n));
  const stayedThroughLaterProof = settledScore + (rawBefore * (curStaying - lastSettled)) / TRAC;
  await rpc('evm_revert', [counterfactual]);
  const wOwner = await impersonate(w.owner);
  const ownerBal = big(await token.balanceOf(w.owner));
  const wd = await send(`token ${w.tokenId} owner: withdraw in the middle of epoch ${A + 1n}`, (snft as Any).connect(wOwner).withdraw(w.tokenId));
  const paidOut = big(await token.balanceOf(w.owner)) - ownerBal;
  const withdrawnEv = wd.events.find((e) => e.name === 'Withdrawn')!;
  const recordedEv = wd.events.find((e) => e.name === 'WithdrawnEpochRecorded');
  const recordedScore = big(await rss.getEpochNodeDelegatorScore(A + 1n, w.node, wKey));
  check(`the withdrawal pays the position's whole raw stake, rewards compounded (${fmt(paidOut)} TRAC)`, paidOut === big(withdrawnEv.args.amount));
  check(
    `the withdrawal records epoch ${A + 1n} for the staker, with the position's score up to the withdrawal`,
    !!recordedEv && big(recordedEv.args.epoch) === A + 1n && recordedEv.args.staker === w.owner && recordedScore === stayed && stayed > 0n,
    `score ${recordedScore}`,
  );
  check(`node ${SELLERS[0]} stays in the sharding table`, await (await at('ShardingTableStorage')).nodeExists(SELLERS[0]));
  // FORK-ONLY: the node's next proof in A + 1, after the withdrawal. The
  // withdrawn position's recorded score must not take any of it.
  await writeProofScore(w.node, mirror[String(w.node)]);
  check(
    `a proof after the withdrawal leaves the recorded score of epoch ${A + 1n} as it was`,
    big(await rss.getEpochNodeDelegatorScore(A + 1n, w.node, wKey)) === recordedScore,
  );
  check(
    'a position that had stayed through that proof would hold more score, by its share of the proof',
    stayedThroughLaterProof > stayed,
    `${stayedThroughLaterProof} staying vs ${stayed} withdrawn`,
  );
  const sv10 = await at('StakingV10');
  const early = await expectRevert(
    `claimWithdrawnEpoch(${w.tokenId}) before epoch ${A + 1n} ends`,
    (sv10 as Any).connect(keeper).claimWithdrawnEpoch.staticCall(w.tokenId),
  );
  check('the withdrawn epoch cannot be claimed before it ends', early.startsWith('WithdrawnEpochInProgress'), early);
  out.withdrawal = {
    tokenId: w.tokenId,
    node: w.node,
    amount: paidOut,
    gasUsed: big(wd.receipt.gasUsed),
    recordedScore,
    stayedThroughLaterProof,
    epoch: A + 1n,
  };

  // ---- epoch A + 2: close, claims, withdrawal, window booking ----
  await warpTo(big(await chronos.timestampForEpoch(A + 2n)) + 120n);
  const E3 = big(await chronos.getCurrentEpoch());
  console.log(`\nEpoch ${E3}: close and pay`);
  const previewPool = await qs.previewEpochClose(A + 1n);
  const kpiPreview: Record<string, bigint> = {};
  for (const p of await positions()) {
    for (let e = E0; e <= A + 1n; e++) kpiPreview[`${p.node}:${e}`] ??= big(await kpi.getNetNodeRewards(p.node, e));
  }
  const closed = await send('keeper: closeEpochs(10)', (qs as Any).connect(keeper).closeEpochs(10));
  out.closes = closed.events.filter((e) => e.name === 'EpochClosed').map((e) => ({
    epoch: big(e.args.epoch),
    walletDue: big(e.args.walletDue),
    convictionDue: big(e.args.convictionDue),
    carryIn: big(e.args.carryIn),
    pool: big(e.args.pool),
    sumR: big(e.args.sumR),
    sumScore: big(e.args.sumScore),
    lambdaBps: big(e.args.lambdaBps),
  }));
  const pool = big(await qs.epochPool(A + 1n));
  check(`the close of ${A + 1n} pools the wallet value and the account cost (${fmt(pool)} TRAC)`, pool === WALLET_PERIOD_VALUE + cost);
  check('the previewed close equals the close', big(previewPool[0]) === pool);
  const gross: Record<string, bigint> = {};
  for (const n of SELLERS) gross[String(n)] = big(await qs.queryInferenceGross(A + 1n, n));
  const grossSum = sum(Object.values(gross));
  check('the sellers\' query/inference gross adds up to the pool, less floor dust', grossSum <= pool && pool - grossSum <= 4n, `${Object.entries(gross).map(([n, g]) => `node ${n} ${fmt(g)}`).join(', ')}; dust ${pool - grossSum} wei`);

  // The unused share of each closed epoch: its money less the receipt value
  // finalized in it. The whole money is the pool once any value is finalized.
  out.unused = out.closes.map((c: Any) => {
    const money = c.walletDue + c.convictionDue + c.carryIn;
    return { epoch: c.epoch, money, served: c.sumR, unused: money - c.sumR, pool: c.pool };
  });
  console.log('  unused share per closed epoch (money = walletDue + convictionDue + carryIn, served = sumR):');
  for (const u of out.unused) console.log(`    epoch ${u.epoch}: money ${fmt(u.money)}, served ${fmt(u.served)}, unused ${fmt(u.unused)}, pool ${fmt(u.pool)}`);
  check(
    `epoch ${A + 1n}: 2 TRAC of the 12 went unserved, and the pool is the whole money`,
    out.unused.some((u: Any) => u.epoch === A + 1n && u.money === 12n * TRAC && u.served === 10n * TRAC && u.unused === 2n * TRAC && u.pool === 12n * TRAC),
  );

  const cyclePositions = (await positions()).filter((p: Any) => SELLERS.includes(p.node));

  // The emergency switch, inside a reverted snapshot: with the settlement out
  // of the Hub, a claim and a withdrawal go through and pay the publishing pool
  // alone.
  {
    const snap = await rpc('evm_snapshot', []);
    const h = await hubContract();
    await send('Hub owner: removeContractByName("QueryInferenceSettlement") (in a snapshot)', h.connect(owner).removeContractByName('QueryInferenceSettlement'));
    const n1 = SELLERS[1];
    const noPool: Record<string, bigint> = { ...kpiPreview };
    noPool[`${n1}:${A + 1n}`] = big(await kpi.getNetNodeRewards(n1, A + 1n));
    const fee1 = big(await ps.getOperatorFeePercentageByTimestampReverse(n1, big(await chronos.timestampForEpoch(A + 2n)) - 1n));
    const pub1 =
      (big(await es.getEpochPool(1, A + 1n)) * big(await rss.getNodeEpochScore(A + 1n, n1))) / big(await rss.getAllNodesEpochScore(A + 1n));
    check(
      `with the settlement removed, StakingKPI's net of node ${n1} in epoch ${A + 1n} is the publishing share alone`,
      noPool[`${n1}:${A + 1n}`] === pub1 - (pub1 * fee1) / 10_000n && noPool[`${n1}:${A + 1n}`] < kpiPreview[`${n1}:${A + 1n}`],
      `${fmt(kpiPreview[`${n1}:${A + 1n}`])} → ${fmt(noPool[`${n1}:${A + 1n}`])}`,
    );
    const [claimer, withdrawer] = cyclePositions.filter((p: Any) => p.node === n1).sort((a: Any, b: Any) => (a.raw < b.raw ? -1 : 1));
    const xc = await expectedReward(claimer, claimer.lastClaimedEpoch + 1n, E3 - 1n, noPool);
    const [c] = await claimAll([claimer], 'switch off:');
    check(`switch off: token ${claimer.tokenId}'s claim pays the publishing pool alone`, c.reward === xc.total, `${fmt(c.reward)} TRAC`);
    const xw = await expectedReward(withdrawer, withdrawer.lastClaimedEpoch + 1n, E3 - 1n, noPool);
    const wo = await impersonate(withdrawer.owner);
    const before = big(await token.balanceOf(withdrawer.owner));
    const rawW = big((await css.getPosition(withdrawer.tokenId)).raw);
    await send(`switch off: token ${withdrawer.tokenId} owner: withdraw`, (snft as Any).connect(wo).withdraw(withdrawer.tokenId));
    const got = big(await token.balanceOf(withdrawer.owner)) - before;
    check(
      `switch off: token ${withdrawer.tokenId}'s withdrawal goes through, its claim paying the publishing pool alone`,
      got === rawW + xw.total,
      `${fmt(got)} TRAC = raw ${fmt(rawW)} + rewards ${fmt(xw.total)}`,
    );
    // Funding stays open with the settlement out of the Hub; the pause closes it.
    const sswAddr = await ssw.getAddress();
    await send('wallet buyer: approve 1 TRAC (in the snapshot)', (token as Any).connect(walletBuyer).approve(sswAddr, TRAC));
    const lateReq = {
      epoch: E3,
      sessionKey: walletSession.address,
      planDigest: ethers.id('rehearsal plan, settlement removed'),
      buckets: [{ bucketId: bucket0, serviceClass: CLASS_INFERENCE, value: TRAC, maxAskWeiPerUnit: PRICE_CAP }],
    };
    let fundingOpen = true;
    try {
      await (ssw as Any).connect(walletBuyer).fundFromWallet.staticCall(lateReq);
    } catch {
      fundingOpen = false;
    }
    check('switch off: a wallet period can still be funded, so the pause belongs with the removal', fundingOpen);
    await send(
      'Hub owner: forwardCall(QueryInferenceStorage, setPaused(true)) (in the snapshot)',
      h.connect(owner).forwardCall(await qis.getAddress(), qis.interface.encodeFunctionData('setPaused', [true])),
    );
    const pausedWhy = await expectRevert('switch off and paused: fundFromWallet', (ssw as Any).connect(walletBuyer).fundFromWallet.staticCall(lateReq));
    check('the pause refuses the funding', pausedWhy.startsWith('QueryInferencePaused'), pausedWhy);
    out.emergencySwitch = {
      claim: { tokenId: claimer.tokenId, reward: c.reward, gasUsed: c.gasUsed },
      withdraw: { tokenId: withdrawer.tokenId, amount: got },
      kpiNet: { withPool: kpiPreview[`${n1}:${A + 1n}`], without: noPool[`${n1}:${A + 1n}`] },
      fundingOpen,
      paused: pausedWhy,
    };
    await rpc('evm_revert', [snap]);
  }

  // The sellers' real delegators claim.
  const expected: Record<string, Any> = {};
  for (const p of cyclePositions) expected[String(p.tokenId)] = await expectedReward(p, p.lastClaimedEpoch + 1n, E3 - 1n, kpiPreview);
  const vaultBeforeClaims = big(await token.balanceOf(vault));
  const claims = await claimAll(cyclePositions, 'cycle');
  for (const c of claims) {
    const x = expected[String(c.tokenId)];
    check(`token ${c.tokenId} (node ${c.node}) is paid what StakingKPI previewed`, c.reward === x.total, `${fmt(c.reward)} TRAC (preview ${fmt(x.total)}; epoch ${A + 1n}: ${fmt(x.per[String(A + 1n)] ?? 0n)})`);
  }
  for (const n of SELLERS) {
    const stored = big(await css.getNetNodeEpochRewards(n, A + 1n));
    check(`node ${n}: the net of epoch ${A + 1n} the claims split equals StakingKPI's preview`, stored === kpiPreview[`${n}:${A + 1n}`], fmt(stored));
  }
  check('claims move no TRAC (rewards compound into the positions)', big(await token.balanceOf(vault)) === vaultBeforeClaims);

  // The withdrawn position's share of A + 1, paid by anyone's claimWithdrawnEpoch.
  const nodeScoreW = big(await rss.getNodeEpochScore(A + 1n, w.node));
  const tailExpected = (out.withdrawal.recordedScore * kpiPreview[`${w.node}:${A + 1n}`]) / nodeScoreW;
  const stakerBefore = big(await token.balanceOf(w.owner));
  const keeperBefore = big(await token.balanceOf(keeper.address));
  const tail = await send(`keeper: claimWithdrawnEpoch(${w.tokenId})`, (sv10 as Any).connect(keeper).claimWithdrawnEpoch(w.tokenId));
  const tailPaid = big(await token.balanceOf(w.owner)) - stakerBefore;
  check(
    `the withdrawn epoch pays the staker its score's share of the net of ${A + 1n}, as the end of the epoch pays a position`,
    tailPaid === tailExpected && tailPaid > 0n && big(await token.balanceOf(keeper.address)) === keeperBefore,
    `${fmt(tailPaid)} TRAC = score × StakingKPI's net / node score (${fmt(tailExpected)})`,
  );
  const twice = await expectRevert(`claimWithdrawnEpoch(${w.tokenId}) again`, (sv10 as Any).connect(keeper).claimWithdrawnEpoch.staticCall(w.tokenId));
  check('the withdrawn epoch is paid once', twice.startsWith('NoWithdrawnEpoch'), twice);
  out.withdrawnEpoch = { tokenId: w.tokenId, paid: tailPaid, expected: tailExpected, gasUsed: big(tail.receipt.gasUsed) };

  // The node-epoch accounting of the pool epoch, per seller.
  out.nodeEpoch = {};
  const S = big(await rss.getAllNodesEpochScore(A + 1n));
  const stakerPool = big(await es.getEpochPool(1, A + 1n));
  for (const n of SELLERS) {
    const s = big(await rss.getNodeEpochScore(A + 1n, n));
    const pub = (stakerPool * s) / S;
    const g = pub + gross[String(n)];
    const net = big(await css.getNetNodeEpochRewards(n, A + 1n));
    const paid =
      sum(claims.filter((c) => c.node === n).map((c) => expected[String(c.tokenId)].per[String(A + 1n)] ?? 0n)) +
      (n === w.node ? tailPaid : 0n);
    const feeBps = big(await ps.getOperatorFeePercentageByTimestampReverse(n, big(await chronos.timestampForEpoch(A + 2n)) - 1n));
    out.nodeEpoch[String(n)] = { publishingShare: pub, queryInferenceGross: gross[String(n)], gross: g, operatorFeeBps: feeBps, operatorFee: g - net, net, paidToDelegators: paid };
    check(
      `node ${n}: the operator fee of ${A + 1n} is ${feeBps} bps of the gross, the publishing share and the query/inference gross together`,
      g - net === (g * feeBps) / 10_000n,
      `gross ${fmt(g)} = publishing ${fmt(pub)} + query/inference ${fmt(gross[String(n)])}; fee ${fmt(g - net)}`,
    );
    check(
      `node ${n}: the delegators are paid the net of ${A + 1n}, less rounding`,
      paid <= net && net - paid <= net / 10n ** 9n,
      `net ${fmt(net)}, paid ${fmt(paid)}, operator fee ${fmt(g - net)}`,
    );
  }

  // The operator fee the claims split off, withdrawn through StakingV10Ledger.
  const feeBalance = big(await css.getOperatorFeeBalance(feeNode));
  check(
    `node ${feeNode}'s operator-fee balance grew by exactly the fee of ${A + 1n}`,
    feeBalance - feeBalance0 === out.nodeEpoch[String(feeNode)].operatorFee,
    fmt(feeBalance - feeBalance0),
  );
  await send(
    `node ${feeNode} admin: requestOperatorFeeWithdrawal(${fmt(feeBalance)})`,
    (sv10 as Any).connect(nodeAdmin).requestOperatorFeeWithdrawal(feeNode, feeBalance),
  );
  await warpTo((await now()) + big(await (await at('ParametersStorage')).stakeWithdrawalDelay()) + 1n);
  const adminBefore = big(await token.balanceOf(nodeAdmin.address));
  const feeWd = await send(`node ${feeNode} admin: finalizeOperatorFeeWithdrawal`, (sv10 as Any).connect(nodeAdmin).finalizeOperatorFeeWithdrawal(feeNode));
  const feePaid = big(await token.balanceOf(nodeAdmin.address)) - adminBefore;
  check('the operator-fee withdrawal pays the whole balance out of ConvictionStakingStorage', feePaid === feeBalance, fmt(feePaid));
  out.operatorFeeWithdrawal = { node: feeNode, amount: feePaid, gasUsed: big(feeWd.receipt.gasUsed) };

  // Window booking: the account's closed windows, booked by anyone's settle.
  const settled = await send(`keeper: settle(${accountId})`, (pc as Any).connect(keeper).settle(accountId));
  const sched = settled.events.find((e) => e.name === 'EmissionScheduled')!;
  const booking = stakerCredits(settled.events);
  const spent0 = big(await pcs.windowSpent(accountId, 0));
  const fromW = big(sched.args.fromWindow);
  const toW = big(sched.args.toWindow);
  let expectedBooked = 0n;
  for (let x = fromW; x < toW; x++) expectedBooked += B - big(await pcs.windowSpent(accountId, x));
  check(
    `settle books windows ${fromW}..${toW - 1n}: each window's budget less what it drew`,
    big(sched.args.scheduled) === expectedBooked && sum(booking.map((c) => c.amount)) === expectedBooked,
    `${fmt(expectedBooked)} TRAC; window 0 drew ${fmt(spent0)} (service ${fmt(cost)} + publish ${fmt(publish.discountedCost)})`,
  );
  check('no booking credits an epoch that has ended', booking.every((c) => c.start >= E3));
  check('window 0 drew exactly the service cost and the publish, once each', spent0 === cost + publish.discountedCost);
  out.windowBooking = { fromWindow: fromW, toWindow: toW, scheduled: big(sched.args.scheduled), credits: booking };

  // Conservation.
  const vault1 = big(await token.balanceOf(vault));
  check(
    'TRAC into ConvictionStakingStorage: the wallet value and both commitments in; the withdrawal, its epoch and the operator fee out',
    vault1 - vault0 === WALLET_PERIOD_VALUE + COMMITTED + LATE_COMMITTED - paidOut - tailPaid - feePaid,
    `Δ ${fmt(vault1 - vault0)} = ${fmt(WALLET_PERIOD_VALUE)} + ${fmt(COMMITTED)} + ${fmt(LATE_COMMITTED)} − ${fmt(paidOut)} − ${fmt(tailPaid)} − ${fmt(feePaid)}`,
  );
  const publishCredits = sum(publish.stakerCredits.map((c: Any) => c.amount));
  const bookedCredits = sum(booking.map((c) => c.amount));
  check(
    'the account money is booked once: service cost (query/inference due) + publish credits + window booking = the booked windows\' budget',
    cost + publishCredits + bookedCredits === B * (toW - fromW),
    `${fmt(cost)} + ${fmt(publishCredits)} + ${fmt(bookedCredits)} = ${fmt(B * (toW - fromW))}`,
  );
  out.claims = claims;
  out.expected = expected;
  out.vault = { before: vault0, after: vault1 };
  out.walletFundGas = big(walletFund.receipt.gasUsed);
  save('cycle', { ...out, txs: txLog, checks });
}

// ---------------------------------------------------------------------------
// PHASE late-booking — an account no one touched for several epochs
// ---------------------------------------------------------------------------

/** PublishingMathLib.prorateActiveSink, the spread of one window's booking. */
function prorate(amount: bigint, start: bigint, epochs: bigint, epLen: bigint, timeRemaining: bigint) {
  const base = amount / epochs;
  const first = (base * timeRemaining) / epLen;
  let last = base - first;
  const full = epochs - 1n;
  const fullTotal = base * full;
  if (first + fullTotal + last < amount) last += amount - (first + fullTotal + last);
  const r: { start: bigint; end: bigint; amount: bigint }[] = [];
  if (first > 0n) r.push({ start, end: start, amount: first });
  if (full > 0n && fullTotal > 0n) r.push({ start: start + 1n, end: start + full, amount: fullTotal });
  if (last > 0n) r.push({ start: start + epochs, end: start + epochs, amount: last });
  return r;
}

async function phaseLateBooking() {
  const cyc = load('cycle');
  const chronos = await at('Chronos');
  const pc = await at('PublishingConviction');
  const pcs = await at('PublishingConvictionStorage');
  const [, , , , , , keeper] = await ethers.getSigners();
  const id = BigInt(cyc.lateAccount.accountId);
  const acct = await pcs.getAccount(id);
  const created = big(acct.createdAtTimestamp);
  const lock = big(acct.lockDurationEpochs);
  const epLen = big(await chronos.epochLength());
  const committed = big(acct.committedTRAC);
  const B = committed / lock;
  const dust = committed - B * lock;
  await warpTo(big(await chronos.timestampForEpoch(BigInt(cyc.activation) + 6n)) + 60n);
  const E = big(await chronos.getCurrentEpoch());
  console.log(`\nEpoch ${E}: account ${id}, created in epoch ${await chronos.epochAtTimestamp(created)}, untouched since`);
  check(`account ${id} has booked no window yet`, big(acct.lastSettledWindow) === 0n);

  const settled = await send(`keeper: settle(${id})`, (pc as Any).connect(keeper).settle(id));
  const sched = settled.events.find((e) => e.name === 'EmissionScheduled')!;
  const fromW = big(sched.args.fromWindow);
  const toW = big(sched.args.toWindow);
  const credits = stakerCredits(settled.events);
  const expected: { start: bigint; end: bigint; amount: bigint }[] = [];
  const windows: Any[] = [];
  let shapeKept = true;
  for (let w = fromW; w < toW; w++) {
    const remainder = B - big(await pcs.windowSpent(id, w)) + (w === lock - 1n ? dust : 0n);
    const closeTs = created + (w + 1n) * epLen;
    const closeEpoch = big(await chronos.epochAtTimestamp(closeTs));
    const boundary = big(await chronos.timestampForEpoch(closeEpoch + 1n));
    const timeRemaining = boundary > closeTs ? boundary - closeTs : 0n;
    const start = closeEpoch < E ? E : closeEpoch;
    const late = prorate(remainder, start, lock, epLen, timeRemaining);
    const onTime = prorate(remainder, closeEpoch, lock, epLen, timeRemaining);
    shapeKept &&=
      late.length === onTime.length &&
      late.every((r, i) => r.amount === onTime[i].amount && r.start - onTime[i].start === start - closeEpoch && r.end - onTime[i].end === start - closeEpoch);
    expected.push(...late);
    windows.push({ window: w, closeEpoch, startEpoch: start, shiftedBy: start - closeEpoch, remainder, ranges: late });
  }
  console.log(`  windows ${fromW}..${toW - 1n} booked, each closed in epochs ${windows.map((x) => x.closeEpoch).join(', ')}`);
  check(
    'each late window is booked with its on-time curve, shifted to start in the current epoch',
    shapeKept && JSON.stringify(jsonable(credits)) === JSON.stringify(jsonable(expected)),
    `${credits.length} credits from epoch ${credits[0]?.start} to ${credits[credits.length - 1]?.end}`,
  );
  check('no late booking credits an epoch that has ended', credits.every((c) => c.start >= E));
  check(
    'the money is conserved: the booked windows\' whole budget, and nothing else',
    sum(credits.map((c) => c.amount)) === big(sched.args.scheduled) && big(sched.args.scheduled) === B * (toW - fromW),
    `${fmt(sum(credits.map((c) => c.amount)))} TRAC = ${toW - fromW} × ${fmt(B)}`,
  );
  save('late-booking', { epoch: E, accountId: id, fromWindow: fromW, toWindow: toW, windows, credits, gasUsed: big(settled.receipt.gasUsed), txs: txLog, checks });
}

// ---------------------------------------------------------------------------
// PHASE close-behind — the close more than maxCloseStepsPerClaim epochs behind
// ---------------------------------------------------------------------------

async function phaseCloseBehind() {
  const chronos = await at('Chronos');
  const qis = await at('QueryInferenceStorage');
  const qs = await at('QueryInferenceSettlement');
  const snft = await at('DKGStakingConvictionNFT');
  const [, , , , , , keeper] = await ethers.getSigners();
  const steps = big(await qis.maxCloseStepsPerClaim());
  const closed = big(await qis.closedThrough());
  const target = closed + steps + 2n;
  await warpTo(big(await chronos.timestampForEpoch(target + 1n)) + 60n);
  const E = big(await chronos.getCurrentEpoch());
  console.log(`\nEpoch ${E}, closed through ${closed}, maxCloseStepsPerClaim ${steps}`);
  const p = (await positions()).find((x: Any) => SELLERS.includes(x.node))!;
  const owner = await impersonate(p.owner);
  const why = await expectRevert(`token ${p.tokenId} claim`, (snft as Any).connect(owner).claim.staticCall(p.tokenId));
  check('a claim reverts QueryInferenceCloseBehind once the close is more than maxCloseStepsPerClaim epochs behind', why.startsWith('QueryInferenceCloseBehind'), why);
  const c = await send(`keeper: closeEpochs(${steps * 2n})`, (qs as Any).connect(keeper).closeEpochs(steps * 2n));
  const closes = c.events.filter((e) => e.name === 'EpochClosed').map((e) => {
    const money = big(e.args.walletDue) + big(e.args.convictionDue) + big(e.args.carryIn);
    return { epoch: big(e.args.epoch), money, served: big(e.args.sumR), unused: money - big(e.args.sumR) };
  });
  console.log(
    `  unused share of epochs ${closes[0]?.epoch}..${closes[closes.length - 1]?.epoch}: money ${fmt(sum(closes.map((x) => x.money)))}, ` +
      `served ${fmt(sum(closes.map((x) => x.served)))}, unused ${fmt(sum(closes.map((x) => x.unused)))}`,
  );
  const cl = await send(`token ${p.tokenId} owner: claim`, (snft as Any).connect(owner).claim(p.tokenId));
  check('after closeEpochs the claim goes through', cl.receipt.status === 1);
  save('close-behind', { epoch: E, closedBefore: closed, closeGas: big(c.receipt.gasUsed), claimGas: big(cl.receipt.gasUsed), txs: txLog, checks });
}

// ---------------------------------------------------------------------------
// PHASE unused — the unused share of every closed epoch, from storage
// ---------------------------------------------------------------------------

/**
 * Per closed epoch from activation: money = walletDue + convictionDue +
 * carryIn, served = ΣR finalized in it, unused = money − served, whoever
 * closed it (a keeper's closeEpochs or a claim on its way). The carry into
 * the activation epoch is 0, and each close carries money − pool on.
 */
async function phaseUnused() {
  const qis = await at('QueryInferenceStorage');
  const activation = big(await qis.activationEpoch());
  const closedThrough = big(await qis.closedThrough());
  const rows: Any[] = [];
  let carry = 0n;
  for (let e = activation; e <= closedThrough; e++) {
    const [wallet, conviction] = await qis.dueIn(e);
    const close = await qis.getEpochClose(e);
    const money = big(wallet) + big(conviction) + carry;
    const served = big((await qis.getEpochTotals(e)).sumR);
    const pool = big(close.pool);
    rows.push({ epoch: e, walletDue: big(wallet), convictionDue: big(conviction), carryIn: carry, money, served, unused: money - served, pool });
    carry = money - pool;
  }
  console.log(`\nunused share, epochs ${activation}..${closedThrough} (money = walletDue + convictionDue + carryIn, served = sumR):`);
  for (const r of rows) {
    if (r.money > 0n || r.served > 0n) {
      console.log(`  epoch ${r.epoch}: money ${fmt(r.money)}, served ${fmt(r.served)}, unused ${fmt(r.unused)}, pool ${fmt(r.pool)}`);
    }
  }
  const empty = rows.filter((r) => r.money === 0n && r.served === 0n).map((r) => r.epoch);
  console.log(`  the other ${empty.length} epochs had no money and served nothing`);
  console.log(`  total: money ${fmt(sum(rows.map((r) => r.money)))}, served ${fmt(sum(rows.map((r) => r.served)))}, unused ${fmt(sum(rows.map((r) => r.unused)))}`);
  check('every closed epoch pools its whole money once value is served, and carries it otherwise', rows.every((r) => (r.served > 0n ? r.pool === r.money : r.pool === 0n)));
  save('unused', { activation, closedThrough, rows, checks });
}

async function main() {
  console.log(`client ${await rpc('web3_clientVersion', [])}, chain ${BigInt(await rpc('eth_chainId', []))}, phase ${PHASE}`);
  padGasEstimates();
  if (PHASE === 'pre') await phasePre();
  else if (PHASE === 'hub') await phaseHub();
  else if (PHASE === 'existing') await phaseExisting();
  else if (PHASE === 'cycle') await phaseCycle();
  else if (PHASE === 'late-booking') await phaseLateBooking();
  else if (PHASE === 'close-behind') await phaseCloseBehind();
  else if (PHASE === 'unused') await phaseUnused();
  else throw new Error('set PHASE to pre, hub, existing, cycle, late-booking, close-behind or unused');
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error('\n❌ rehearsal failed:', e?.shortMessage ?? e?.message ?? e);
  const d = errorData(e);
  if (d) console.error('   decoded:', await decodeError(d));
  process.exit(1);
});
