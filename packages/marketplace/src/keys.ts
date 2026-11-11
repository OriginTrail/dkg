// SPDX-License-Identifier: Apache-2.0

/**
 * Access keys (OT-RFC-27): what the node's own agents and scripts call
 * the gateway with. A key spends the buyer's subscription through the node; it
 * cannot touch a wallet, and it opens no other route of the node's API. A
 * node or agent token is not a key.
 *   - The secret is shown once, when the key is made; the node keeps only its
 *     sha256, and compares hashes in constant time.
 *   - Its id is the secret's first `KEY_ID_HEX` hex digits after the prefix,
 *     64 bits; a new key whose id another key has is made again. Keys made
 *     with 10.1.0's 8-digit ids keep them.
 *   - Each key has a label, a budget in wei, the services it may call (or all),
 *     a rate in calls per second, and an expiry.
 *   - A revocation takes effect at the next call.
 *   - A key's budget holds across its calls at once: each call reserves the
 *     most it may cost before it is sent, and is charged what it cost after.
 *     A call whose cost is not known yet (one its seller refused or never
 *     answered) keeps its reservation until the gateway knows. A key shows
 *     what its calls hold so (`reserved`) beside what they cost (`spent`).
 * Kept in a journal: makes, revocations, and what each call cost. The journal
 * is read once; the keys are kept in memory and every append updates them.
 * `compact` folds each key's calls into its total: the gateway's job runs it,
 * and so does every `compactEvery`th charge, so the journal stays short.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { Journal, KeyedLock } from './journal.js';

const PREFIX = 'dkgmk_';
/** Charges between two compactions of the journal. */
export const KEYS_COMPACT_EVERY = 1_000;
/** Hex digits of a key's id after its prefix: 64 bits. 10.1.0 made ids of 8. */
export const KEY_ID_HEX = 16;
/** How many secrets a key's making draws before it gives up on an id of its own. */
const MAKE_ATTEMPTS = 8;

export interface AccessKeyScopes {
  label: string;
  /** The most the key's calls may cost together, in wei. */
  budget: bigint;
  /** Service ids it may call; `null` for every service the subscription funds. */
  services: string[] | null;
  rps: number;
  /** Chain seconds; `null` for no expiry. */
  expiresAt: number | null;
}

/** A key as the node API shows it (`Key`), never with its secret. */
export interface AccessKey {
  keyId: string;
  label: string;
  budget: string;
  spent: string;
  /**
   * What its calls not yet settled hold of its budget, in wei: those in flight, and those whose cost is not known
   * yet. What it has left is budget − spent − reserved.
   */
  reserved: string;
  services: string[] | null;
  rps: number;
  expiresAt: number | null;
  revoked: boolean;
  lastUsedAt: number | null;
}

type MakeEntry = {
  type: 'make'; keyId: string; hash: string; label: string; budget: string; services: string[] | null; rps: number; expiresAt: number | null; at: number;
  /** Once compacted: what its calls cost until then, and the last one's time. */
  spent?: string;
  lastUsedAt?: number | null;
};

type Entry =
  | MakeEntry
  | { type: 'revoke'; keyId: string; at: number }
  | { type: 'use'; keyId: string; value: string; at: number };

/** A key as the journal folds it: what it shows but `reserved`, which is read each time it is shown. */
type KeptKey = Omit<AccessKey, 'reserved'>;

type Folded = { make: MakeEntry; key: KeptKey; hash: Buffer; revokedAt?: number };

export type KeyCheck =
  | { ok: true; key: AccessKey }
  | { ok: false; status: 401 | 429; code: 'missing_key' | 'unknown_key' | 'revoked_key' | 'expired_key' | 'key_rate' };

const hashOf = (secret: string) => createHash('sha256').update(secret).digest();

