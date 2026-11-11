// SPDX-License-Identifier: Apache-2.0

/**
 * The buyer's ledger (OT-RFC-27): what the buyer keeps of its access keys and
 * of its gateway's calls, in one journal, `buyer-ledger.jsonl`:
 *   - each access key as made (`key`), what its calls cost folded in once
 *     compacted, and its revocation (`revoke`);
 *   - each nonce taken (`nonce`), on disk before its request is signed;
 *   - each call's records (`call`): the first written before the call is
 *     sent, then what came back in its place. The record of a call accepted
 *     with its receipt carries what the call charges its key, so accepting a
 *     call and charging its key is one record;
 *   - each epoch made final (`final`): its reconciliation.
 * Every change goes through one append, under one lock, and is applied in the
 * order each kind needs (`takeNonce`, `recordSent`, `recordResult`). One
 * compaction rewrites the journal when an epoch is made final, from what the
 * journal holds: the epoch's calls and nonce counters go, what they cost and
 * what the epoch's end charges fold into each key's total, and its
 * reconciliation is kept.
 *
 * In memory it keeps the keys with what their calls in flight may still cost
 * (reservations, never written down), the calls not made final
 * (gateway-book.ts), the nonce counters and the epochs made final.
 *
 * A node that kept these in the gateway's and the access keys' own journals
 * (`buyer-receipts.jsonl`, `buyer-nonces.jsonl`, `access-keys.jsonl`) has
 * them read once, on its first start with the ledger: the ledger's journal is
 * written from them, on disk before anything is read from it, and they stay
 * where they are. Once the ledger's journal exists, it alone is read.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CallBook, type HeldReceipt } from './gateway-book.js';
import { Journal, KeyedLock } from './journal.js';
import type { KeptKey } from './keys.js';
import type { ReconciledRow } from './reconcile.js';

export const BUYER_LEDGER_FILE = 'buyer-ledger.jsonl';

/** An access key as made: its scopes and its secret's sha256; once compacted, what its calls cost until then, and the last one's time. */
export interface KeyRecord {
  keyId: string;
  hash: string;
  label: string;
  budget: string;
  services: string[] | null;
  rps: number;
  expiresAt: number | null;
  /** When it was made, in seconds. */
  at: number;
  spent?: string;
  lastUsedAt?: number | null;
}

/** What a call charges its key: wei, at a time in chain seconds. */
export interface KeyCharge {
  keyId: string;
  value: bigint;
  at: number;
}

type NonceRecord = { type: 'nonce'; epoch: number; subscriptionId: string; seller: string; nonce: string };
type CallRecord = { type: 'call'; charge?: { value: string; at: number } } & HeldReceipt;
type Entry =
  | ({ type: 'key' } & KeyRecord)
  | { type: 'revoke'; keyId: string; at: number }
  | NonceRecord
  | CallRecord
  | { type: 'final'; epoch: number; rows: ReconciledRow[] };

/** A key as the ledger holds it: as the node API shows it but `reserved`, with its secret's hash. */
interface HeldKey {
  key: KeptKey;
  hash: Buffer;
}

const keyOf = (r: KeyRecord): KeptKey => ({
  keyId: r.keyId, label: r.label, budget: r.budget, spent: r.spent ?? '0', services: r.services, rps: r.rps, expiresAt: r.expiresAt,
  revoked: false, lastUsedAt: r.lastUsedAt ?? null,
});

/** `spent` and `lastUsedAt` of a key record, a charge added: a call charged once its epoch is made final may be older than the last. */
function addCharge(k: { spent?: string; lastUsedAt?: number | null }, value: bigint, at: number): void {
  k.spent = (BigInt(k.spent ?? '0') + value).toString();
  k.lastUsedAt = Math.max(k.lastUsedAt ?? at, at);
}

export class BuyerLedger {
  /** The calls not made final, and what each may still cost. */
  readonly calls: CallBook;
  private readonly journal: Journal<Entry>;
  private readonly lock = new KeyedLock();
  private readonly keys = new Map<string, HeldKey>();
  /** keyId => what its calls in flight, or whose cost is not known yet, may still cost. */
  private readonly reserved = new Map<string, bigint>();
  /** Subscription id and seller => the last nonce taken. */
  private readonly nonces = new Map<string, bigint>();
  /** The epochs with calls or nonce counters not made final. */
  private readonly epochs = new Set<number>();
  private readonly finals = new Map<number, ReconciledRow[]>();
  private loading: Promise<void> | undefined;

