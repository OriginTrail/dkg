// SPDX-License-Identifier: Apache-2.0

/**
 * The seller's landing loop (OT-RFC-27): its receipts go on chain in
 * batches, so their value counts toward its share of the epoch's pool.
 *
 * Each tick:
 *   1. The `sent` batches are resolved (below). Receipts of an ended epoch
 *      still `served` become `missed`, and ended epochs are pruned.
 *   2. While the node does not serve, and in the epoch's last
 *      `endMarginSeconds` by the chain's time, nothing is sent.
 *   3. Due? A landing time (every `landingIntervalMinutes` from the epoch's
 *      start), any tick of the last `lastStretchMinutes`, the final tick
 *      `finalLandingSeconds` before the end, a budget whose unlanded value
 *      reached `nearLimitShare` of what it has left, a retry the last tick
 *      left, or `landNow()`. Otherwise stop.
 *   4. The node's score in the epoch, and the base fee: with no score yet a
 *      batch would revert `NoNodeScore`, so a retry is left for the next
 *      tick, as it is while the base fee is over its ceiling.
 *   5. Ready: the epoch's receipts `served`, completed at least
 *      `completedMarginSeconds` ago. One whose nonce the chain shows used is
 *      marked `landed`; a budget with nothing left is skipped.
 *   6. Batches: a group per subscription and budget, oldest receipts first,
 *      within the bounds of `batchState()`; none while the settlement is
 *      paused or not active yet, and a retry is left.
 *   7. Each batch is simulated as it is prepared: a `ReceiptFault` drops its
 *      item and a `GroupFault` its group, the dropped receipts `refused`. A
 *      group's faults are its own: past `maxFaultDrops` drops in a tick, the
 *      group waits for a later tick, and the rest of the batch goes on, so one
 *      buyer's faulting receipts never hold back another's. Any other refusal
 *      leaves a retry.
 *   8. At most `maxBatchesPerTick` are sent, each made from the receipts not
 *      sent, dropped or set aside yet, and recorded before it is broadcast.
 *      One that lands marks its receipts `landed`, with what each group
 *      counted; one that reverts puts them back to `served`; one whose fate is
 *      not known yet stays `sent`, and the tick sends no more.
 * A `sent` batch is resolved by its transactions (the first, or a speed-up).
 * When none is mined but its wallet's nonce has passed it, they are read once
 * more, since one may have been mined in between; if none is, the batch is
 * resolved by the nonce bits of its receipts: set, they landed; clear, they go
 * back to `served`. Otherwise it waits, and its first transaction, unless it
 * was sped up, is sent again as it was signed, at every tick: the node may
 * have stopped after the batch was recorded and before it was broadcast, and
 * then nothing else would move its nonce. The same hash and nonce land at most
 * once. Ticks take turns, so two never send the same receipts.
 */
import { ethers } from 'ethers';
import {
  enrichEvmError,
  receiptBatchFaultOf,
  receiptItemOf,
  type EpochTimes,
  type MarketplaceChainAdapter,
  type ReceiptBatch,
  type ReceiptBatchOutcome,
  type ReceiptGroup,
  type ReceiptItem,
} from '@origintrail-official/dkg-chain';
import { KeyedLock } from './journal.js';
import { receiptFromWire, requestFromWire } from './wire.js';
import type { BatchRecord, SellerLedger, ServedCall } from './ledger.js';

export interface LandingSettings {
  landingIntervalMinutes: number;
  lastStretchMinutes: number;
  /** 0 turns the final tick off. */
  finalLandingSeconds: number;
  /** A share of 1; 0 turns it off. */
  nearLimitShare: number;
  endMarginSeconds: number;
  completedMarginSeconds: number;
  maxBatchesPerTick: number;
  /** Per group (a subscription's budget) and tick. */
  maxFaultDrops: number;
  /** Wei; the second applies in the last stretch. */
  baseFeeCeiling: bigint;
  lastStretchBaseFeeCeiling: bigint;
}

export const DEFAULT_LANDING: Readonly<LandingSettings> = Object.freeze({
  landingIntervalMinutes: 120,
  lastStretchMinutes: 20,
  finalLandingSeconds: 60,
  nearLimitShare: 0.5,
  endMarginSeconds: 30,
  completedMarginSeconds: 30,
  maxBatchesPerTick: 3,
  maxFaultDrops: 8,
  baseFeeCeiling: 250_000_000n,
  lastStretchBaseFeeCeiling: 1_000_000_000n,
});