/** An entry folded into the keys. */
function apply(keys: Map<string, Folded>, e: Entry): void {
  if (e.type === 'make') {
    keys.set(e.keyId, {
      make: e,
      hash: Buffer.from(e.hash, 'hex'),
      key: {
        keyId: e.keyId, label: e.label, budget: e.budget, spent: e.spent ?? '0', services: e.services, rps: e.rps, expiresAt: e.expiresAt,
        revoked: false, lastUsedAt: e.lastUsedAt ?? null,
      },
    });
    return;
  }
  const kept = keys.get(e.keyId);
  if (!kept) return;
  if (e.type === 'revoke') {
    kept.key.revoked = true;
    kept.revokedAt = e.at;
  } else {
    kept.key.spent = (BigInt(kept.key.spent) + BigInt(e.value)).toString();
    // A call charged once its epoch is made final may be older than the last one charged.
    kept.key.lastUsedAt = Math.max(kept.key.lastUsedAt ?? e.at, e.at);
  }
}

export class AccessKeys {
  private readonly journal: Journal<Entry>;
  private readonly lock = new KeyedLock();
  /** keyId => when its recent calls were let in, for the rate. */
  private readonly recent = new Map<string, number[]>();
  /** keyId => what its calls in flight, or whose cost is not known yet, may still cost. */
  private readonly reserved = new Map<string, bigint>();
  /** The keys, folded from the journal once and kept up to date. */
  private loading: Promise<Map<string, Folded>> | undefined;
  /** Charges in the journal since it was last compacted. */
  private uses = 0;

  constructor(
    dir: string,
    private readonly compactEvery = KEYS_COMPACT_EVERY,
    /** The secrets' randomness; node's `randomBytes` but in tests. */
    private readonly random: (size: number) => Buffer = randomBytes,
  ) {
    this.journal = new Journal(join(dir, 'access-keys.jsonl'));
  }

  /**
   * Make a key. Its secret is returned this once and never kept. Its id is checked against every key's under the
   * journal's lock, so two makes at once never share one.
   */
  async make(scopes: AccessKeyScopes, now: number): Promise<{ secret: string; key: AccessKey }> {
    if (!Number.isSafeInteger(scopes.rps) || scopes.rps < 1) throw new Error('rps must be a positive integer');
    return this.lock.run('journal', async () => {
      const keys = await this.keys();
      for (let attempt = 0; attempt < MAKE_ATTEMPTS; attempt++) {
        const secret = `${PREFIX}${this.random(24).toString('hex')}`;
        const keyId = secret.slice(0, PREFIX.length + KEY_ID_HEX);
        if (keys.has(keyId)) continue;
        const entry: MakeEntry = {
          type: 'make', keyId, hash: hashOf(secret).toString('hex'), label: scopes.label, budget: scopes.budget.toString(),
          services: scopes.services, rps: scopes.rps, expiresAt: scopes.expiresAt, at: now,
        };
        await this.journal.append(entry);
        apply(keys, entry);
        return { secret, key: this.shown(keys.get(keyId)!.key) };
      }
      throw new Error(`no key id of its own after ${MAKE_ATTEMPTS} secrets`);
    });
  }

  async revoke(keyId: string, now: number): Promise<AccessKey | null> {
    if (!(await this.keys()).has(keyId)) return null;
    await this.append({ type: 'revoke', keyId, at: now });
    return this.shown((await this.keys()).get(keyId)!.key);
  }

  async list(): Promise<AccessKey[]> {
    return [...(await this.keys()).values()].map((k) => this.shown(k.key));
  }

  /**
   * Whether `secret` is a live key of this node, within its rate: the check a
   * call meets before its body is read. Every key's hash is compared, each in
   * constant time.
   */
  async check(secret: string | undefined, now: number): Promise<KeyCheck> {
    if (!secret) return { ok: false, status: 401, code: 'missing_key' };
    const presented = hashOf(secret);
    let found: KeptKey | undefined;
    for (const { key, hash } of (await this.keys()).values()) {
      if (timingSafeEqual(presented, hash)) found = key;
    }
    if (!found) return { ok: false, status: 401, code: 'unknown_key' };
    if (found.revoked) return { ok: false, status: 401, code: 'revoked_key' };
    if (found.expiresAt !== null && now >= found.expiresAt) return { ok: false, status: 401, code: 'expired_key' };
    const ms = Date.now();
    const recent = (this.recent.get(found.keyId) ?? []).filter((t) => ms - t < 1_000);
    if (recent.length >= found.rps) return { ok: false, status: 429, code: 'key_rate' };
    this.recent.set(found.keyId, [...recent, ms]);
    return { ok: true, key: this.shown(found) };
  }

