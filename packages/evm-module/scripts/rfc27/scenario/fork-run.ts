// The whole scenario on a local anvil fork, all roles from one process: the same
// setup and the same ticks as the beacons run, through a warped clock, and the
// chain checked against the plan and the rollover rule after each epoch. What
// only a fork allows stands in for what the network has: sellers and the funder
// are impersonated, as no key of theirs is here, and node scores are written as
// RandomSampling would. It refuses to run anywhere but on a fork.

import * as fs from 'fs';

import { ethers } from 'ethers';

import { errorMessage } from '../contracts';

import { RetryingProvider, chainNow, checkChain, resolveContracts, send } from './chain';
import type { Fields, Log, Landed, RawLog } from './chain';
import { EPOCH_SECONDS, FIRST_EPOCH, SELLERS, TICK_SECONDS } from './config';
import type { SellerName } from './config';
import { epochStart, landingTimes, planEpoch, valueOf } from './plan';
import { publicFile } from './public';
import type { PublicFile } from './public';
import { runSetup } from './setup';
import { runTick } from './tick';
import type { LandedGroup, TickDeps, TickState } from './tick';
import { Ledger, checkEpoch, readEpoch } from './verify';
import type { Check } from './verify';

/** A tick's state, kept in memory for each beacon. */
class MemoryState implements TickState {
  private retry = new Map<number, boolean>();
  private held = new Set<number>();
  retryLanding = (e: number): boolean => this.retry.get(e) === true;
  setRetryLanding = (e: number, on: boolean): void => void this.retry.set(e, on);
  heldDone = (e: number): boolean => this.held.has(e);
  markHeldDone = (e: number): void => void this.held.add(e);
  unmarkHeldDone = (e: number): void => void this.held.delete(e);
}

type Seen = { kind: string; fields: Fields };

class RunLog implements Log {
  readonly seen: Seen[] = [];
  constructor(private readonly file: string) {}
  event(kind: string, fields: Fields = {}): void {
    this.seen.push({ kind, fields });
    fs.appendFileSync(this.file, `${JSON.stringify({ kind, ...fields }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}\n`);
  }
  since(from: number): Seen[] {
    return this.seen.slice(from);
  }
}

const say = (s: string): void => console.log(s);
const fmt = (wei: bigint): string => ethers.formatEther(wei);

export type ForkOptions = {
  url: string;
  seed: Uint8Array;
  epochs: number;
  logFile: string;
  stride: number;
  /** A journal of a setup already run on the chain the fork is of: the run then starts from that setup, sending nothing for it. */
  journal?: string;
};

