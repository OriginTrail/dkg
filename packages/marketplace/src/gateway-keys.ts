/**
 * Scoped buyer gateway keys (re-designed from the fork's `gateway/keys.ts`):
 * `dkg_gw_<8 hex>_<43 base64url>` credentials a buyer node mints for its
 * local consumers (OpenAI SDKs, scripts, agents). A key spends through the
 * buyer's plan meter; its budget is an additional sub-cap, never the wallet.
 *
 *   - hashed at rest: `keyHash = sha256:<hex sha256(plaintext)>`; the
 *     plaintext is returned exactly once, by `mint`;
 *   - scopes: wei budget, expiry, model allowlist, query y/n, rps;
 *   - in-memory ledger with JSON persistence (the daemon owns the file);
 *     reservations are in-flight state and are never persisted;
 *   - authentication is timing-safe and leaks no key state to a prober:
 *     `key_revoked` / `key_expired` only after the presented secret matched.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { canonicalModelId } from './model-id.js';
import { SHA256_DIGEST_PATTERN } from './token-engines.js';

export const GATEWAY_KEY_PREFIX = 'dkg_gw_';
/** Group 1 is the key id hex (`keyId = 'gw_' + group1`); group 2 the 256-bit secret. */
export const GATEWAY_KEY_PATTERN = /^dkg_gw_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;
const KEY_ID_PATTERN = /^gw_[0-9a-f]{8}$/;

export interface GatewayKeyScopes {
  /** Display only (≤ 64 chars), never auth. */
  label: string;
  /** Sub-cap of the plan; > 0. */
  budgetWei: bigint;
  /** Unix seconds; null = no expiry. */
  expiresAt: number | null;
  /** Canonical model ids; null = every model. */
  modelAllowlist: string[] | null;
  allowQuery: boolean;
  /** 1..1000 requests per second. */
  rps: number;
}

export interface GatewayKeyUsage {
  spentWei: bigint;
  /** In-flight reservations; never persisted. */
  reservedWei: bigint;
  calls: number;
  inferenceCalls: number;
  queryCalls: number;
  servedUnits: bigint;
  lastUsedAt: number | null;
}

export interface GatewayKeyRecord {
  keyId: string;
  keyHash: string;
  scopes: GatewayKeyScopes;
  mintedAt: number;
  revokedAt: number | null;
  usage: GatewayKeyUsage;
}

export type PublicGatewayKeyRecord = Omit<GatewayKeyRecord, 'keyHash'>;

export type GatewayKeyAuthVerdict =
  | { ok: true; record: GatewayKeyRecord }
  | { ok: false; code: 'invalid_api_key' | 'key_revoked' | 'key_expired' };

export type GatewayKeyScopeVerdict = { ok: true } | { ok: false; code: 'model_not_allowed' | 'query_not_allowed' };

export interface GatewayKeyLedgerJson {
  version: 1;
  keys: Array<Record<string, unknown>>;
}

/** Invalid key scopes at mint (a caller fault: map to 400). */
export class GatewayKeyScopeError extends Error {
  constructor(detail: string) {
    super(`invalid gateway key scopes: ${detail}`);
    this.name = 'GatewayKeyScopeError';
  }
}

const MAX_LABEL_CHARS = 64;
const MAX_ALLOWLIST_ENTRIES = 256;
const MAX_MINT_ATTEMPTS = 16;
const DECIMAL = /^(0|[1-9]\d*)$/;
// Compared against when the presented keyId is unknown, so both paths hash and compare.
const DUMMY_HASH = createHash('sha256').update('dkg-mkt-gateway/unknown-key').digest();

const sha256Bytes = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

function copyRecord(record: GatewayKeyRecord): GatewayKeyRecord {
  return {
    ...record,
    scopes: { ...record.scopes, modelAllowlist: record.scopes.modelAllowlist ? [...record.scopes.modelAllowlist] : null },
    usage: { ...record.usage },
  };
}