  /**
   * Reserve `value` of the key's budget for a call about to be sent: false,
   * reserving nothing, when what its calls cost, what is reserved and `value`
   * would pass its budget.
   */
  async reserve(keyId: string, value: bigint): Promise<boolean> {
    const kept = (await this.keys()).get(keyId);
    if (!kept) return false;
    if (BigInt(kept.key.spent) + this.reservedOf(keyId) + value > BigInt(kept.key.budget)) return false;
    this.hold(keyId, value);
    return true;
  }

  /** Reserve `value` whatever the key has left: a call whose cost is not known yet, read back at load. */
  hold(keyId: string, value: bigint): void {
    this.reserved.set(keyId, this.reservedOf(keyId) + value);
  }

  release(keyId: string, value: bigint): void {
    const left = this.reservedOf(keyId) - value;
    if (left > 0n) this.reserved.set(keyId, left);
    else this.reserved.delete(keyId);
  }

  /** What the key's calls in flight, or whose cost is not known yet, may still cost. */
  reservedOf(keyId: string): bigint {
    return this.reserved.get(keyId) ?? 0n;
  }

  /** A key as the node API shows it: a copy, with what its calls not yet settled hold now. */
  private shown(key: KeptKey): AccessKey {
    return { ...key, reserved: this.reservedOf(key.keyId).toString() };
  }

  /** Book what a call cost against its key. */
  async charge(keyId: string, value: bigint, now: number): Promise<void> {
    await this.append({ type: 'use', keyId, value: value.toString(), at: now });
  }

  /** A call settled: charged what it cost, and its reservation released. */
  async settle(keyId: string, reserved: bigint, value: bigint, now: number): Promise<void> {
    try {
      await this.charge(keyId, value, now);
    } finally {
      this.release(keyId, reserved);
    }
  }

  /** Rewrite the journal as each key's make, with what its calls cost folded in, and its revocation. */
  async compact(): Promise<void> {
    await this.lock.run('journal', async () => this.compactNow(await this.keys()));
  }

  private async compactNow(keys: Map<string, Folded>): Promise<void> {
    const entries: Entry[] = [];
    for (const { make, key, revokedAt } of keys.values()) {
      entries.push({ ...make, spent: key.spent, lastUsedAt: key.lastUsedAt });
      if (revokedAt !== undefined) entries.push({ type: 'revoke', keyId: key.keyId, at: revokedAt });
    }
    await this.journal.replace(entries);
    this.uses = 0;
  }

  /**
   * An entry on disk, then in the keys. Every `compactEvery`th charge compacts the journal; a compaction that fails
   * leaves the journal as it is, and the next charge tries again.
   */
  private async append(entry: Entry): Promise<void> {
    await this.lock.run('journal', async () => {
      const keys = await this.keys();
      await this.journal.append(entry);
      apply(keys, entry);
      if (entry.type === 'use' && ++this.uses >= this.compactEvery) await this.compactNow(keys).catch(() => undefined);
    });
  }

  /** The keys: the journal folded once, on first use; a read that fails is tried again at the next use. */
  private keys(): Promise<Map<string, Folded>> {
    if (!this.loading) {
      const loading = this.journal.read().then((entries) => {
        const keys = new Map<string, Folded>();
        for (const e of entries) apply(keys, e);
        this.uses = entries.filter((e) => e.type === 'use').length;
        return keys;
      });
      loading.catch(() => {
        if (this.loading === loading) this.loading = undefined;
      });
      this.loading = loading;
    }
    return this.loading;
  }
}
