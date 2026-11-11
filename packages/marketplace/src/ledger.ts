// SPDX-License-Identifier: Apache-2.0

/**
 * The seller's ledger (OT-RFC-27): every call it served, and what became of
 * its receipt. States: `served`, then `sent` in a batch, then `landed`,
 * `refused` (with the fault the chain named) or `missed` (the epoch ended
 * before it landed). A batch that reverts puts its receipts back to `served`.
 *
 * One journal, each change appended before it is acted on: a call before its
 * answer goes back, a batch before it is broadcast, with its wallet, nonce and
 * signed transaction, and each speed-up's hash before that is broadcast. So
 * after a crash every `sent` batch can be resolved from the chain, or sent
 * again as it was signed, and nothing is lost or sent twice.
 *
 * An ended epoch is pruned once none of its batches is still `sent`: its calls
 * give way to a summary, and its batches that landed are kept, which is what
 * Operate shows. Writes and pruning take turns.
 *
 * A journal that cannot be read is moved aside, and the ledger starts empty in
 * a new one; entries that lack the shape of their type are left out, after a
 * copy of the journal as it was. Each is logged.
 */
import { join } from 'node:path';
import { Journal, KeyedLock, setAside } from './journal.js';
import { receiptFromWire, requestFromWire, serveResultFromWire, serveUsageFromWire, type ReceiptWire, type ServeResult, type ServeUsage, type ServiceRequestWire } from './wire.js';

/** One served call, as the ledger keeps it. */
export interface ServedCall {
  requestDigest: string;
  subscriptionId: string;
  budgetIndex: number;
  /** The subscription's epoch. */
  epoch: number;
  /** The request as served: `seller` is this node's identity. */
  request: ServiceRequestWire;
  signature: string;
  receipt: ReceiptWire;
  receiptSignature: string;
  /** Text, or tool calls with text or none: what the receipt commits to. */
  result: ServeResult;
  /** How its units split; absent from calls served before it was kept. */
  usage?: ServeUsage;
  /** The peer that sent the call, as its connection authenticated it: the only one its answer goes to again. */
  peerId?: string;
}

export type ReceiptState = 'served' | 'sent' | 'landed' | 'refused' | 'missed';

/** A batch, from its send: its hashes (the first, then each speed-up's), wallet, nonce and calls; once landed, its transaction. */
export interface BatchRecord {
  batchId: string;
  epoch: number;
  /** Chain seconds when it was sent. */
  at: number;
  hashes: string[];
  wallet: string;
  nonce: number | null;
  /** Its first transaction as signed, which can be sent again; none in records from before it was kept, nor once pruned. */
  signedTx?: string;
  /** Its calls' request digests; none once its epoch is pruned. */
  digests: string[];
  items: number;
  state: 'sent' | 'landed' | 'reverted';
  txHash?: string;
  blockNumber?: number;
  gasUsed?: string;
  value?: string;
  counted?: string;
}

/** What an epoch's calls came to (the node API's `SellerStatus.ledger`). */
export interface EpochSummary {
  epoch: number;
  counts: Record<ReceiptState, number>;
  /** The value of receipts served or sent, not landed yet. */
  heldValue: string;
  landedValue: string;
  counted: string;
}

/** The transaction that landed a batch. */
export interface LandedTx {
  hash: string;
  blockNumber: number;
  gasUsed: bigint;
}

type Entry =
  | ({ type: 'served' } & ServedCall)
  | { type: 'sent'; batchId: string; epoch: number; at: number; hash: string; wallet: string; nonce: number | null; digests: string[]; signedTx?: string }
  | { type: 'speedup'; batchId: string; hash: string }
  | { type: 'landed'; batchId: string | null; tx: { hash: string; blockNumber: number; gasUsed: string } | null; digests: string[]; counted: Record<string, string> }
  | { type: 'reverted'; batchId: string }
  | { type: 'refused'; digest: string; fault: string }
  | { type: 'missed'; digests: string[] }
  | { type: 'summary'; summary: EpochSummary; batches: BatchRecord[] };

