// SPDX-License-Identifier: Apache-2.0

/**
 * Access keys (OT-RFC-27): what the node's own agents and scripts call
 * the gateway with. A key spends the buyer's subscription through the node; it
 * cannot touch a wallet, and it opens no other route of the node's API. A
 * node or agent token is not a key.
 *   - The secret is shown once, when the key is made; the node keeps only its
 *     sha256, and compares hashes in constant time.
 *   - Each key has a label, a budget in wei, the services it may call (or all),
 *     a rate in calls per second, and an expiry.
 *   - A revocation takes effect at the next call.
 *   - A call reserves the most it may cost against its key before it is sent:
 *     the check that the budget has it, beside what the key's calls cost and
 *     what they hold reserved, and the reservation are one step, so calls at
 *     once, on any service, never reserve past the budget. The call settles
 *     its reservation once, at what it cost, or at nothing.
 * Kept in a journal: makes, revocations, reservations and their settlements,
 * which `compact` folds into each key's total, carrying the reservations not
 * settled yet.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { Journal, KeyedLock } from './journal.js';

const PREFIX = 'dkgmk_';

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
  /** What its calls not settled yet may cost, at most. */
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
  /** What a call cost, booked without a reservation, as journals from before reservations have it. */
  | { type: 'use'; keyId: string; value: string; at: number }
  | { type: 'reserve'; keyId: string; callId: string; value: string; at: number }
  | { type: 'settle'; callId: string; value: string };

/** A key, folded: its view, and its reservations not settled yet, by call id, with their values and times. */
type Folded = { make: MakeEntry; key: AccessKey; hash: Buffer; revokedAt?: number; open: Map<string, { value: bigint; at: number }> };

export type KeyCheck =
  | { ok: true; key: AccessKey }
  | { ok: false; status: 401 | 429; code: 'missing_key' | 'unknown_key' | 'revoked_key' | 'expired_key' | 'key_rate' };

const hashOf = (secret: string) => createHash('sha256').update(secret).digest();

export class AccessKeys {
  private readonly journal: Journal<Entry>;
  private readonly lock = new KeyedLock();
  /** keyId => when its recent calls were let in, for the rate. */
  private readonly recent = new Map<string, number[]>();

  constructor(dir: string) {
    this.journal = new Journal(join(dir, 'access-keys.jsonl'));
  }

  /** Make a key. Its secret is returned this once and never kept. */
  async make(scopes: AccessKeyScopes, now: number): Promise<{ secret: string; key: AccessKey }> {
    if (!Number.isSafeInteger(scopes.rps) || scopes.rps < 1) throw new Error('rps must be a positive integer');
    const secret = `${PREFIX}${randomBytes(24).toString('hex')}`;
    const keyId = secret.slice(0, PREFIX.length + 8);
    await this.append({
      type: 'make', keyId, hash: hashOf(secret).toString('hex'), label: scopes.label, budget: scopes.budget.toString(),
      services: scopes.services, rps: scopes.rps, expiresAt: scopes.expiresAt, at: now,
    });
    return { secret, key: (await this.fold()).get(keyId)!.key };
  }

  async revoke(keyId: string, now: number): Promise<AccessKey | null> {
    if (!(await this.fold()).has(keyId)) return null;
    await this.append({ type: 'revoke', keyId, at: now });
    return (await this.fold()).get(keyId)!.key;
  }

  async list(): Promise<AccessKey[]> {
    return [...(await this.fold()).values()].map((k) => k.key);
  }

  /**
   * Whether `secret` is a live key of this node, within its rate: the check a
   * call meets before its body is read. Every key's hash is compared, each in
   * constant time.
   */
  async check(secret: string | undefined, now: number): Promise<KeyCheck> {
    if (!secret) return { ok: false, status: 401, code: 'missing_key' };
    const presented = hashOf(secret);
    let found: AccessKey | undefined;
    for (const { key, hash } of (await this.fold()).values()) {
      if (timingSafeEqual(presented, hash)) found = key;
    }
    if (!found) return { ok: false, status: 401, code: 'unknown_key' };
    if (found.revoked) return { ok: false, status: 401, code: 'revoked_key' };
    if (found.expiresAt !== null && now >= found.expiresAt) return { ok: false, status: 401, code: 'expired_key' };
    const ms = Date.now();
    const recent = (this.recent.get(found.keyId) ?? []).filter((t) => ms - t < 1_000);
    if (recent.length >= found.rps) return { ok: false, status: 429, code: 'key_rate' };
    this.recent.set(found.keyId, [...recent, ms]);
    return { ok: true, key: found };
  }

