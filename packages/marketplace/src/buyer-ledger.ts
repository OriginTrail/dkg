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
 * order each kind needs (`takeNonce`, `recordSent`, `recordAccepted`,
 * `recordUnresolved`); an accepted call is settled here whole, its record,
 * its key's charge and the reservation it held given back. One compaction
 * rewrites the journal when an epoch is made final, from what the journal
 * holds: the epoch's calls and nonce counters go, what they cost and what the
 * epoch's end charges fold into each key's total, and its reconciliation is
 * kept.
 *
 * In memory it keeps the keys with what their calls in flight may still cost
 * (reservations, never written down), the calls not made final
 * (gateway-book.ts), the nonce counters and the epochs made final.
 *
 * A node that kept these in the gateway's and the access keys' own journals
 * (`buyer-receipts.jsonl`, `buyer-nonces.jsonl`, `access-keys.jsonl`) has
 * them read once, on its first start with the ledger: the ledger's journal is
 * written from them, on disk before anything is read from it, and they stay
 * where they are. Once the ledger's journal exists, it alone is read, so
 * nothing is written to it before that first read: every change waits for
 * `load`, and fails with it, until the journals it replaces are in.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CallBook, type HeldReceipt, type KeptReceipt } from './gateway-book.js';
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

type KeyEntry = { type: 'key' } & KeyRecord;
type RevokeEntry = { type: 'revoke'; keyId: string; at: number };
type NonceRecord = { type: 'nonce'; epoch: number; subscriptionId: string; seller: string; nonce: string };
type CallRecord = { type: 'call'; charge?: { value: string; at: number } } & HeldReceipt;
type Entry =
  | KeyEntry
  | RevokeEntry
  | NonceRecord
  | CallRecord
  | { type: 'final'; epoch: number; rows: ReconciledRow[] };

/** A nonce counter: one per subscription and seller. */
const counterOf = (n: { subscriptionId: string; seller: string }): string => `${n.subscriptionId}:${n.seller}`;

/** A key as the ledger holds it: as the node API shows it but `reserved`, with its secret's hash. */
interface HeldKey {
  key: KeptKey;
  hash: Buffer;
}

/** A key as the ledger hands it out: a copy, its fields read-only, its list of services too. */
export type KeyCopy = Readonly<Omit<KeptKey, 'services'>> & { readonly services: readonly string[] | null };

/** A key and its secret's hash as `heldKeys` hands them out: copies of both, read-only. */
export interface HeldKeyCopy {
  readonly key: KeyCopy;
  readonly hash: Buffer;
}

/** A key from its record: its list of services a copy, so the record's stays its caller's. */
const keyOf = (r: KeyRecord): KeptKey => ({
  keyId: r.keyId, label: r.label, budget: r.budget, spent: r.spent ?? '0', services: r.services && [...r.services], rps: r.rps,
  expiresAt: r.expiresAt, revoked: false, lastUsedAt: r.lastUsedAt ?? null,
});