/** A key record without its hash, for list/mint responses. */
export function publicGatewayKeyRecord(r: GatewayKeyRecord): PublicGatewayKeyRecord {
  const { keyHash: _keyHash, ...rest } = copyRecord(r);
  return rest;
}

/** Scope validation (shared by mint and load); `nowSeconds` additionally requires a future expiry. */
export function validateGatewayKeyScopes(scopes: GatewayKeyScopes, nowSeconds?: number): { ok: true } | { ok: false; detail: string } {
  if (typeof scopes !== 'object' || scopes === null) return { ok: false, detail: 'scopes must be an object' };
  if (typeof scopes.label !== 'string' || scopes.label.length > MAX_LABEL_CHARS) {
    return { ok: false, detail: `label must be a string of at most ${MAX_LABEL_CHARS} characters` };
  }
  if (typeof scopes.budgetWei !== 'bigint' || scopes.budgetWei <= 0n) return { ok: false, detail: 'budgetWei must be a positive bigint' };
  if (scopes.expiresAt !== null) {
    if (!Number.isSafeInteger(scopes.expiresAt) || scopes.expiresAt < 0) {
      return { ok: false, detail: 'expiresAt must be unix seconds or null' };
    }
    if (nowSeconds !== undefined && scopes.expiresAt <= nowSeconds) return { ok: false, detail: 'expiresAt must be in the future' };
  }
  if (scopes.modelAllowlist !== null) {
    if (!Array.isArray(scopes.modelAllowlist) || scopes.modelAllowlist.length > MAX_ALLOWLIST_ENTRIES) {
      return { ok: false, detail: `modelAllowlist must be null or at most ${MAX_ALLOWLIST_ENTRIES} model ids` };
    }
    for (const modelId of scopes.modelAllowlist) {
      if (canonicalModelId(modelId) !== modelId) return { ok: false, detail: `modelAllowlist entry ${JSON.stringify(modelId)} is not canonical` };
    }
  }
  if (typeof scopes.allowQuery !== 'boolean') return { ok: false, detail: 'allowQuery must be a boolean' };
  if (!Number.isSafeInteger(scopes.rps) || scopes.rps < 1 || scopes.rps > 1000) return { ok: false, detail: 'rps must be an integer 1..1000' };
  return { ok: true };
}

function parseCount(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`gateway key ${field} must be a non-negative integer`);
  return v;
}

function parseWei(v: unknown, field: string): bigint {
  if (typeof v !== 'string' || !DECIMAL.test(v)) throw new Error(`gateway key ${field} must be a decimal string`);
  return BigInt(v);
}

function parseNullableTime(v: unknown, field: string): number | null {
  return v === null ? null : parseCount(v, field);
}

function parsePersistedRecord(raw: unknown): GatewayKeyRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('gateway key entry must be an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.keyId !== 'string' || !KEY_ID_PATTERN.test(r.keyId)) throw new Error('gateway key keyId is malformed');
  if (typeof r.keyHash !== 'string' || !SHA256_DIGEST_PATTERN.test(r.keyHash)) throw new Error(`gateway key ${r.keyId} keyHash is malformed`);
  const s = r.scopes as Record<string, unknown> | null;
  const u = r.usage as Record<string, unknown> | null;
  if (typeof s !== 'object' || s === null || typeof u !== 'object' || u === null) {
    throw new Error(`gateway key ${r.keyId} needs scopes and usage objects`);
  }
  const scopes: GatewayKeyScopes = {
    label: s.label as string,
    budgetWei: parseWei(s.budgetWei, 'scopes.budgetWei'),
    expiresAt: parseNullableTime(s.expiresAt, 'scopes.expiresAt'),
    modelAllowlist: s.modelAllowlist === null ? null : (s.modelAllowlist as string[]),
    allowQuery: s.allowQuery as boolean,
    rps: s.rps as number,
  };
  const valid = validateGatewayKeyScopes(scopes);
  if (!valid.ok) throw new Error(`gateway key ${r.keyId}: ${valid.detail}`);
  return {
    keyId: r.keyId,
    keyHash: r.keyHash,
    scopes: { ...scopes, modelAllowlist: scopes.modelAllowlist ? [...scopes.modelAllowlist] : null },
    mintedAt: parseCount(r.mintedAt, 'mintedAt'),
    revokedAt: parseNullableTime(r.revokedAt, 'revokedAt'),
    usage: {
      spentWei: parseWei(u.spentWei, 'usage.spentWei'),
      reservedWei: 0n,
      calls: parseCount(u.calls, 'usage.calls'),
      inferenceCalls: parseCount(u.inferenceCalls, 'usage.inferenceCalls'),
      queryCalls: parseCount(u.queryCalls, 'usage.queryCalls'),
      servedUnits: parseWei(u.servedUnits, 'usage.servedUnits'),
      lastUsedAt: parseNullableTime(u.lastUsedAt, 'usage.lastUsedAt'),
    },
  };
}