  constructor(readonly dir: string) {
    this.journal = new Journal(join(dir, BUYER_LEDGER_FILE));
    this.calls = new CallBook(this);
  }

  /** The journal, read once, on first use; a read that fails is tried again at the next use. */
  load(): Promise<void> {
    if (!this.loading) {
      const loading = this.entries().then((entries) => this.replay(entries));
      loading.catch(() => {
        if (this.loading === loading) this.loading = undefined;
      });
      this.loading = loading;
    }
    return this.loading;
  }

  // ---------------------------------------------------------------- keys

  async keyList(): Promise<KeptKey[]> {
    await this.load();
    return [...this.keys.values()].map((k) => ({ ...k.key }));
  }

  /** Every key, with its secret's hash: the keys as held, not copies. */
  async heldKeys(): Promise<ReadonlyArray<Readonly<HeldKey>>> {
    await this.load();
    return [...this.keys.values()];
  }

  /** A key made, on disk then held: `null`, making nothing, when another key has its id, checked under the journal's lock. */
  async makeKey(record: KeyRecord): Promise<KeptKey | null> {
    await this.load();
    return this.lock.run('journal', async () => {
      if (this.keys.has(record.keyId)) return null;
      const entry = { type: 'key' as const, ...record };
      await this.journal.append(entry);
      this.apply(entry);
      return { ...this.keys.get(record.keyId)!.key };
    });
  }

  async revokeKey(keyId: string, at: number): Promise<KeptKey | null> {
    await this.load();
    if (!this.keys.has(keyId)) return null;
    await this.write({ type: 'revoke', keyId, at });
    return { ...this.keys.get(keyId)!.key };
  }

  /**
   * Reserve `value` of the key's budget for a call about to be sent: false,
   * reserving nothing, when what its calls cost, what is reserved and `value`
   * would pass its budget.
   */
  async reserve(keyId: string, value: bigint): Promise<boolean> {
    await this.load();
    const held = this.keys.get(keyId);
    if (!held) return false;
    if (BigInt(held.key.spent) + this.reservedOf(keyId) + value > BigInt(held.key.budget)) return false;
    this.hold(keyId, value);
    return true;
  }

  /** Reserve `value` whatever the key has left: a call whose cost is not known yet. */
  hold(keyId: string, value: bigint): void {
    this.reserved.set(keyId, this.reservedOf(keyId) + value);
  }

  release(keyId: string, value: bigint): void {
    const left = this.reservedOf(keyId) - value;
    if (left > 0n) this.reserved.set(keyId, left);
    else this.reserved.delete(keyId);
  }

  reservedOf(keyId: string): bigint {
    return this.reserved.get(keyId) ?? 0n;
  }

  // ------------------------------------------------------- nonces and calls

  /**
   * The next nonce for the seller on the subscription: taken at once, so two
   * calls never share one, then on disk before it is returned. A write that
   * fails leaves it taken.
   */
  async takeNonce(epoch: number, subscriptionId: string, seller: bigint): Promise<bigint> {
    await this.load();
    const key = `${subscriptionId}:${seller}`;
    const nonce = (this.nonces.get(key) ?? -1n) + 1n;
    this.nonces.set(key, nonce);
    this.epochs.add(epoch);
    await this.append({ type: 'nonce', epoch, subscriptionId, seller: seller.toString(), nonce: nonce.toString() });
    return nonce;
  }

  /** A call's first record: on disk before it is sent, and counted only then. A call that cannot be written down is not sent. */
  async recordSent(r: HeldReceipt): Promise<void> {
    await this.append({ type: 'call', ...r });
    this.calls.record(r);
  }

  /**
   * What came back for a sent call, in its record's place: counted at once,
   * then on disk; a write that fails still leaves it counted while the node
   * runs. A call accepted with its receipt carries `charge`, what it costs its
   * key, in the same record, and the key takes it once that record is on disk.
   */
  async recordResult(r: HeldReceipt, charge?: { value: bigint; at: number }): Promise<void> {
    this.epochs.add(r.epoch);
    this.calls.record(r);
    await this.append({ type: 'call', ...r, ...(charge ? { charge: { value: charge.value.toString(), at: charge.at } } : {}) });
    if (charge) this.charged(r.keyId, charge.value, charge.at);
  }