interface CallState {
  call: ServedCall;
  state: ReceiptState;
  fault?: string;
  counted?: bigint;
}

const isOpen = (state: ReceiptState) => state === 'served' || state === 'sent';

/**
 * Read errors for which the journal stays where it is and the load fails: those that may pass (the disk, or too
 * many open files), and a permission the operator can restore, whose journal still holds the epoch's receipts.
 */
const KEEPING_READ_ERRORS = new Set(['EAGAIN', 'EBUSY', 'EINTR', 'EIO', 'EMFILE', 'ENFILE', 'ENOMEM', 'EACCES', 'EPERM']);

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class SellerLedger {
  private readonly journal: Journal<unknown>;
  private readonly lock = new KeyedLock();
  private readonly calls = new Map<string, CallState>();
  private readonly batches = new Map<string, BatchRecord>();
  private readonly summaries = new Map<number, EpochSummary>();
  private readonly nonces = new Map<string, Set<string>>();
  /** subscription id and budget index => the value of its receipts served or sent. */
  private readonly open = new Map<string, bigint>();

  constructor(dir: string, private readonly log?: (message: string) => void) {
    this.journal = new Journal(join(dir, 'seller-ledger.jsonl'));
  }

  /**
   * Read the journal back. One that cannot be read is moved aside and the
   * ledger starts empty, in a new one: its calls are in the copy. Entries that
   * lack the shape of their type are left out, and the journal is written
   * again without them, after a copy of it as it was. A read error that may
   * pass (the disk, or too many open files), or a permission it lacks, fails
   * the load and moves nothing: selling stays off until it reads.
   */
  async load(): Promise<void> {
    const file = this.journal.file;
    let entries: unknown[];
    try {
      entries = await this.journal.read();
    } catch (err) {
      if (KEEPING_READ_ERRORS.has((err as { code?: string }).code ?? '')) throw err;
      const aside = await setAside(file);
      this.log?.(`[marketplace] the seller's ledger ${file} could not be read (${messageOf(err)}); it was moved to ${aside}, and the ledger starts empty`);
      return;
    }
    const kept = entriesFrom(entries);
    for (const entry of kept) this.apply(entry);
    const left = entries.length - kept.length;
    if (left === 0) return;
    try {
      const aside = await setAside(file, 'copy');
      await this.journal.replace(kept);
      this.log?.(`[marketplace] ${left} entries of the seller's ledger could not be read and were left out; the journal as it was is at ${aside}`);
    } catch (err) {
      this.log?.(`[marketplace] ${left} entries of the seller's ledger could not be read and were left out, but the journal was not copied and written again: ${messageOf(err)}`);
    }
  }

  // -------------------------------------------------------------- reads

  served(digest: string): ServedCall | undefined {
    return this.calls.get(digest)?.call;
  }

  stateOf(digest: string): ReceiptState | undefined {
    return this.calls.get(digest)?.state;
  }

  nonceUsed(subscriptionId: string, nonce: string): boolean {
    return this.nonces.get(subscriptionId)?.has(nonce) ?? false;
  }

  /** The value of a budget's receipts that have not landed, nor been refused or missed. */
  unlanded(subscriptionId: string, budgetIndex: number): bigint {
    return this.open.get(`${subscriptionId}:${budgetIndex}`) ?? 0n;
  }

  /** The calls in `state`, of `epoch` or of every epoch. */
  inState(state: ReceiptState, epoch?: number): ServedCall[] {
    return [...this.calls.values()].filter((c) => c.state === state && (epoch === undefined || c.call.epoch === epoch)).map((c) => c.call);
  }

  pendingBatches(): BatchRecord[] {
    return [...this.batches.values()].filter((b) => b.state === 'sent');
  }

  batch(batchId: string): BatchRecord | undefined {
    return this.batches.get(batchId);
  }

  /** The batches that landed, newest first, at most `limit`. */
  landedBatches(limit: number): BatchRecord[] {
    return [...this.batches.values()].filter((b) => b.state === 'landed').sort((a, b) => b.at - a.at).slice(0, limit);
  }

  /** The epochs it holds, with calls or pruned to a summary, oldest first. */
  epochs(): number[] {
    return [...new Set([...this.summaries.keys(), ...[...this.calls.values()].map((c) => c.call.epoch)])].sort((a, b) => a - b);
  }

  /** An epoch's counts by state, the value held, landed and counted, and its batches, oldest first. */
  epochReport(epoch: number): { summary: EpochSummary; batches: BatchRecord[] } {
    const batches = [...this.batches.values()].filter((b) => b.epoch === epoch);
    const kept = this.summaries.get(epoch);
    if (kept) return { summary: kept, batches };
    const counts: Record<ReceiptState, number> = { served: 0, sent: 0, landed: 0, refused: 0, missed: 0 };
    let held = 0n;
    let landed = 0n;
    let counted = 0n;
    for (const c of this.calls.values()) {
      if (c.call.epoch !== epoch) continue;
      counts[c.state]++;
      const value = BigInt(c.call.receipt.valueWei);
      if (isOpen(c.state)) held += value;
      if (c.state === 'landed') {
        landed += value;
        counted += c.counted ?? 0n;
      }
    }
    return { summary: { epoch, counts, heldValue: held.toString(), landedValue: landed.toString(), counted: counted.toString() }, batches };
  }

  // -------------------------------------------------------------- writes

  async recordServed(call: ServedCall): Promise<void> {
    await this.write({ type: 'served', ...call });
  }

  async recordSent(batch: {
    batchId: string; epoch: number; at: number; hash: string; wallet: string; nonce: number | null; digests: string[]; signedTx?: string;
  }): Promise<void> {
    await this.write({ type: 'sent', ...batch });
  }

  async recordSpeedup(batchId: string, hash: string): Promise<void> {
    await this.write({ type: 'speedup', batchId, hash });
  }

  /**
   * Receipts that landed: by a batch of this node's (`batchId`, with the
   * transaction that landed it), or seen landed by their nonces. `counted`
   * is what each counted, by request digest, where it is known.
   */
  async recordLanded(batchId: string | null, tx: LandedTx | null, digests: string[], counted: Record<string, string> = {}): Promise<void> {
    if (digests.length === 0 && !batchId) return;
    const landedTx = tx ? { hash: tx.hash, blockNumber: tx.blockNumber, gasUsed: tx.gasUsed.toString() } : null;
    await this.write({ type: 'landed', batchId, tx: landedTx, digests, counted });
  }

  async recordReverted(batchId: string): Promise<void> {
    await this.write({ type: 'reverted', batchId });
  }

  async recordRefused(digest: string, fault: string): Promise<void> {
    await this.write({ type: 'refused', digest, fault });
  }

  async recordMissed(digests: string[]): Promise<void> {
    if (digests.length > 0) await this.write({ type: 'missed', digests });
  }

  /** Prune the epochs before `beforeEpoch` that have no batch still `sent`. */
  async prune(beforeEpoch: number): Promise<void> {
    await this.lock.run('journal', async () => {
      const ended = new Set([...this.calls.values()].map((c) => c.call.epoch).filter((e) => e < beforeEpoch));
      for (const b of this.pendingBatches()) ended.delete(b.epoch);
      if (ended.size === 0) return;
      const kept: Entry[] = [];
      for (const epoch of new Set([...this.summaries.keys(), ...ended])) {
        const { summary, batches } = this.epochReport(epoch);
        kept.push({ type: 'summary', summary, batches: batches.filter((b) => b.state === 'landed').map(({ signedTx: _signed, ...b }) => ({ ...b, digests: [] })) });
      }
      for (const entry of entriesFrom(await this.journal.read())) {
        const epoch = this.epochOf(entry);
        if (entry.type !== 'summary' && !(epoch !== undefined && ended.has(epoch))) kept.push(entry);
      }
      await this.journal.replace(kept);
      for (const map of [this.calls, this.batches, this.summaries, this.nonces, this.open]) map.clear();
      for (const entry of kept) this.apply(entry);
    });
  }

  // ------------------------------------------------------------ the fold

  private async write(entry: Entry): Promise<void> {
    await this.lock.run('journal', async () => {
      await this.journal.append(entry);
      this.apply(entry);
    });
  }

  /** The epoch an entry belongs to, if it belongs to one. */
  private epochOf(entry: Entry): number | undefined {
    switch (entry.type) {
      case 'served': return entry.epoch;
      case 'sent': return entry.epoch;
      case 'speedup':
      case 'reverted': return this.batches.get(entry.batchId)?.epoch;
      // Neither is written without a receipt.
      case 'landed': return entry.batchId ? this.batches.get(entry.batchId)?.epoch : this.calls.get(entry.digests[0]!)?.call.epoch;
      case 'refused': return this.calls.get(entry.digest)?.call.epoch;
      case 'missed': return this.calls.get(entry.digests[0]!)?.call.epoch;
      default: return undefined;
    }
  }

  private apply(entry: Entry): void {
    switch (entry.type) {
      case 'served': {
        const { type: _served, ...call } = entry;
        this.calls.set(call.requestDigest, { call, state: 'served' });
        this.nonces.set(call.subscriptionId, (this.nonces.get(call.subscriptionId) ?? new Set<string>()).add(call.request.nonce));
        this.addOpen(call, 1n);
        return;
      }
      case 'sent':
        this.batches.set(entry.batchId, {
          batchId: entry.batchId, epoch: entry.epoch, at: entry.at, hashes: [entry.hash], wallet: entry.wallet, nonce: entry.nonce,
          digests: entry.digests, items: entry.digests.length, state: 'sent', signedTx: entry.signedTx,
        });
        for (const d of entry.digests) this.setState(d, 'sent');
        return;
      case 'speedup':
        this.batches.get(entry.batchId)?.hashes.push(entry.hash);
        return;
      case 'landed': {
        const batch = entry.batchId ? this.batches.get(entry.batchId) : undefined;
        if (batch) {
          batch.state = 'landed';
          if (entry.tx) Object.assign(batch, { txHash: entry.tx.hash, blockNumber: entry.tx.blockNumber, gasUsed: entry.tx.gasUsed });
          batch.value = batch.digests.reduce((v, d) => v + BigInt(this.calls.get(d)?.call.receipt.valueWei ?? '0'), 0n).toString();
          batch.counted = Object.values(entry.counted).reduce((v, c) => v + BigInt(c), 0n).toString();
        }
        for (const d of entry.digests) {
          const counted = entry.counted[d];
          this.setState(d, 'landed', counted === undefined ? {} : { counted: BigInt(counted) });
        }
        return;
      }
      case 'reverted': {
        const batch = this.batches.get(entry.batchId);
        if (!batch) return;
        batch.state = 'reverted';
        for (const d of batch.digests) if (this.calls.get(d)?.state === 'sent') this.setState(d, 'served');
        return;
      }
      case 'refused':
        this.setState(entry.digest, 'refused', { fault: entry.fault });
        return;
      case 'missed':
        for (const d of entry.digests) this.setState(d, 'missed');
        return;
      case 'summary':
        this.summaries.set(entry.summary.epoch, entry.summary);
        for (const b of entry.batches) this.batches.set(b.batchId, b);
        return;
    }
  }

  private setState(digest: string, state: ReceiptState, more: Pick<CallState, 'fault' | 'counted'> = {}): void {
    const c = this.calls.get(digest);
    if (!c) return;
    // A receipt only leaves the open states: `sent` goes back to `served`, and nothing comes back from the others.
    if (isOpen(c.state) && !isOpen(state)) this.addOpen(c.call, -1n);
    this.calls.set(digest, { ...c, state, ...more });
  }

  private addOpen(call: ServedCall, sign: bigint): void {
    const key = `${call.subscriptionId}:${call.budgetIndex}`;
    this.open.set(key, (this.open.get(key) ?? 0n) + sign * BigInt(call.receipt.valueWei));
  }
}

