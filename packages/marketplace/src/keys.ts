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
 * Kept in the buyer's ledger (buyer-ledger.ts), with the gateway's calls: the
 * keys as made and revoked, and what each call charged, in the call's own
 * record. The ledger is read once, and keeps the keys in memory.
 */
import { createHash, randomBytes } from 'node:crypto';
import { BuyerLedger } from './buyer-ledger.js';

const PREFIX = 'dkgmk_';
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

/** A key as the ledger holds it: what it shows but `reserved`, which is read each time it is shown. */
export type KeptKey = Omit<AccessKey, 'reserved'>;

export type KeyCheck =
  | { ok: true; key: AccessKey }
  | { ok: false; status: 401 | 429; code: 'missing_key' | 'unknown_key' | 'revoked_key' | 'expired_key' | 'key_rate' };

const hashOf = (secret: string) => createHash('sha256').update(secret).digest();

export class AccessKeys {
  /** Where the keys are kept, with the gateway's calls. */
  readonly ledger: BuyerLedger;
  /** keyId => when its recent calls were let in, for the rate. */
  private readonly recent = new Map<string, number[]>();

  /** @param dirOrLedger the buyer's directory, whose ledger it opens, or the ledger itself */
  constructor(
    dirOrLedger: string | BuyerLedger,
    /** The secrets' randomness; node's `randomBytes` but in tests. */
    private readonly random: (size: number) => Buffer = randomBytes,
  ) {
    this.ledger = typeof dirOrLedger === 'string' ? new BuyerLedger(dirOrLedger) : dirOrLedger;
  }

  /**
   * Make a key. Its secret is returned this once and never kept. Its id is checked against every key's under the
   * ledger's lock (`BuyerLedger.makeKey`), so two makes at once never share one.
   */
  async make(scopes: AccessKeyScopes, now: number): Promise<{ secret: string; key: AccessKey }> {
    if (!Number.isSafeInteger(scopes.rps) || scopes.rps < 1) throw new Error('rps must be a positive integer');
    for (let attempt = 0; attempt < MAKE_ATTEMPTS; attempt++) {
      const secret = `${PREFIX}${this.random(24).toString('hex')}`;
      const keyId = secret.slice(0, PREFIX.length + KEY_ID_HEX);
      const key = await this.ledger.makeKey({
        keyId, hash: hashOf(secret).toString('hex'), label: scopes.label, budget: scopes.budget.toString(),
        services: scopes.services, rps: scopes.rps, expiresAt: scopes.expiresAt, at: now,
      });
      if (key) return { secret, key: this.shown(key) };
    }
    throw new Error(`no key id of its own after ${MAKE_ATTEMPTS} secrets`);
  }

  async revoke(keyId: string, now: number): Promise<AccessKey | null> {
    const key = await this.ledger.revokeKey(keyId, now);
    return key ? this.shown(key) : null;
  }

  async list(): Promise<AccessKey[]> {
    return (await this.ledger.keyList()).map((k) => this.shown(k));
  }

  /**
   * Whether `secret` is a live key of this node, within its rate: the check a
   * call meets before its body is read. The key is looked up in the ledger by
   * the secret's hash (`BuyerLedger.keyByHash`).
   */
  async check(secret: string | undefined, now: number): Promise<KeyCheck> {
    if (!secret) return { ok: false, status: 401, code: 'missing_key' };
    const found = await this.ledger.keyByHash(hashOf(secret));
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
  reserve(keyId: string, value: bigint): Promise<boolean> {
    return this.ledger.reserve(keyId, value);
  }

  /** Reserve `value` whatever the key has left: a call whose cost is not known yet, read back at load. */
  hold(keyId: string, value: bigint): void {
    this.ledger.hold(keyId, value);
  }

  release(keyId: string, value: bigint): void {
    this.ledger.release(keyId, value);
  }

  /** What the key's calls in flight, or whose cost is not known yet, may still cost. */
  reservedOf(keyId: string): bigint {
    return this.ledger.reservedOf(keyId);
  }

  /** A key as the node API shows it, from the ledger's copy, with what its calls not yet settled hold now. */
  private shown(key: KeptKey): AccessKey {
    return { ...key, reserved: this.reservedOf(key.keyId).toString() };
  }
}