interface Reservation {
  keyId: string;
  wei: bigint;
}

/** In-memory key ledger; the daemon persists `toJSON()` after every mint, revoke and settle. */
export class GatewayKeyLedger {
  readonly #keys = new Map<string, GatewayKeyRecord>();
  readonly #reservations = new Map<string, Reservation>();

  /** Throws on a malformed persisted ledger (the daemon then fails closed). */
  constructor(json?: GatewayKeyLedgerJson) {
    if (json === undefined) return;
    if (typeof json !== 'object' || json === null || json.version !== 1 || !Array.isArray(json.keys)) {
      throw new Error('gateway key ledger must be { version: 1, keys: [...] }');
    }
    for (const raw of json.keys) {
      const record = parsePersistedRecord(raw);
      if (this.#keys.has(record.keyId)) throw new Error(`gateway key ${record.keyId} is listed twice`);
      this.#keys.set(record.keyId, record);
    }
  }

  /**
   * Mint a key; the plaintext is returned exactly once and never stored. A
   * key id colliding with an existing record is re-drawn. Throws
   * `GatewayKeyScopeError` on invalid scopes.
   */
  mint(
    scopes: GatewayKeyScopes,
    nowSeconds: number,
    random: (n: number) => Uint8Array = randomBytes,
  ): { plaintext: string; record: GatewayKeyRecord } {
    const valid = validateGatewayKeyScopes(scopes, nowSeconds);
    if (!valid.ok) throw new GatewayKeyScopeError(valid.detail);
    for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
      const idBytes = random(4);
      const secretBytes = random(32);
      if (idBytes.length !== 4 || secretBytes.length !== 32) throw new Error('gateway key random source returned the wrong length');
      const idHex = Buffer.from(idBytes).toString('hex');
      const keyId = `gw_${idHex}`;
      if (this.#keys.has(keyId)) continue;
      const plaintext = `${GATEWAY_KEY_PREFIX}${idHex}_${Buffer.from(secretBytes).toString('base64url')}`;
      const record: GatewayKeyRecord = {
        keyId,
        keyHash: `sha256:${sha256Bytes(plaintext).toString('hex')}`,
        scopes: { ...scopes, modelAllowlist: scopes.modelAllowlist ? [...scopes.modelAllowlist] : null },
        mintedAt: nowSeconds,
        revokedAt: null,
        usage: { spentWei: 0n, reservedWei: 0n, calls: 0, inferenceCalls: 0, queryCalls: 0, servedUnits: 0n, lastUsedAt: null },
      };
      this.#keys.set(keyId, record);
      return { plaintext, record: copyRecord(record) };
    }
    throw new Error(`could not draw an unused gateway key id in ${MAX_MINT_ATTEMPTS} attempts`);
  }

  /** ONLY to roll back a mint whose persist failed. */
  remove(keyId: string): boolean {
    for (const [reservationId, reservation] of this.#reservations) {
      if (reservation.keyId === keyId) this.#reservations.delete(reservationId);
    }
    return this.#keys.delete(keyId);
  }

  /**
   * Normative order: format → keyId lookup → timing-safe hash compare (a
   * dummy hash for unknown ids) → only then revoked, then expired.
   */
  authenticate(presented: string | undefined, nowSeconds: number): GatewayKeyAuthVerdict {
    const match = typeof presented === 'string' ? GATEWAY_KEY_PATTERN.exec(presented) : null;
    if (!match) return { ok: false, code: 'invalid_api_key' };
    const record = this.#keys.get(`gw_${match[1]}`);
    const stored = record ? Buffer.from(record.keyHash.slice('sha256:'.length), 'hex') : DUMMY_HASH;
    const equal = timingSafeEqual(sha256Bytes(presented as string), stored);
    if (!equal || !record) return { ok: false, code: 'invalid_api_key' };
    if (record.revokedAt !== null) return { ok: false, code: 'key_revoked' };
    if (record.scopes.expiresAt !== null && nowSeconds >= record.scopes.expiresAt) return { ok: false, code: 'key_expired' };
    return { ok: true, record: copyRecord(record) };
  }

  checkScope(record: GatewayKeyRecord, request: { kind: 'inference' | 'query'; modelId?: string }): GatewayKeyScopeVerdict {
    if (request.kind === 'query') return record.scopes.allowQuery ? { ok: true } : { ok: false, code: 'query_not_allowed' };
    const allowlist = record.scopes.modelAllowlist;
    if (allowlist !== null && (request.modelId === undefined || !allowlist.includes(request.modelId))) {
      return { ok: false, code: 'model_not_allowed' };
    }
    return { ok: true };
  }

  #live(keyId: string): GatewayKeyRecord {
    const record = this.#keys.get(keyId);
    if (!record) throw new Error(`unknown gateway key: ${keyId}`);
    return record;
  }