export async function forkRun(o: ForkOptions): Promise<boolean> {
  const provider = new RetryingProvider(o.url);
  const client = String(await provider.send('web3_clientVersion', []));
  const info = (await provider.send('anvil_nodeInfo', [])) as { forkConfig?: { forkBlockNumber?: number } };
  const host = new URL(o.url).hostname;
  if (!client.startsWith('anvil/') || host !== '127.0.0.1' || info.forkConfig?.forkBlockNumber === undefined) throw new Error('this runs only on a local anvil fork');
  say(`fork at block ${info.forkConfig.forkBlockNumber}, ${client}`);

  const c = await resolveContracts(provider);
  await checkChain(provider, c);
  const log = new RunLog(o.logFile);
  const ledger = new Ledger();
  const failures: Check[] = [];
  const tally = { checks: 0, batches: 0, items: 0, gas: 0n };
  const gasByLabel = new Map<string, { n: number; gas: bigint }>();

  const rpc = (method: string, params: unknown[]) => provider.send(method, params);
  const impersonate = async (address: string): Promise<ethers.Signer> => {
    await rpc('anvil_impersonateAccount', [address]);
    return provider.getSigner(address);
  };

  // FORK-ONLY: the funder's address, and each seller, without their keys.
  const funderAddress = String(await c.hub.owner());
  const funder = await impersonate(funderAddress);
  const sellers = new Map<SellerName, ethers.Signer>();
  for (const s of SELLERS) sellers.set(s.name, await impersonate(s.address));
  const signerOf = (w: ethers.Wallet): ethers.Signer => w.connect(provider);

  const before = { eth: await provider.getBalance(funderAddress), trac: (await c.token.balanceOf(funderAddress)) as bigint };
  const sender = { provider, log, waitMs: 60_000 };
  say('setup, as the funder, the owners and the buyers...');
  const journalFile = `${o.logFile}.journal.json`;
  fs.rmSync(journalFile, { force: true });
  if (o.journal) fs.copyFileSync(o.journal, journalFile);
  const setup = await runSetup({ provider, c, seed: o.seed, funder, signerOf, log, sender, sendTransactions: true, journalFile, publicOut: [] });
  const again = await runSetup({ provider, c, seed: o.seed, funder, signerOf, log, sender, sendTransactions: true, journalFile, publicOut: [] });
  const after = { eth: await provider.getBalance(funderAddress), trac: (await c.token.balanceOf(funderAddress)) as bigint };
  say(`setup: funder spent ${fmt(before.eth - after.eth)} ETH and ${fmt(before.trac - after.trac)} TRAC; accounts ${JSON.stringify(setup.accountIds)}`);
  const check = (ok: boolean, what: string, detail?: string) => {
    tally.checks++;
    if (!ok) failures.push({ ok, what, detail });
  };
  check(again.spentEth === setup.spentEth && again.spentTrac === setup.spentTrac, 'setup sends nothing when run again', `${fmt(again.spentEth)} vs ${fmt(setup.spentEth)} ETH`);

  const pub: PublicFile = publicFile(o.seed, setup.accountIds);
  const states = new Map<SellerName, MemoryState>();
  for (const s of SELLERS) states.set(s.name, new MemoryState());
  const crash = { armed: false };

  const depsOf = (name: SellerName): TickDeps => ({
    provider,
    c,
    seed: o.seed,
    pub,
    beacon: name,
    seller: sellers.get(name) as ethers.Signer,
    signerOf,
    log,
    state: states.get(name) as MemoryState,
    sender: { provider, log, waitMs: 60_000, crashAfterSend: () => crash.armed },
    onLanded: (seller: SellerName, epoch: number, groups: LandedGroup[], receipt: Landed) => {
      ledger.add(seller, epoch, groups);
      tally.batches++;
      tally.items += groups.reduce((a, g) => a + g.itemCount, 0);
      tally.gas += receipt.gasUsed;
    },
  });

  // FORK-ONLY: a stand-in for a node's first proof of an epoch: RandomSampling's two writes of a score.
  const randomSampling = String(await c.hub.getContractAddress('RandomSampling'));
  await rpc('anvil_setBalance', [randomSampling, ethers.toQuantity(10n ** 19n)]);
  const scorer = await impersonate(randomSampling);
  const rssAddress = await c.rss.getAddress();
  const standInScore = async (identityId: number, epoch: number) => {
    for (const data of [
      c.rss.interface.encodeFunctionData('addToNodeEpochScore', [epoch, identityId, 10n ** 18n]),
      c.rss.interface.encodeFunctionData('addToAllNodesEpochScore', [epoch, 10n ** 18n]),
    ]) {
      const out = await send(sender, { label: 'stand-in score', signer: scorer, to: rssAddress, data, fields: { identityId, epoch } });
      if (!out.sent) throw new Error(`the stand-in score of node ${identityId} did not go through`);
    }
  };

  const warpTo = async (ts: number) => {
    const latest = await chainNow(provider);
    await rpc('evm_setNextBlockTimestamp', [ts > latest ? ts : latest + 1]);
    await rpc('evm_mine', []);
  };

  const tick = async (name: SellerName): Promise<Seen[]> => {
    const from = log.seen.length;
    try {
      await runTick(depsOf(name));
    } catch (e: unknown) {
      log.event('tick-error', { beacon: name, error: errorMessage(e) });
      check(false, `a tick of ${name} threw`, errorMessage(e));
    }
    const seen = log.since(from);
    for (const s of seen) {
      if (s.kind === 'tx-mined' && typeof s.fields.label === 'string') {
        const key = s.fields.label.replace(/^beacon-0\d: /, 'seller: ');
        const v = gasByLabel.get(key) ?? { n: 0, gas: 0n };
        gasByLabel.set(key, { n: v.n + 1, gas: v.gas + BigInt(String(s.fields.gasUsed)) });
      }
    }
    return seen;
  };

  // Before the first epoch: the whole read path, and a refused funding.
  const firstStart = epochStart(FIRST_EPOCH);
  const preStart = await chainNow(provider);
  if (preStart < firstStart) {
    for (const s of SELLERS) await tick(s.name);
    const refused = log.seen.filter((x) => x.kind === 'simulated-funding');
    check(refused.length === 6 && refused.every((x) => String(x.fields.outcome).startsWith('QueryInferenceNotActive(663')), 'before the first epoch, every buyer\'s funding is simulated and refused', JSON.stringify(refused.map((x) => x.fields.outcome)));
  } else {
    check(false, 'the fork starts before the first epoch', `chain time ${preStart}`);
  }

  // The epochs, at the beacons' real cadence.
  const crashAt = FIRST_EPOCH + 1;
  let crashed = false;
  for (let epoch = FIRST_EPOCH; epoch < FIRST_EPOCH + o.epochs; epoch++) {
    const started = Date.now();
    const start = epochStart(epoch);
    const offset = epoch - FIRST_EPOCH;
    // The nodes' first proofs come at different times, the first seller's after its first landing was due, so a batch meets NoNodeScore and retries.
    const proofAt = new Map<SellerName, number>();
    SELLERS.forEach((s, i) => proofAt.set(s.name, i === offset % SELLERS.length ? landingTimes(o.seed, epoch, s.name)[0] + 2 * TICK_SECONDS : 300 + i * 120));
    const proved = new Set<SellerName>();
    const fromLog = log.seen.length;

    for (let m = 0; m < EPOCH_SECONDS / 60; m++) {
      const beacon = SELLERS.find((s) => m % 5 === s.tickMinute);
      if (!beacon) continue;
      const cycle = Math.floor(m / 5);
      const at = start + m * 60 + 15;
      // Coarser only away from what is scripted, and only if asked: every tick in the last stretch, and at the start.
      const late = m >= 22 * 60;
      if (o.stride > 1 && cycle % o.stride !== 0 && !late && m >= 30 && !isScripted(o.seed, epoch, beacon.name, at - start)) continue;
      await warpTo(at);
      for (const s of SELLERS) {
        if (!proved.has(s.name) && at - start >= (proofAt.get(s.name) ?? 0)) {
          await standInScore(s.identityId, epoch);
          proved.add(s.name);
        }
      }
      // One batch of one epoch stops right after its send, as a crash would: the receipt goes in the ledger, and the next tick must not land it twice.
      crash.armed = epoch === crashAt && !crashed && m >= 8 * 60;
      const seen = await tick(beacon.name);
      if (crash.armed && seen.some((x) => x.kind === 'send-error')) {
        crashed = true;
        crash.armed = false;
        const sent = seen.filter((x) => x.kind === 'tx-sent').pop();
        if (sent) await recordCrashed(provider, c.qs, ledger, beacon.name, epoch, String(sent.fields.hash), tally);
        say(`  a crash right after a send at minute ${m} of epoch ${epoch}; the next tick reruns`);
        const rerun = await tick(beacon.name);
        check(!rerun.some((x) => x.kind === 'tx-sent' && String(x.fields.label).includes('land a batch')), 'after a crash, a rerun does not land the same calls');
      }
      crash.armed = false;
      // A rerun at once lands nothing it landed, whatever the tick did: it sends only for a call that has come due in the second since.
      if (seen.some((x) => x.kind === 'tx-sent')) {
        const assigned = seen.filter((x) => x.kind === 'landing').pop()?.fields.assignedSoFar;
        const rerun = await tick(beacon.name);
        const sends = rerun.filter((x) => x.kind === 'tx-sent');
        const landing = rerun.filter((x) => x.kind === 'landing').pop();
        const newlyDue = landing && assigned !== undefined ? Number(landing.fields.assignedSoFar) - Number(assigned) : 0;
        check(sends.length === 0 || Number(landing?.fields.ready ?? 0) <= newlyDue, `a rerun of ${beacon.name}'s tick at once sends nothing it sent`, JSON.stringify(sends.map((x) => x.fields.label)));
      }
    }

    // The epoch has ended: its numbers are final.
    await warpTo(start + EPOCH_SECONDS + 1);
    const checks = await checkEpoch(c, o.seed, pub, epoch, true, await chainNow(provider), ledger);
    for (const x of checks) {
      tally.checks++;
      if (!x.ok) failures.push(x);
    }
    const n = await readEpoch(c, epoch);
    const seen = log.since(fromLog);
    const plan = planEpoch(o.seed, epoch);
    say(`epoch ${epoch} (offset ${offset}): money ${fmt(n.money)} (wallet ${fmt(n.walletFunding)}, account ${fmt(n.accountFunding)}), pool ${fmt(n.pool)}, ΣR ${fmt(n.totalServed)}, ΣQIS ${fmt(n.totalWeighted)}`);
    say(`  calls planned ${plan.calls.length} of ${fmt(valueOf(plan.calls))} TRAC, batches ${seen.filter((x) => x.kind === 'batch-landed').length}, NoNodeScore retries ${seen.filter((x) => x.kind === 'no-node-score').length}, ${Math.round((Date.now() - started) / 1000)} s`);
    for (const node of n.nodes) say(`    ${node.seller}: R ${fmt(node.served)}, QIS ${fmt(node.weighted)}, gross ${fmt(node.gross)}`);
    if (offset === 1) {
      check(seen.some((x) => x.kind === 'tx-mined' && x.fields.event === 'top-up'), 'offset 1: wallet-bursty tops up');
      check(seen.some((x) => x.kind === 'tx-mined' && x.fields.event === 'remove-buyer'), 'offset 1: account-30 is removed');
      check(seen.some((x) => x.kind === 'calls-left-out' && x.fields.why === 'issued after the grant ended'), 'offset 1: calls issued after the removal are left out');
    }
    if (offset === 2) {
      check(seen.some((x) => x.kind === 'tx-mined' && x.fields.event === 'add-buyer'), 'offset 2: account-30 is added again');
      const limits = seen.filter((x) => x.kind === 'budget-limit');
      check(limits.length > 0, 'offset 2: the race clips a seller at the budget\'s limit', `${limits.length}`);
      for (const l of limits) say(`    race: ${l.fields.seller} landed ${fmt(BigInt(String(l.fields.valueWei)))}, counted ${fmt(BigInt(String(l.fields.countedWei)))}`);
    }
    if (offset === 3) {
      check(plan.calls.length === 0, 'offset 3: no calls');
      check(n.totalServed === 0n && n.pool === 0n && n.money > 0n, 'offset 3: no value, so the pool is 0 and the money waits', `money ${fmt(n.money)}`);
      const missed = seen.filter((x) => x.kind === 'held-batch-missed');
      check(missed.length === 1 && missed[0].fields.expected === true, 'offset 3: the held batch of offset 2 is refused as OutsideEpoch', JSON.stringify(missed.map((x) => x.fields)));
      check(seen.filter((x) => x.kind === 'tx-sent' && x.fields.event === 'held-batch').length === 1, 'offset 3: the held batch goes out once, and fails on the chain');
      for (const x of missed) say(`    held batch: ${x.fields.seller}, ${x.fields.items} items of ${fmt(BigInt(String(x.fields.valueWei)))} TRAC, failed on the chain, gas ${x.fields.gasUsed}: ${x.fields.why}`);
    }
    if (offset === 4) {
      const prev = await readEpoch(c, epoch - 1);
      check(n.pool === prev.money + n.money, 'offset 4: the pool takes the money rolled from offset 3', `${fmt(n.pool)} vs ${fmt(prev.money)} + ${fmt(n.money)}`);
      say(`    rollover: pool ${fmt(n.pool)} = offset 3's ${fmt(prev.money)} + its own ${fmt(n.money)}`);
    }
  }
  check(crashed, 'the run stopped right after a send once, and went on');

  const worst = log.seen.filter((x) => ['tick-error', 'duty-error', 'tx-reverted-on-chain', 'over-gas-cap', 'send-error'].includes(x.kind) && x.fields.event !== 'held-batch');
  check(worst.filter((x) => x.kind !== 'send-error').length === 0, 'no tick failed', JSON.stringify(worst.slice(0, 5).map((x) => [x.kind, x.fields.error ?? x.fields.label])));
  const unexpected = log.seen.filter((x) => x.kind === 'simulation-reverted' && !String(x.fields.why).startsWith('NoNodeScore'));
  check(unexpected.length === 0, 'no simulation reverted but for NoNodeScore', JSON.stringify(unexpected.slice(0, 5).map((x) => [x.fields.label, x.fields.why])));

  say(`\ngas by transaction kind:`);
  for (const [k, v] of [...gasByLabel.entries()].sort()) say(`  ${k}: ${v.n} tx, ${v.gas} gas, ${v.gas / BigInt(v.n)} each`);
  if (tally.items > 0) say(`batches: ${tally.batches}, items ${tally.items}, gas ${tally.gas}, ${tally.gas / BigInt(tally.items)} per item all in`);
  say(`\nchecks: ${tally.checks}, failed: ${failures.length}`);
  for (const f of failures.slice(0, 60)) say(`  FAIL ${f.what}${f.detail ? `: ${f.detail}` : ''}`);
  return failures.length === 0;
}