  /** The calls whose cost is not known, as read back, oldest epoch first: each its seller refused or never answered. */
  openCalls(): HeldReceipt[] {
    return [...this.epochs].sort((a, b) => a - b).flatMap((e) => this.calls.callsOf(e)).filter((r) => r.state === 'open');
  }

  // ------------------------------------------------------------- epochs

  /** The epochs before `epoch` with calls or nonce counters not made final. */
  epochsBefore(epoch: number): number[] {
    return [...this.epochs].filter((e) => e < epoch);
  }

  /** An epoch made final: its reconciliation. */
  final(epoch: number): ReconciledRow[] | undefined {
    return this.finals.get(epoch);
  }

  /**
   * The one compaction: `epoch`, of subscription `subscriptionId`, made final
   * with its reconciliation `rows`, and `charges`, what its calls whose cost
   * was not known charge their keys now that they landed. The journal is
   * rewritten from what it holds: the epoch's calls and nonce counters dropped,
   * what they and `charges` cost folded into each key's total. On disk, then
   * here; a rewrite that fails leaves both as they were.
   */
  async finalize(epoch: number, subscriptionId: string, rows: ReconciledRow[], charges: readonly KeyCharge[]): Promise<void> {
    await this.lock.run('journal', async () => {
      await this.journal.replace(compacted(await this.journal.read(), epoch, rows, charges));
    });
    for (const c of charges) this.charged(c.keyId, c.value, c.at);
    this.finals.set(epoch, rows);
    this.calls.drop(epoch, subscriptionId);
    this.epochs.delete(epoch);
    for (const key of this.nonces.keys()) if (key.startsWith(subscriptionId)) this.nonces.delete(key);
  }

  // --------------------------------------------------------- the journal

  /** An entry on disk, then applied. */
  private async write(entry: Exclude<Entry, CallRecord>): Promise<void> {
    await this.lock.run('journal', async () => {
      await this.journal.append(entry);
      this.apply(entry);
    });
  }

  /** An entry on disk; its caller applies it, before or after, as its kind needs. */
  private async append(entry: Entry): Promise<void> {
    await this.lock.run('journal', () => this.journal.append(entry));
  }

  /** The journal's entries; on a node's first start with the ledger, those of the journals it replaces, written as its own first. */
  private async entries(): Promise<Entry[]> {
    if (await exists(this.journal.file)) return this.journal.read();
    const entries = await legacyEntries(this.dir);
    if (entries.length > 0) await this.journal.replace(entries);
    return entries;
  }

  /** The journal read back: every entry applied, and each call from its last record, its charge counted once. */
  private replay(entries: readonly Entry[]): void {
    const calls = new Map<string, CallRecord>();
    for (const e of entries) {
      if (e.type === 'call') calls.set(e.callId, e);
      else this.apply(e);
    }
    for (const { type: _call, charge, ...call } of [...calls.values()].sort((a, b) => a.epoch - b.epoch)) {
      this.calls.restore(call);
      this.epochs.add(call.epoch);
      if (charge) this.charged(call.keyId, BigInt(charge.value), charge.at);
    }
  }

  private apply(e: Exclude<Entry, CallRecord>): void {
    switch (e.type) {
      case 'key': {
        const { type: _key, ...record } = e;
        this.keys.set(record.keyId, { key: keyOf(record), hash: Buffer.from(record.hash, 'hex') });
        return;
      }
      case 'revoke': {
        const held = this.keys.get(e.keyId);
        if (held) held.key.revoked = true;
        return;
      }
      case 'nonce': {
        const key = `${e.subscriptionId}:${e.seller}`;
        if (BigInt(e.nonce) > (this.nonces.get(key) ?? -1n)) this.nonces.set(key, BigInt(e.nonce));
        this.epochs.add(e.epoch);
        return;
      }
      case 'final':
        this.finals.set(e.epoch, e.rows);
        return;
    }
  }

  private charged(keyId: string, value: bigint, at: number): void {
    const held = this.keys.get(keyId);
    if (held) addCharge(held.key, value, at);
  }
}

/**
 * What `entries` hold, as one record each, with `epoch` made final: each key
 * with what the epoch's calls and `charges` cost folded into its total, its
 * revocation, each epoch made final, each other epoch's nonce counters and the
 * last record of each of its calls, in the order they were first written.
 */