  #remaining(record: GatewayKeyRecord): bigint {
    return record.scopes.budgetWei - record.usage.spentWei - record.usage.reservedWei;
  }

  /** Hold `worstCaseWei` against the key's budget until settle/release. */
  reserve(
    keyId: string,
    reservationId: string,
    worstCaseWei: bigint,
  ): { ok: true } | { ok: false; code: 'key_budget_exceeded'; remainingWei: bigint } {
    const record = this.#live(keyId);
    if (worstCaseWei < 0n) throw new Error(`reservation must be non-negative, got: ${worstCaseWei}`);
    if (this.#reservations.has(reservationId)) throw new Error(`duplicate gateway key reservation: ${reservationId}`);
    const remaining = this.#remaining(record);
    if (worstCaseWei > remaining) {
      return { ok: false, code: 'key_budget_exceeded', remainingWei: remaining > 0n ? remaining : 0n };
    }
    record.usage.reservedWei += worstCaseWei;
    this.#reservations.set(reservationId, { keyId, wei: worstCaseWei });
    return { ok: true };
  }

  /** A served (or ambiguous) call: book its cost and release the hold. */
  settle(
    reservationId: string,
    outcome: { costWei: bigint; servedUnits: bigint; kind: 'inference' | 'query' },
    nowSeconds: number,
  ): void {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) throw new Error(`no gateway key reservation: ${reservationId}`);
    if (outcome.costWei < 0n || outcome.servedUnits < 0n) throw new Error('settled cost and units must be non-negative');
    this.#reservations.delete(reservationId);
    const record = this.#keys.get(reservation.keyId);
    if (!record) return;
    record.usage.reservedWei -= reservation.wei;
    record.usage.spentWei += outcome.costWei;
    record.usage.calls += 1;
    if (outcome.kind === 'inference') record.usage.inferenceCalls += 1;
    else record.usage.queryCalls += 1;
    record.usage.servedUnits += outcome.servedUnits;
    record.usage.lastUsedAt = nowSeconds;
  }

  /** A not-served call: release the hold, no usage change. Unknown ids are a no-op. */
  release(reservationId: string): void {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) return;
    this.#reservations.delete(reservationId);
    const record = this.#keys.get(reservation.keyId);
    if (record) record.usage.reservedWei -= reservation.wei;
  }

  /** Idempotent: a second revoke returns the record with its original `revokedAt`. */
  revoke(keyId: string, nowSeconds: number): GatewayKeyRecord | undefined {
    const record = this.#keys.get(keyId);
    if (!record) return undefined;
    if (record.revokedAt === null) record.revokedAt = nowSeconds;
    return copyRecord(record);
  }

  get(keyId: string): GatewayKeyRecord | undefined {
    const record = this.#keys.get(keyId);
    return record ? copyRecord(record) : undefined;
  }

  list(): GatewayKeyRecord[] {
    return [...this.#keys.values()].map(copyRecord);
  }

  /** `budget − spent − reserved`, floored at 0; 0 for an unknown key. */
  remainingWei(keyId: string): bigint {
    const record = this.#keys.get(keyId);
    if (!record) return 0n;
    const remaining = this.#remaining(record);
    return remaining > 0n ? remaining : 0n;
  }

  /** Persisted form: bigints as decimal strings; reservations are not persisted. */
  toJSON(): GatewayKeyLedgerJson {
    return {
      version: 1,
      keys: [...this.#keys.values()].map((record) => ({
        keyId: record.keyId,
        keyHash: record.keyHash,
        scopes: {
          label: record.scopes.label,
          budgetWei: record.scopes.budgetWei.toString(),
          expiresAt: record.scopes.expiresAt,
          modelAllowlist: record.scopes.modelAllowlist ? [...record.scopes.modelAllowlist] : null,
          allowQuery: record.scopes.allowQuery,
          rps: record.scopes.rps,
        },
        mintedAt: record.mintedAt,
        revokedAt: record.revokedAt,
        usage: {
          spentWei: record.usage.spentWei.toString(),
          calls: record.usage.calls,
          inferenceCalls: record.usage.inferenceCalls,
          queryCalls: record.usage.queryCalls,
          servedUnits: record.usage.servedUnits.toString(),
          lastUsedAt: record.usage.lastUsedAt,
        },
      })),
    };
  }
}