function isScripted(seed: Uint8Array, epoch: number, seller: SellerName, secondsIn: number): boolean {
  if (secondsIn < 1_800) return true;
  const near = (t: number) => t <= secondsIn && secondsIn < t + TICK_SECONDS;
  if (landingTimes(seed, epoch, seller).some(near)) return true;
  return [12 * 3_600, 16 * 3_600].some((t) => secondsIn >= t && secondsIn < t + 2 * TICK_SECONDS);
}

async function recordCrashed(provider: ethers.JsonRpcProvider, qs: ethers.Contract, ledger: Ledger, seller: SellerName, epoch: number, hash: string, tally: { batches: number; items: number; gas: bigint }): Promise<void> {
  // anvil may not have mined it yet, right after the send.
  let r: { logs: RawLog[]; gasUsed: string } | null = null;
  for (let i = 0; i < 100 && !r; i++) {
    r = (await provider.send('eth_getTransactionReceipt', [hash])) as { logs: RawLog[]; gasUsed: string } | null;
    if (!r) await new Promise((res) => setTimeout(res, 100));
  }
  if (!r) throw new Error(`no receipt for the batch stopped right after its send: ${hash}`);
  const groups: LandedGroup[] = [];
  for (const l of r.logs) {
    if (l.address.toLowerCase() !== String(qs.target).toLowerCase()) continue;
    const parsed = qs.interface.parseLog({ topics: l.topics, data: l.data });
    if (parsed?.name !== 'ReceiptsLanded') continue;
    groups.push({
      subscriptionId: parsed.args.subscriptionId as string,
      budgetIndex: Number(parsed.args.budgetIndex),
      seller: Number(parsed.args.seller),
      itemCount: Number(parsed.args.itemCount),
      value: parsed.args.value as bigint,
      counted: parsed.args.counted as bigint,
      stakeFactor18: parsed.args.stakeFactor18 as bigint,
    });
  }
  ledger.add(seller, epoch, groups);
  tally.batches++;
  tally.items += groups.reduce((a, g) => a + g.itemCount, 0);
  tally.gas += BigInt(r.gasUsed);
}
