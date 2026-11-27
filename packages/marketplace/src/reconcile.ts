// SPDX-License-Identifier: Apache-2.0

/**
 * The buyer's reconciliation (OT-RFC-27): what became of the receipts it
 * holds for a subscription, per seller and budget.
 *   - **Held**: its receipts whose nonce the chain has not seen used. A used
 *     nonce means the seller landed a receipt for that request.
 *   - **Landed**: the groups `ReceiptsLanded` logged for the subscription,
 *     their value, what of it counted, and their transactions.
 *   - **Matched**: the landed receipts that are the node's own. A group's
 *     `groupDigest` is the hash of its receipt digests in order, and sellers
 *     land oldest first, so a group of the node's receipts is a run of those
 *     whose nonces are used, in that order. A group that is no such run (a
 *     receipt the node never took, say) lands but does not match.
 */
import {
  hashQueryInferenceReceipt,
  receiptsDigest,
  type LandedGroup,
  type MarketplaceDomain,
} from '@origintrail-official/dkg-chain';
import { byLandingOrder } from './landing.js';
import { amount } from './views.js';
import { receiptFromWire, type ReceiptWire, type ServiceRequestWire } from './wire.js';

/** A receipt the buyer holds, as reconciliation reads it. */
export interface HeldReceiptRef {
  callId: string;
  subscriptionId: string;
  budgetIndex: number;
  seller: string;
  request: ServiceRequestWire;
  receipt: ReceiptWire;
}

/** One row: a seller on a budget (the node API's `Reconciled`), with how many landed receipts are the node's own. */
export interface ReconciledRow {
  subscriptionId: string;
  budgetIndex: number;
  serviceId: string;
  seller: number;
  held: { count: number; value: string; valueTrac: string };
  landed: { count: number; matched: number; value: string; valueTrac: string; counted: string; countedTrac: string; txs: string[] };
}

type Row = {
  key: { subscriptionId: string; budgetIndex: number; seller: string };
  receipts: HeldReceiptRef[];
  /** The receipts whose nonces are used and no landed group matched yet, in landing order, with their digests and values. */
  open: Array<{ receipt: HeldReceiptRef; digest: string; value: bigint }>;
  landed: { count: number; matched: number; value: bigint; counted: bigint; txs: string[] };
};

/**
 * The rows of one subscription: the receipts the node holds for it, the groups
 * landed for it, oldest first, whether a receipt's nonce is used, and the
 * service of each budget.
 */
export function reconcileSubscription(
  domain: MarketplaceDomain,
  receipts: readonly HeldReceiptRef[],
  landed: readonly LandedGroup[],
  used: (receipt: HeldReceiptRef) => boolean,
  serviceOf: (budgetIndex: number) => string,
): ReconciledRow[] {
  const rows = new Map<string, Row>();
  const rowOf = (subscriptionId: string, budgetIndex: number, seller: string): Row => {
    const id = `${budgetIndex}:${seller}`;
    let row = rows.get(id);
    if (!row) {
      row = { key: { subscriptionId: subscriptionId.toLowerCase(), budgetIndex, seller }, receipts: [], open: [], landed: { count: 0, matched: 0, value: 0n, counted: 0n, txs: [] } };
      rows.set(id, row);
    }
    return row;
  };
  for (const r of receipts) rowOf(r.subscriptionId, r.budgetIndex, r.seller).receipts.push(r);
  for (const row of rows.values()) {
    row.receipts.sort(byLandingOrder);
    row.open = row.receipts.filter(used).map((r) => ({
      receipt: r, digest: hashQueryInferenceReceipt(domain, receiptFromWire(r.receipt)), value: BigInt(r.receipt.valueWei),
    }));
  }
  for (const group of landed) {
    const row = rowOf(group.subscriptionId, group.budgetIndex, group.seller.toString());
    const start = runOf(row.open, group);
    if (start !== null) {
      row.open.splice(start, group.itemCount);
      row.landed.matched += group.itemCount;
    }
    row.landed.count += group.itemCount;
    row.landed.value += group.value;
    row.landed.counted += group.counted;
    if (!row.landed.txs.includes(group.txHash)) row.landed.txs.push(group.txHash);
  }
  return [...rows.values()].map(({ key, receipts: held, landed: l }) => {
    const left = held.filter((r) => !used(r));
    return {
      ...key,
      seller: Number(key.seller),
      serviceId: serviceOf(key.budgetIndex),
      held: { count: left.length, ...amount('value', left.reduce((v, r) => v + BigInt(r.receipt.valueWei), 0n)) },
      landed: { count: l.count, matched: l.matched, ...amount('value', l.value), ...amount('counted', l.counted), txs: l.txs },
    };
  }).sort((a, b) => a.budgetIndex - b.budgetIndex || a.seller - b.seller);
}

/** Where the run of receipts that hashes to the group's digest starts; `null` when none does. Only runs of the group's value are hashed. */
function runOf(open: ReadonlyArray<{ digest: string; value: bigint }>, group: LandedGroup): number | null {
  const n = group.itemCount;
  let value = open.slice(0, n).reduce((v, o) => v + o.value, 0n);
  for (let start = 0; start + n <= open.length; start++) {
    if (start > 0) value += open[start + n - 1]!.value - open[start - 1]!.value;
    if (value === group.value && receiptsDigest(open.slice(start, start + n).map((o) => o.digest)) === group.groupDigest) return start;
  }
  return null;
}