/** A batch a tick landed. */
export interface LandedBatch {
  /** Its record in the ledger. */
  batchId: string;
  txHash: string;
  items: number;
  value: bigint;
  counted: bigint;
}

/** What a tick did: why it stopped, or the batches it landed. */
export type LandingReport =
  | { stopped: 'not-serving' | 'end-margin' | 'not-due' | 'no-node-score' | 'base-fee' | 'nothing-ready' | 'not-active' }
  | { sent: LandedBatch[]; refused: number; waiting: boolean };

type Group = { subscriptionId: string; budgetIndex: number; calls: ServedCall[] };

/** What one tick's sending has done to its groups: each one's faults dropped, and the groups past `maxFaultDrops`. */
type TickFaults = { drops: Map<string, number>; setAside: Set<string> };

const groupKey = (g: { subscriptionId: string; budgetIndex: number }) => `${g.subscriptionId.toLowerCase()}:${g.budgetIndex}`;

/** The receipts' order everywhere: oldest completed first, then by nonce. Buyers match landed groups in it. */
export function byLandingOrder(a: { receipt: { completedAt: number }; request: { nonce: string } }, b: typeof a): number {
  if (a.receipt.completedAt !== b.receipt.completedAt) return a.receipt.completedAt - b.receipt.completedAt;
  const [x, y] = [BigInt(a.request.nonce), BigInt(b.request.nonce)];
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A served call as a batch item. */
export function receiptItemOfCall(call: ServedCall): ReceiptItem {
  return receiptItemOf(requestFromWire(call.request), receiptFromWire(call.receipt), call.signature);
}

/** A tick that failed is tried again this many seconds on, or after `tickSeconds` if that is sooner. */
export const TICK_RETRY_SECONDS = 30;

/** Seconds from `times.now` to the next tick: the next multiple of `tickSeconds` from the epoch's start, or the final tick if that is sooner. */
export function secondsToNextTick(times: EpochTimes, tickSeconds: number, finalLandingSeconds: number): number {
  let next = times.startsAt + (Math.floor((times.now - times.startsAt) / tickSeconds) + 1) * tickSeconds;
  const final = times.endsAt - finalLandingSeconds;
  if (finalLandingSeconds > 0 && times.now < final && final < next) next = final;
  return Math.max(1, next - times.now);
}

/**
 * When a landing is next due, in chain seconds: the next landing time, or the
 * last stretch's start or the final tick if sooner; in the last stretch, the
 * next tick.
 */
export function nextLandingAt(times: EpochTimes, s: LandingSettings, tickSeconds: number): number {
  const stretch = times.endsAt - s.lastStretchMinutes * 60;
  if (times.now >= stretch) return times.now + secondsToNextTick(times, tickSeconds, s.finalLandingSeconds);
  const interval = s.landingIntervalMinutes * 60;
  const next = times.startsAt + (Math.floor((times.now - times.startsAt) / interval) + 1) * interval;
  const final = s.finalLandingSeconds > 0 ? times.endsAt - s.finalLandingSeconds : stretch;
  return Math.min(next, stretch, final);
}

/**
 * Seconds to wait after a tick that failed: `TICK_RETRY_SECONDS`, or
 * `tickSeconds` if that is sooner, and never past the final tick, as the last
 * chain time read, `elapsed` seconds ago, places it.
 */
export function secondsToRetry(last: EpochTimes | undefined, elapsed: number, tickSeconds: number, finalLandingSeconds: number): number {
  let wait = Math.min(TICK_RETRY_SECONDS, tickSeconds);
  if (last && finalLandingSeconds > 0) {
    const toFinal = last.endsAt - finalLandingSeconds - (last.now + elapsed);
    if (toFinal >= 0) wait = Math.min(wait, toFinal);
  }
  return Math.max(1, wait);
}

export class Lander {
  private retry = false;
  private now = false;
  /** epoch => the last landing time a tick landed at. */
  private readonly slots = new Map<number, number>();
  private readonly finalDone = new Set<number>();
  private readonly turns = new KeyedLock();

  constructor(private readonly deps: {
    chain: MarketplaceChainAdapter;
    ledger: SellerLedger;
    settings: LandingSettings;
    log?: (message: string) => void;
  }) {}

  /** Land at the next tick, due or not. */
  landNow(): void {
    this.now = true;
  }

  /** One tick, once any before it is done. While the node is not `open` to serve, it sends nothing. */
  tick(open = true): Promise<LandingReport> {
    return this.turns.run('tick', () => this.tickNow(open));
  }

  /** Resolve each `sent` batch from the chain: mined, or past its wallet's nonce; otherwise it waits. */
  resolve(): Promise<void> {
    return this.turns.run('tick', () => this.resolveNow());
  }

  // ----------------------------------------------------------- internal

  private async tickNow(open: boolean): Promise<LandingReport> {
    const { chain, ledger, settings: s } = this.deps;
    await this.resolveNow();
    const times = await chain.getEpochTimes();
    await ledger.recordMissed(ledger.inState('served').filter((c) => c.epoch < times.epoch).map((c) => c.requestDigest));
    await ledger.prune(times.epoch);
    if (!open) return { stopped: 'not-serving' };
    const left = times.endsAt - times.now;
    if (left <= s.endMarginSeconds) return { stopped: 'end-margin' };
    const lastStretch = left <= s.lastStretchMinutes * 60;
    const slot = Math.floor((times.now - times.startsAt) / (s.landingIntervalMinutes * 60));
    const finalTick = s.finalLandingSeconds > 0 && left <= s.finalLandingSeconds && !this.finalDone.has(times.epoch);
    const due = this.now || this.retry || lastStretch || finalTick || slot > (this.slots.get(times.epoch) ?? 0)
      || await this.nearLimit(times.epoch);
    if (!due) return { stopped: 'not-due' };
    this.slots.set(times.epoch, slot);
    if (finalTick) this.finalDone.add(times.epoch);
    this.now = false;
    this.retry = false;

    const identity = await chain.getIdentityId();
    if ((await chain.getNodeEpochScore(times.epoch, identity)) === 0n) {
      this.retry = true;
      return { stopped: 'no-node-score' };
    }
    const fee = await chain.getBaseFee();
    if (fee !== null && fee > (lastStretch ? s.lastStretchBaseFeeCeiling : s.baseFeeCeiling)) {
      this.retry = true;
      return { stopped: 'base-fee' };
    }
    const groups = await this.readyGroups(times.epoch, times.now - s.completedMarginSeconds, identity);
    if (groups.length === 0) return { stopped: 'nothing-ready' };
    const bounds = await chain.batchState();
    if (bounds.paused || bounds.activationEpoch === 0 || times.epoch < bounds.activationEpoch) {
      this.retry = true;
      return { stopped: 'not-active' };
    }
    const report: Extract<LandingReport, { sent: unknown }> = { sent: [], refused: 0, waiting: false };
    const faults: TickFaults = { drops: new Map(), setAside: new Set() };
    // Each batch from what is left: a group set aside takes none of the batches after it.
    let unsent = groups;
    for (let sent = 0; sent < s.maxBatchesPerTick && unsent.length > 0;) {
      const batch = batchesOf(unsent, bounds.maxGroups, bounds.maxItems)[0]!;
      const outcome = await this.send(times, batch, report, faults);
      if (outcome === 'stop') break;
      if (outcome === 'sent') sent++;
      const done = new Set(batch.flatMap((g) => g.calls.map((c) => c.requestDigest)));
      unsent = unsent
        .filter((g) => !faults.setAside.has(groupKey(g)))
        .map((g) => ({ ...g, calls: g.calls.filter((c) => !done.has(c.requestDigest)) }))
        .filter((g) => g.calls.length > 0);
    }
    return report;
  }

  private async resolveNow(): Promise<void> {
    const { chain, ledger } = this.deps;
    for (const batch of ledger.pendingBatches()) {
      let outcome = await this.outcomeOf(batch);
      if (!outcome) {
        if (batch.nonce === null) continue;
        if ((await chain.getMinedNonce(batch.wallet)) <= batch.nonce) {
          // Not mined, and nothing else used its nonce: perhaps never sent, as when the node stopped after recording it.
          // Sent again as it was signed, it lands at most once; the next tick reads what became of it. One sped up was
          // on the network, and its first bytes would only be refused as underpriced.
          if (batch.signedTx && batch.hashes.length === 1) await this.rebroadcast(batch.signedTx);
          continue;
        }
        // The nonce has passed it: mined since the read above, or never to be.
        outcome = await this.outcomeOf(batch);
        if (!outcome) {
          await this.resolveByNonces(batch);
          continue;
        }
      }
      if ('landed' in outcome) await this.landed(batch, outcome.landed);
      else await ledger.recordReverted(batch.batchId);
    }
  }

  private async rebroadcast(signedTx: string): Promise<void> {
    try {
      await this.deps.chain.rebroadcastReceiptBatch(signedTx);
    } catch (err) {
      this.deps.log?.(`[marketplace] a receipt batch was not sent again: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** What became of the first of the batch's transactions to be mined: its first, or a speed-up; `null` while none is. */
  private async outcomeOf(batch: BatchRecord): Promise<ReceiptBatchOutcome> {
    for (const hash of batch.hashes) {
      const outcome = await this.deps.chain.getReceiptBatchOutcome(hash);
      if (outcome) return outcome;
    }
    return null;
  }

  private async readyGroups(epoch: number, completedBy: number, identity: bigint): Promise<Group[]> {
    const { chain, ledger } = this.deps;
    const ready = ledger.inState('served', epoch).filter((c) => c.receipt.completedAt <= completedBy).sort(byLandingOrder);
    const byBudget = new Map<string, ServedCall[]>();
    for (const c of await this.withoutUsedNonces(ready, identity)) {
      const key = `${c.subscriptionId}:${c.budgetIndex}`;
      const calls = byBudget.get(key) ?? [];
      calls.push(c);
      byBudget.set(key, calls);
    }
    const groups: Group[] = [];
    for (const calls of byBudget.values()) {
      const { subscriptionId, budgetIndex } = calls[0]!;
      // A budget with nothing left would count nothing; a top-up brings it back.
      if ((await chain.budgetLeft(subscriptionId, budgetIndex)) === 0n) continue;
      groups.push({ subscriptionId, budgetIndex, calls });
    }
    return groups;
  }

  /** The calls whose nonces the chain has not seen used; those it has are marked `landed`. */
  private async withoutUsedNonces(calls: ServedCall[], identity: bigint): Promise<ServedCall[]> {
    const words = new Map<string, bigint>();
    const used: string[] = [];
    const fresh: ServedCall[] = [];
    for (const c of calls) {
      const nonce = BigInt(c.request.nonce);
      const key = `${c.subscriptionId}:${nonce >> 8n}`;
      if (!words.has(key)) words.set(key, await this.deps.chain.nonceWord(c.subscriptionId, identity, nonce >> 8n));
      if ((words.get(key)! >> (nonce & 0xffn)) & 1n) used.push(c.requestDigest);
      else fresh.push(c);
    }
    await this.deps.ledger.recordLanded(null, null, used);
    return fresh;
  }

  /**
   * Simulate, drop faults, send and record one batch: `sent`; `empty` when no
   * group was left to send; `stop`, which ends the tick's sending. A group past
   * `maxFaultDrops` this tick is set aside, its receipts left `served`, and the
   * batch goes on without it.
   */
  private async send(
    times: EpochTimes,
    batch: Group[],
    report: Extract<LandingReport, { sent: unknown }>,
    faults: TickFaults,
  ): Promise<'sent' | 'empty' | 'stop'> {
    const { chain, ledger, settings: s } = this.deps;
    let groups = batch.map((g) => ({ ...g, calls: [...g.calls] }));
    while (groups.length > 0) {
      const batchId = ethers.hexlify(ethers.randomBytes(16));
      const digests = groups.flatMap((g) => g.calls.map((c) => c.requestDigest));
      let broadcast = false;
      try {
        const landed = await chain.submitReceiptBatch(groups.map(groupOf), {
          onBroadcast: async (signal) => {
            await ledger.recordSent({
              batchId, epoch: times.epoch, at: times.now, hash: signal.txHash, wallet: signal.wallet, nonce: signal.nonce ?? null, digests,
              signedTx: signal.signedTx,
            });
            broadcast = true;
          },
          onBeforeReplacementBroadcast: (signal) => ledger.recordSpeedup(batchId, signal.txHash),
        });
        await this.landed(ledger.batch(batchId)!, landed);
        report.sent.push({ batchId, txHash: landed.hash, items: landed.itemCount, value: landed.value, counted: landed.counted });
        return 'sent';
      } catch (err) {
        if (broadcast) {
          // Mined and reverted: back to `served`. Not known yet: it stays `sent`, for the next tick to resolve.
          if ((err as { receipt?: { status?: number } }).receipt?.status === 0) await ledger.recordReverted(batchId);
          else report.waiting = true;
          return 'stop';
        }
        const fault = receiptBatchFaultOf(err);
        const group = fault ? groups[fault.groupIndex] : undefined;
        if (!fault || !group) {
          this.retry = true;
          if (enrichEvmError(err) !== 'NoNodeScore') {
            this.deps.log?.(`[marketplace] a receipt batch was not sent: ${err instanceof Error ? err.message : String(err)}`);
          }
          return 'stop';
        }
        const key = groupKey(group);
        const drops = faults.drops.get(key) ?? 0;
        if (drops >= s.maxFaultDrops) {
          // Its faults are its own: it waits for a later tick, and the rest of the batch goes on.
          faults.setAside.add(key);
          groups = groups.filter((g) => g !== group);
          this.deps.log?.(`[marketplace] a receipt batch was not sent with the receipts of ${key}: ${fault.fault} after ${drops} dropped this tick; they wait for a later tick`);
          continue;
        }
        faults.drops.set(key, drops + 1);
        const dropped = fault.itemIndex === null ? group.calls : [group.calls[fault.itemIndex]!];
        for (const c of dropped) await ledger.recordRefused(c.requestDigest, fault.fault);
        report.refused += dropped.length;
        group.calls = group.calls.filter((c) => !dropped.includes(c));
        groups = groups.filter((g) => g.calls.length > 0);
      }
    }
    return 'empty';
  }

  /** A batch that landed: its receipts `landed`, each counted its part of what its group counted, oldest first. */
  private async landed(batch: BatchRecord, landed: ReceiptBatch): Promise<void> {
    const calls = batch.digests.map((d) => this.deps.ledger.served(d)).filter((c): c is ServedCall => c !== undefined).sort(byLandingOrder);
    const counted: Record<string, string> = {};
    for (const group of landed.groups) {
      let left = group.counted;
      for (const c of calls) {
        if (c.subscriptionId.toLowerCase() !== group.subscriptionId.toLowerCase() || c.budgetIndex !== group.budgetIndex) continue;
        const value = BigInt(c.receipt.valueWei);
        const part = value < left ? value : left;
        counted[c.requestDigest] = part.toString();
        left -= part;
      }
    }
    await this.deps.ledger.recordLanded(batch.batchId, { hash: landed.hash, blockNumber: landed.blockNumber, gasUsed: landed.gasUsed }, batch.digests, counted);
  }

  /** A batch none of whose transactions is mined, though its wallet's nonce has passed it. */
  private async resolveByNonces(batch: BatchRecord): Promise<void> {
    const calls = batch.digests.map((d) => this.deps.ledger.served(d)).filter((c): c is ServedCall => c !== undefined);
    await this.withoutUsedNonces(calls, await this.deps.chain.getIdentityId());
    await this.deps.ledger.recordReverted(batch.batchId);
  }

  /** A budget whose receipts not landed reach `nearLimitShare` of what it has left. */
  private async nearLimit(epoch: number): Promise<boolean> {
    const { chain, ledger, settings: s } = this.deps;
    if (s.nearLimitShare <= 0) return false;
    const share = BigInt(Math.round(s.nearLimitShare * 10_000));
    const budgets = new Map(ledger.inState('served', epoch).map((c) => [`${c.subscriptionId}:${c.budgetIndex}`, c] as const));
    for (const { subscriptionId, budgetIndex } of budgets.values()) {
      const left = await chain.budgetLeft(subscriptionId, budgetIndex);
      if (ledger.unlanded(subscriptionId, budgetIndex) * 10_000n >= share * left) return true;
    }
    return false;
  }
}

function groupOf(g: Group): ReceiptGroup {
  return { subscriptionId: g.subscriptionId, budgetIndex: g.budgetIndex, minCounted: 0n, items: g.calls.map(receiptItemOfCall) };
}

/** Groups into batches of at most `maxGroups` groups and `maxItems` items; a group too large for one batch is split. */
export function batchesOf<G extends { calls: unknown[] }>(groups: G[], maxGroups: number, maxItems: number): G[][] {
  const batches: G[][] = [];
  let batch: G[] = [];
  let items = 0;
  for (const group of groups) {
    for (let i = 0; i < group.calls.length; ) {
      if (batch.length === maxGroups || items === maxItems) {
        batches.push(batch);
        batch = [];
        items = 0;
      }
      const take = Math.min(group.calls.length - i, maxItems - items);
      batch.push({ ...group, calls: group.calls.slice(i, i + take) });
      items += take;
      i += take;
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}