  /**
   * Reserve `value`, the most call `callId` may cost, against its key: only if
   * the key's budget has it beside what its calls cost and hold reserved. The
   * check and the reservation are one step. `false` when the budget does not
   * have it, or there is no such key.
   */
  async reserve(keyId: string, callId: string, value: bigint, now: number): Promise<boolean> {
    return this.lock.run('journal', async () => {
      const kept = (await this.fold()).get(keyId);
      if (!kept || BigInt(kept.key.spent) + BigInt(kept.key.reserved) + value > BigInt(kept.key.budget)) return false;
      await this.journal.append({ type: 'reserve', keyId, callId, value: value.toString(), at: now });
      return true;
    });
  }

  /**
   * Settle a call's reservation at what the call cost, 0 for nothing: the
   * reservation leaves its key, and the cost joins what the key spent. Only
   * the first settlement of a call counts.
   */
  async settle(callId: string, value: bigint): Promise<void> {
    await this.append({ type: 'settle', callId, value: value.toString() });
  }

  /** The reservations not settled yet: each call's id, its key and the most it may cost. */
  async reservations(): Promise<Array<{ callId: string; keyId: string; value: bigint }>> {
    return [...(await this.fold()).values()].flatMap(({ key, open }) => [...open].map(([callId, r]) => ({ callId, keyId: key.keyId, value: r.value })));
  }

  /** Rewrite the journal as each key's make, with what its calls cost folded in, its revocation, and its reservations not settled yet. */
  async compact(): Promise<void> {
    await this.lock.run('journal', async () => {
      const entries: Entry[] = [];
      for (const { make, key, revokedAt, open } of (await this.fold()).values()) {
        entries.push({ ...make, spent: key.spent, lastUsedAt: key.lastUsedAt });
        if (revokedAt !== undefined) entries.push({ type: 'revoke', keyId: key.keyId, at: revokedAt });
        for (const [callId, r] of open) entries.push({ type: 'reserve', keyId: key.keyId, callId, value: r.value.toString(), at: r.at });
      }
      await this.journal.replace(entries);
    });
  }

  private async append(entry: Entry): Promise<void> {
    await this.lock.run('journal', () => this.journal.append(entry));
  }

  private async fold(): Promise<Map<string, Folded>> {
    const keys = new Map<string, Folded>();
    /** call id => the key it holds a reservation on, until settled. */
    const reservedOn = new Map<string, Folded>();
    for (const e of await this.journal.read()) {
      if (e.type === 'make') {
        keys.set(e.keyId, {
          make: e,
          hash: Buffer.from(e.hash, 'hex'),
          key: {
            keyId: e.keyId, label: e.label, budget: e.budget, spent: e.spent ?? '0', reserved: '0', services: e.services, rps: e.rps,
            expiresAt: e.expiresAt, revoked: false, lastUsedAt: e.lastUsedAt ?? null,
          },
          open: new Map(),
        });
        continue;
      }
      if (e.type === 'settle') {
        // A call settled already, or never reserved, changes nothing.
        const kept = reservedOn.get(e.callId);
        if (!kept) continue;
        const reservation = kept.open.get(e.callId)!;
        reservedOn.delete(e.callId);
        kept.open.delete(e.callId);
        if (BigInt(e.value) > 0n) spend(kept.key, BigInt(e.value), reservation.at);
        continue;
      }
      const kept = keys.get(e.keyId);
      if (!kept) continue;
      if (e.type === 'revoke') {
        kept.key.revoked = true;
        kept.revokedAt = e.at;
      } else if (e.type === 'use') {
        spend(kept.key, BigInt(e.value), e.at);
      } else {
        kept.open.set(e.callId, { value: BigInt(e.value), at: e.at });
        reservedOn.set(e.callId, kept);
      }
    }
    for (const { key, open } of keys.values()) key.reserved = [...open.values()].reduce((v, r) => v + r.value, 0n).toString();
    return keys;
  }
}

/** A call's cost, made at `at`, in what its key spent. */
function spend(key: AccessKey, value: bigint, at: number): void {
  key.spent = (BigInt(key.spent) + value).toString();
  key.lastUsedAt = Math.max(key.lastUsedAt ?? at, at);
}