/** A key as it leaves the ledger: a copy, its list of services too, so what is done to it changes nothing the ledger holds. */
const copyOf = (k: KeptKey): KeptKey => ({ ...k, services: k.services && [...k.services] });

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
    return [...this.keys.values()].map((k) => copyOf(k.key));
  }

  /** Every key, with its secret's hash: a copy of each, so what is done to one changes nothing the ledger holds. */
  async heldKeys(): Promise<readonly HeldKeyCopy[]> {
    await this.load();
    return [...this.keys.values()].map((k) => ({ key: copyOf(k.key), hash: Buffer.from(k.hash) }));
  }

  /** A key made, on disk then held: `null`, making nothing, when another key has its id, checked under the journal's lock. */
  async makeKey(record: KeyRecord): Promise<KeptKey | null> {
    await this.load();
    return this.lock.run('journal', async () => {
      if (this.keys.has(record.keyId)) return null;
      const entry: KeyEntry = { type: 'key', ...record };
      await this.journal.append(entry);
      this.apply(entry);
      return copyOf(this.keys.get(record.keyId)!.key);
    });
  }

  async revokeKey(keyId: string, at: number): Promise<KeptKey | null> {
    await this.load();
    if (!this.keys.has(keyId)) return null;
    await this.write({ type: 'revoke', keyId, at });
    return copyOf(this.keys.get(keyId)!.key);
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
    const counter = counterOf({ subscriptionId, seller: seller.toString() });
    const nonce = (this.nonces.get(counter) ?? -1n) + 1n;
    this.nonces.set(counter, nonce);
    this.epochs.add(epoch);
    await this.append({ type: 'nonce', epoch, subscriptionId, seller: seller.toString(), nonce: nonce.toString() });
    return nonce;
  }

  /** A call's first record: on disk before it is sent, and counted only then. A call that cannot be written down is not sent. */
  async recordSent(r: HeldReceipt): Promise<void> {
    await this.load();
    await this.append({ type: 'call', ...r });
    this.calls.record(r);
  }

  /**
   * A sent call accepted with its checked receipt, settled in its record's
   * place: counted at once at the receipt's value, then on disk with what it
   * charges its key, the receipt's value at `at` (chain seconds). Once that
   * record is on disk the key takes the charge, and the reservation the call
   * held of the key's budget is given back. A write that fails leaves the call
   * counted, its key not charged, and the reservation held.
   */
  async recordAccepted(r: KeptReceipt, at: number): Promise<void> {
    await this.load();
    // Read before the record takes the call's place: a call kept with its receipt no longer holds its key.
    const reserved = this.calls.isKeyHeld(r.callId) ? BigInt(r.request.maxValueWei) : 0n;
    const value = BigInt(r.receipt.valueWei);
    this.epochs.add(r.epoch);
    this.calls.record(r);
    await this.append({ type: 'call', ...r, charge: { value: value.toString(), at } });
    this.charged(r.keyId, value, at);
    this.release(r.keyId, reserved);
  }

  /**
   * What came back for a sent call whose cost is not known, in its record's
   * place: `refused`, its receipt failing a check, or `open`, its seller
   * refusing it or never answering. Counted at once, its key's reservation
   * still held, then on disk; a write that fails still leaves it counted while
   * the node runs.
   */
  async recordUnresolved(r: HeldReceipt): Promise<void> {
    await this.load();
    this.epochs.add(r.epoch);
    this.calls.record(r);
    await this.append({ type: 'call', ...r });
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
    await this.load();
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

  /** A key made or revoked: on disk, then applied. */
  private async write(entry: KeyEntry | RevokeEntry): Promise<void> {
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

  /**
   * The journal read back, as `fold` reads it: each key, then the revocations,
   * each epoch made final, each nonce counter, and each call from its last
   * record, oldest epoch first, its charge counted once.
   */
  private replay(entries: readonly Entry[]): void {
    const held = fold(entries);
    for (const k of held.keys.values()) this.apply(k);
    for (const r of held.revokes) this.apply(r);
    for (const [epoch, rows] of held.finals) this.finals.set(epoch, rows);
    for (const [counter, n] of held.nonces) {
      this.nonces.set(counter, BigInt(n.nonce));
      this.epochs.add(n.epoch);
    }
    for (const { type: _call, charge, ...call } of [...held.calls.values()].sort((a, b) => a.epoch - b.epoch)) {
      this.calls.restore(call);
      this.epochs.add(call.epoch);
      if (charge) this.charged(call.keyId, BigInt(charge.value), charge.at);
    }
  }

  private apply(e: KeyEntry | RevokeEntry): void {
    if (e.type === 'key') {
      const { type: _key, ...record } = e;
      this.keys.set(record.keyId, { key: keyOf(record), hash: Buffer.from(record.hash, 'hex') });
      return;
    }
    const held = this.keys.get(e.keyId);
    if (held) held.key.revoked = true;
  }

  private charged(keyId: string, value: bigint, at: number): void {
    const held = this.keys.get(keyId);
    if (held) addCharge(held.key, value, at);
  }
}

/** A journal as it is read: one record of each key, nonce counter, call and epoch made final, and every revocation, each in the order first written. */
interface Folded {
  keys: Map<string, KeyEntry>;
  revokes: RevokeEntry[];
  finals: Map<number, ReconciledRow[]>;
  /** Counter => the record of the highest nonce it took. */
  nonces: Map<string, NonceRecord>;
  /** Call id => its last record. */
  calls: Map<string, CallRecord>;
}

/**
 * The one reading of the journal, which the replay restores and the
 * compaction rewrites: each key's and each call's last record, each epoch's
 * last reconciliation, each counter's highest nonce, and every revocation.
 */
function fold(entries: readonly Entry[]): Folded {
  const folded: Folded = { keys: new Map(), revokes: [], finals: new Map(), nonces: new Map(), calls: new Map() };
  for (const e of entries) {
    switch (e.type) {
      case 'key':
        folded.keys.set(e.keyId, e);
        break;
      case 'revoke':
        folded.revokes.push(e);
        break;
      case 'nonce': {
        const kept = folded.nonces.get(counterOf(e));
        if (!kept || BigInt(e.nonce) > BigInt(kept.nonce)) folded.nonces.set(counterOf(e), e);
        break;
      }
      case 'call':
        folded.calls.set(e.callId, e);
        break;
      case 'final':
        folded.finals.set(e.epoch, e.rows);
        break;
    }
  }
  return folded;
}

/** A folded journal written out whole: the keys, the revocations, the epochs made final, the nonce counters, then the calls. */
function entriesOf(folded: Folded): Entry[] {
  return [
    ...folded.keys.values(),
    ...folded.revokes,
    ...[...folded.finals].map(([epoch, rows]) => ({ type: 'final' as const, epoch, rows })),
    ...folded.nonces.values(),
    ...folded.calls.values(),
  ];
}

/**
 * What `entries` hold, as `fold` reads them, with `epoch` made final: each key
 * with what the epoch's calls and `charges` cost folded into its total, its
 * revocation, each epoch made final, each other epoch's nonce counters and the
 * last record of each of its calls, in the order they were first written.
 */
function compacted(entries: readonly Entry[], epoch: number, rows: ReconciledRow[], charges: readonly KeyCharge[]): Entry[] {
  // The epoch's nonce counters leave the journal: it is read without them.
  const folded = fold(entries.filter((e) => e.type !== 'nonce' || e.epoch !== epoch));
  for (const [keyId, k] of folded.keys) folded.keys.set(keyId, { ...k, spent: k.spent ?? '0', lastUsedAt: k.lastUsedAt ?? null });
  const charge = (keyId: string, value: bigint, at: number) => {
    const k = folded.keys.get(keyId);
    if (k) addCharge(k, value, at);
  };
  // The epoch's calls leave the journal; what they charged stays in their keys' totals.
  for (const [callId, r] of folded.calls) {
    if (r.epoch !== epoch) continue;
    if (r.charge) charge(r.keyId, BigInt(r.charge.value), r.charge.at);
    folded.calls.delete(callId);
  }
  for (const c of charges) charge(c.keyId, c.value, c.at);
  folded.finals.set(epoch, rows);
  return entriesOf(folded);
}

// ------------------------------------------------------- the journals it replaces

type LegacyKeyEntry =
  | ({ type: 'make' } & KeyRecord)
  | { type: 'revoke'; keyId: string; at: number }
  | { type: 'use'; keyId: string; value: string; at: number };
type LegacyNonce = { epoch: number; subscriptionId: string; seller: string; nonce: string };
type LegacyFinal = { type: 'final'; epoch: number; rows: ReconciledRow[] };

const isLegacyFinal = (e: HeldReceipt | LegacyFinal): e is LegacyFinal => (e as LegacyFinal).type === 'final';

/**
 * The access keys' journal as the ledger's entries, folded as the access keys
 * folded it: each key as made last, with what its calls cost added to its
 * total, then each revocation of a key made before it. What names no key is
 * left out.
 */
function legacyKeyEntries(log: readonly LegacyKeyEntry[]): Entry[] {
  const keys = new Map<string, KeyEntry>();
  const revokes: RevokeEntry[] = [];
  for (const e of log) {
    if (e.type === 'make') {
      const { type: _make, ...record } = e;
      keys.set(record.keyId, { type: 'key', ...record });
    } else if (keys.has(e.keyId)) {
      if (e.type === 'revoke') revokes.push({ type: 'revoke', keyId: e.keyId, at: e.at });
      else addCharge(keys.get(e.keyId)!, BigInt(e.value), e.at);
    }
  }
  return [...keys.values(), ...revokes];
}

/**
 * The journals the ledger replaces, as its entries, folded and written out as
 * its own journal is: each key with what its calls cost folded in, as the
 * access keys folded them, its revocation, each epoch made final, each nonce
 * counter and each call's last record, copied as it was kept. A call's cost is
 * in its key's total already, so no call record carries a charge.
 */
async function legacyEntries(dir: string): Promise<Entry[]> {
  const keyLog = await new Journal<LegacyKeyEntry>(join(dir, 'access-keys.jsonl')).read();
  const nonceLog = await new Journal<LegacyNonce>(join(dir, 'buyer-nonces.jsonl')).read();
  const receipts = await new Journal<HeldReceipt | LegacyFinal>(join(dir, 'buyer-receipts.jsonl')).read();
  return entriesOf(fold([
    ...legacyKeyEntries(keyLog),
    ...nonceLog.map((n): NonceRecord => ({ type: 'nonce', ...n })),
    ...receipts.map((e): Entry => (isLegacyFinal(e) ? { type: 'final', epoch: e.epoch, rows: e.rows } : { type: 'call', ...e })),
  ]));
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
