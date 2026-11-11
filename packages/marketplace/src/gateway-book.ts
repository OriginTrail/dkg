// SPDX-License-Identifier: Apache-2.0

/**
 * The gateway's book of calls (OT-RFC-27): every call it sends, from the record
 * written before it goes to its epoch made final, and what each may still cost.
 *   - A call's first record, written before it is sent, is `open`: a call the
 *     node stops waiting for still counts after a restart. What came back
 *     takes its place: `held` with its receipt checked, `refused` with a
 *     receipt that failed a check, or still `open` (refused or unanswered).
 *   - Until the chain shows its nonce used, a call counts against its budget
 *     at what it may still cost: its receipt's value once checked, otherwise
 *     the most its request allows, since its seller may land a receipt for any
 *     request the session key signed.
 *   - A refused or open call keeps its key's reservation of that most value
 *     until the gateway knows whether it landed (`release`).
 *   - It counts the calls each seller refused or never answered in an epoch.
 */
import type { AccessKeys } from './keys.js';
import type { ReceiptWire, ServiceRequestWire } from './wire.js';

/**
 * A call the buyer keeps, from before it is sent: `held`, its receipt checked, until it lands; `refused`, its
 * receipt failing the check `problem` names; or `open`, with no receipt, as its seller refused it (`problem` is the
 * seller's code), never answered (`unanswered`), or the node stopped while it waited (`sent`).
 */
export interface HeldReceipt {
  callId: string;
  /** The subscription's epoch. */
  epoch: number;
  subscriptionId: string;
  budgetIndex: number;
  seller: string;
  keyId: string;
  request: ServiceRequestWire;
  signature: string;
  /** The seller's receipt: as decoded once checked, as its seller sent it when refused, none on an open call. */
  receipt?: ReceiptWire;
  receiptSignature?: string;
  state: 'held' | 'refused' | 'open';
  problem?: string;
}

export type KeptReceipt = HeldReceipt & { state: 'held'; receipt: ReceiptWire };

export const isKept = (r: HeldReceipt): r is KeptReceipt => r.state === 'held' && r.receipt !== undefined;

/** What a call may still cost: its receipt's value once checked, otherwise the most its request allows. */
export const exposureOf = (r: HeldReceipt): bigint => (isKept(r) ? BigInt(r.receipt.valueWei) : BigInt(r.request.maxValueWei));

const budgetOf = (r: HeldReceipt): string => `${r.subscriptionId}:${r.budgetIndex}`;

export class CallBook {
  /** The calls of each epoch not made final, by call id, in the order sent. */
  private readonly byEpoch = new Map<number, Map<string, HeldReceipt>>();
  /** The calls not seen landed, by call id. */
  private readonly unlanded = new Map<string, HeldReceipt>();
  /** subscription id and budget index => what its calls not seen landed may still cost. */
  private readonly held = new Map<string, bigint>();
  /** The refused and open calls whose most value their key still reserves, by call id. */
  private readonly keyHolds = new Map<string, HeldReceipt>();
  /** Epoch and seller => the calls that seller refused or never answered in it. */
  private readonly unsettled = new Map<string, number>();

  constructor(private readonly keys: Pick<AccessKeys, 'hold' | 'release'>) {}

  /** What a budget's calls not seen landed may still cost; `budget` is its subscription id and index. */
  heldValue(budget: string): bigint {
    return this.held.get(budget) ?? 0n;
  }

  /** The calls of an epoch not made final, in the order sent. */
  callsOf(epoch: number): HeldReceipt[] {
    return [...(this.byEpoch.get(epoch)?.values() ?? [])];
  }

  /** The calls of `epoch` not seen landed. */
  unlandedOf(epoch: number): HeldReceipt[] {
    return [...this.unlanded.values()].filter((r) => r.epoch === epoch);
  }

  /** The refused and open calls of epochs before `epoch` whose key still reserves their most value. */
  keyHeldBefore(epoch: number): HeldReceipt[] {
    return [...this.keyHolds.values()].filter((r) => r.epoch < epoch);
  }

  isKeyHeld(callId: string): boolean {
    return this.keyHolds.has(callId);
  }

  /**
   * A live call's record: the first, written before it is sent, whose key reservation the call already holds; then
   * what came back, in its place. A record that replaces one keeps the key's reservation while its cost is not
   * known, and gives it up once its receipt is checked: the caller settles the key.
   */
  record(r: HeldReceipt): void {
    let calls = this.byEpoch.get(r.epoch);
    if (!calls) this.byEpoch.set(r.epoch, (calls = new Map()));
    const before = calls.get(r.callId);
    calls.set(r.callId, r);
    const budget = budgetOf(r);
    if (!before) {
      this.unlanded.set(r.callId, r);
      this.held.set(budget, (this.held.get(budget) ?? 0n) + exposureOf(r));
    } else if (this.unlanded.has(r.callId)) {
      this.unlanded.set(r.callId, r);
      this.held.set(budget, (this.held.get(budget) ?? 0n) - exposureOf(before) + exposureOf(r));
    }
    if (isKept(r)) this.keyHolds.delete(r.callId);
    else if (!before || this.keyHolds.has(r.callId)) this.keyHolds.set(r.callId, r);
  }

  /** A call's last record, read back at load: counted, and its key's reservation held again while its cost is not known. */
  restore(r: HeldReceipt): void {
    this.record(r);
    if (this.keyHolds.has(r.callId)) this.keys.hold(r.keyId, exposureOf(r));
  }

  /** A call seen landed: out of the value its budget's calls may still cost. */
  landed(r: HeldReceipt): void {
    const kept = this.unlanded.get(r.callId);
    if (!kept) return;
    this.unlanded.delete(r.callId);
    const budget = budgetOf(kept);
    this.held.set(budget, (this.held.get(budget) ?? 0n) - exposureOf(kept));
  }

  /** A refused or open call's reservation of its key's budget, released. */
  release(r: HeldReceipt): void {
    const kept = this.keyHolds.get(r.callId);
    if (!kept) return;
    this.keyHolds.delete(r.callId);
    this.keys.release(kept.keyId, exposureOf(kept));
  }

  /** One more call its seller refused or never answered in its epoch: how many so far. */
  unsettledBy(r: HeldReceipt): number {
    const key = `${r.epoch}:${r.seller}`;
    const count = (this.unsettled.get(key) ?? 0) + 1;
    this.unsettled.set(key, count);
    return count;
  }

  /** An epoch made final: its calls leave the book, landed or not, their keys released, and the budgets of `subscriptionId` with them. */
  drop(epoch: number, subscriptionId: string): void {
    for (const r of this.callsOf(epoch)) {
      this.landed(r);
      this.release(r);
    }
    this.byEpoch.delete(epoch);
    for (const key of this.held.keys()) if (key.startsWith(subscriptionId)) this.held.delete(key);
    for (const key of this.unsettled.keys()) if (key.startsWith(`${epoch}:`)) this.unsettled.delete(key);
  }
}