// ----------------------------------------------------- entries read back

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isDecimal = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isNonce = (v: unknown) => v === null || isWhole(v);

/**
 * A served call as landing reads it, or `null`: its request and receipt as the wire takes them, and its result and
 * usage as the wire decodes them, in their places, so a well-formed line written again is the same line.
 */
function servedCallFrom(e: Record<string, unknown>): Entry | null {
  let result: ServeResult;
  try {
    requestFromWire(e.request);
    receiptFromWire(e.receipt);
    result = serveResultFromWire(e.result);
  } catch {
    return null;
  }
  const usage = e.usage === undefined ? undefined : serveUsageFromWire(e.usage);
  const ok = isString(e.requestDigest) && isString(e.subscriptionId) && isWhole(e.budgetIndex) && isWhole(e.epoch)
    && isString(e.signature) && isString(e.receiptSignature)
    && (e.usage === undefined || usage !== undefined)
    && (e.peerId === undefined || isString(e.peerId));
  return ok ? ({ ...e, result, ...(usage ? { usage } : {}) } as Entry) : null;
}

function isBatchRecord(b: unknown): boolean {
  return isRecord(b) && isString(b.batchId) && isWhole(b.epoch) && isWhole(b.at) && isStrings(b.hashes) && isString(b.wallet)
    && isNonce(b.nonce) && isStrings(b.digests) && isWhole(b.items) && ['sent', 'landed', 'reverted'].includes(b.state as string);
}