/** Per-key sliding-window rate limiter with a bounded key map (LRU eviction). */
export class SlidingWindowRateLimiter {
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #hits = new Map<string, number[]>();

  constructor(opts: { windowMs?: number; maxKeys?: number } = {}) {
    this.#windowMs = opts.windowMs ?? 1000;
    this.#maxKeys = opts.maxKeys ?? 10_000;
    if (!(this.#windowMs > 0) || !Number.isSafeInteger(this.#maxKeys) || this.#maxKeys < 1) {
      throw new Error('SlidingWindowRateLimiter needs windowMs > 0 and maxKeys ≥ 1');
    }
  }

  /** Take one slot for `key` at `nowMs`; false when `limit` hits already sit in the window. */
  tryAcquire(key: string, limit: number, nowMs: number): boolean {
    const cutoff = nowMs - this.#windowMs;
    const hits = (this.#hits.get(key) ?? []).filter((at) => at > cutoff);
    this.#hits.delete(key); // re-inserted below: Map order is least-recently-used first
    if (hits.length >= limit) {
      if (hits.length > 0) this.#hits.set(key, hits);
      this.#evict(cutoff);
      return false;
    }
    hits.push(nowMs);
    this.#hits.set(key, hits);
    this.#evict(cutoff);
    return true;
  }

  /** Number of keys currently tracked (bounded by `maxKeys`). */
  get size(): number {
    return this.#hits.size;
  }

  #evict(cutoff: number): void {
    if (this.#hits.size <= this.#maxKeys) return;
    for (const [key, hits] of this.#hits) {
      if (hits.every((at) => at <= cutoff)) this.#hits.delete(key);
    }
    for (const key of this.#hits.keys()) {
      if (this.#hits.size <= this.#maxKeys) break;
      this.#hits.delete(key);
    }
  }
}
