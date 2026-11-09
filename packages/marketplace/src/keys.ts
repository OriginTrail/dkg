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
 * Kept in a journal: makes, revocations, and what each call cost, which
 * `compact` folds into each key's total.
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

type Folded = { make: MakeEntry; key: AccessKey; hash: Buffer; revokedAt?: number };

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

  /** Book what a call cost against its key. */
  async charge(keyId: string, value: bigint, now: number): Promise<void> {
    await this.append({ type: 'use', keyId, value: value.toString(), at: now });
  }

  /** Rewrite the journal as each key's make, with what its calls cost folded in, and its revocation. */
  async compact(): Promise<void> {
    await this.lock.run('journal', async () => {
      const entries: Entry[] = [];
      for (const { make, key, revokedAt } of (await this.fold()).values()) {
        entries.push({ ...make, spent: key.spent, lastUsedAt: key.lastUsedAt });
        if (revokedAt !== undefined) entries.push({ type: 'revoke', keyId: key.keyId, at: revokedAt });
      }
      await this.journal.replace(entries);
    });
  }

  private async append(entry: Entry): Promise<void> {
    await this.lock.run('journal', () => this.journal.append(entry));
  }

  private async fold(): Promise<Map<string, Folded>> {
    const keys = new Map<string, Folded>();
    for (const e of await this.journal.read()) {
      if (e.type === 'make') {
        keys.set(e.keyId, {
          make: e,
          hash: Buffer.from(e.hash, 'hex'),
          key: {
            keyId: e.keyId, label: e.label, budget: e.budget, spent: e.spent ?? '0', services: e.services, rps: e.rps, expiresAt: e.expiresAt,
            revoked: false, lastUsedAt: e.lastUsedAt ?? null,
          },
        });
        continue;
      }
      const kept = keys.get(e.keyId);
      if (!kept) continue;
      if (e.type === 'revoke') {
        kept.key.revoked = true;
        kept.revokedAt = e.at;
      } else {
        kept.key.spent = (BigInt(kept.key.spent) + BigInt(e.value)).toString();
        kept.key.lastUsedAt = e.at;
      }
    }
    return keys;
  }
}