/**
 * A line read back from the journal as the entry the ledger keeps, or `null` for one that lacks the shape of its type:
 * one that did not would stop every tick that reads it. The one way in from the journal, for the load and a prune
 * alike: a served call is decoded (`servedCallFrom`), every other known entry checked and kept as it is, and an entry of
 * a type this version does not know is kept, and ignored.
 */
function entryFrom(e: unknown): Entry | null {
  if (!isRecord(e)) return null;
  const checked = (ok: boolean) => (ok ? (e as Entry) : null);
  switch (e.type) {
    case 'served': return servedCallFrom(e);
    case 'sent':
      return checked(isString(e.batchId) && isWhole(e.epoch) && isWhole(e.at) && isString(e.hash) && isString(e.wallet) && isNonce(e.nonce)
        && isStrings(e.digests) && (e.signedTx === undefined || isString(e.signedTx)));
    case 'speedup': return checked(isString(e.batchId) && isString(e.hash));
    case 'landed':
      return checked((e.batchId === null || isString(e.batchId)) && isStrings(e.digests) && isRecord(e.counted) && Object.values(e.counted).every(isDecimal)
        && (e.tx === null || (isRecord(e.tx) && isString(e.tx.hash) && isWhole(e.tx.blockNumber) && isDecimal(e.tx.gasUsed))));
    case 'reverted': return checked(isString(e.batchId));
    case 'refused': return checked(isString(e.digest) && isString(e.fault));
    case 'missed': return checked(isStrings(e.digests));
    case 'summary':
      return checked(isRecord(e.summary) && isWhole(e.summary.epoch) && isRecord(e.summary.counts) && Array.isArray(e.batches) && e.batches.every(isBatchRecord));
    default: return checked(isString(e.type));
  }
}

/** The lines read back from the journal as the entries the ledger keeps, those that lack their shape left out. */
function entriesFrom(lines: readonly unknown[]): Entry[] {
  return lines.flatMap((line) => {
    const entry = entryFrom(line);
    return entry ? [entry] : [];
  });
}