function compacted(entries: readonly Entry[], epoch: number, rows: ReconciledRow[], charges: readonly KeyCharge[]): Entry[] {
  const keys = new Map<string, Extract<Entry, { type: 'key' }>>();
  const revokes: Entry[] = [];
  const finals = new Map<number, ReconciledRow[]>();
  const nonces = new Map<string, NonceRecord>();
  const calls = new Map<string, CallRecord>();
  for (const e of entries) {
    switch (e.type) {
      case 'key':
        keys.set(e.keyId, { ...e, spent: e.spent ?? '0', lastUsedAt: e.lastUsedAt ?? null });
        break;
      case 'revoke':
        revokes.push(e);
        break;
      case 'nonce': {
        const id = `${e.subscriptionId}:${e.seller}`;
        const kept = nonces.get(id);
        if (e.epoch !== epoch && (!kept || BigInt(e.nonce) > BigInt(kept.nonce))) nonces.set(id, e);
        break;
      }
      case 'call':
        calls.set(e.callId, e);
        break;
      case 'final':
        finals.set(e.epoch, e.rows);
        break;
    }
  }
  const charge = (keyId: string, value: bigint, at: number) => {
    const k = keys.get(keyId);
    if (k) addCharge(k, value, at);
  };
  // The epoch's calls leave the journal; what they charged stays in their keys' totals.
  for (const [callId, r] of calls) {
    if (r.epoch !== epoch) continue;
    if (r.charge) charge(r.keyId, BigInt(r.charge.value), r.charge.at);
    calls.delete(callId);
  }
  for (const c of charges) charge(c.keyId, c.value, c.at);
  finals.set(epoch, rows);
  return [
    ...keys.values(),
    ...revokes,
    ...[...finals].map(([e, r]) => ({ type: 'final' as const, epoch: e, rows: r })),
    ...nonces.values(),
    ...calls.values(),
  ];
}

// ------------------------------------------------------- the journals it replaces

type LegacyKeyEntry =
  | ({ type: 'make' } & KeyRecord)
  | { type: 'revoke'; keyId: string; at: number }
  | { type: 'use'; keyId: string; value: string; at: number };
type LegacyNonce = { epoch: number; subscriptionId: string; seller: string; nonce: string };
type LegacyFinal = { type: 'final'; epoch: number; rows: ReconciledRow[] };

/**
 * The journals the ledger replaces, as its entries: each key with what its
 * calls cost folded in, as the access keys folded them, its revocation, each
 * epoch made final, each nonce counter and each call's last record. A call's
 * cost is in its key's total already, so no call record carries a charge.
 */
async function legacyEntries(dir: string): Promise<Entry[]> {
  const keyLog = await new Journal<LegacyKeyEntry>(join(dir, 'access-keys.jsonl')).read();
  const nonceLog = await new Journal<LegacyNonce>(join(dir, 'buyer-nonces.jsonl')).read();
  const receipts = await new Journal<HeldReceipt | LegacyFinal>(join(dir, 'buyer-receipts.jsonl')).read();
  const keys = new Map<string, Extract<Entry, { type: 'key' }>>();
  const revokes: Entry[] = [];
  for (const e of keyLog) {
    if (e.type === 'make') {
      const { type: _make, ...record } = e;
      keys.set(record.keyId, { type: 'key', ...record });
    } else if (keys.has(e.keyId)) {
      if (e.type === 'revoke') revokes.push({ type: 'revoke', keyId: e.keyId, at: e.at });
      else addCharge(keys.get(e.keyId)!, BigInt(e.value), e.at);
    }
  }
  const nonces = new Map<string, NonceRecord>();
  for (const n of nonceLog) {
    const id = `${n.subscriptionId}:${n.seller}`;
    const kept = nonces.get(id);
    if (!kept || BigInt(n.nonce) > BigInt(kept.nonce)) nonces.set(id, { type: 'nonce', ...n });
  }
  const finals = new Map<number, ReconciledRow[]>();
  const calls = new Map<string, CallRecord>();
  for (const e of receipts) {
    if ((e as LegacyFinal).type === 'final') finals.set((e as LegacyFinal).epoch, (e as LegacyFinal).rows);
    else calls.set((e as HeldReceipt).callId, { type: 'call', ...(e as HeldReceipt) });
  }
  return [
    ...keys.values(),
    ...revokes,
    ...[...finals].map(([epoch, rows]) => ({ type: 'final' as const, epoch, rows })),
    ...nonces.values(),
    ...calls.values(),
  ];
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return false;
    throw err;
  }
}
