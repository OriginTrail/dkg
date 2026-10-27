import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GATEWAY_KEY_PATTERN,
  GATEWAY_KEY_PREFIX,
  GatewayKeyLedger,
  GatewayKeyScopeError,
  publicGatewayKeyRecord,
  SlidingWindowRateLimiter,
  type GatewayKeyScopes,
} from '../src/index.js';

const NOW = 1_800_000_000;
const scopes = (overrides: Partial<GatewayKeyScopes> = {}): GatewayKeyScopes => ({
  label: 'e2e',
  budgetWei: 1_000_000_000_000_000n,
  expiresAt: null,
  modelAllowlist: ['stub-chat'],
  allowQuery: true,
  rps: 5,
  ...overrides,
});

/** Deterministic random source: a queue of byte arrays, then a counter fill. */
function scriptedRandom(queue: Uint8Array[]): (n: number) => Uint8Array {
  let counter = 1;
  return (n) => queue.shift() ?? Uint8Array.from({ length: n }, () => counter++ & 0xff);
}

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('mint', () => {
  it('returns the plaintext once, in the dkg_gw_ format, hashed at rest', () => {
    const ledger = new GatewayKeyLedger();
    const { plaintext, record } = ledger.mint(scopes(), NOW);
    const match = GATEWAY_KEY_PATTERN.exec(plaintext);
    expect(plaintext.startsWith(GATEWAY_KEY_PREFIX)).toBe(true);
    expect(match).not.toBeNull();
    expect(record.keyId).toBe(`gw_${match![1]}`);
    expect(record.keyHash).toBe(`sha256:${createHash('sha256').update(plaintext).digest('hex')}`);
    expect(record).toMatchObject({ mintedAt: NOW, revokedAt: null, usage: { spentWei: 0n, reservedWei: 0n, calls: 0 } });
    const persisted = JSON.stringify(ledger.toJSON());
    expect(persisted).not.toContain(plaintext);
    expect(persisted).not.toContain(match![2]);
    expect(publicGatewayKeyRecord(record)).not.toHaveProperty('keyHash');
    expect(publicGatewayKeyRecord(record).keyId).toBe(record.keyId);
  });

  it('re-draws a colliding keyId', () => {
    const id = Uint8Array.from([0xde, 0xad, 0xbe, 0xef]);
    const ledger = new GatewayKeyLedger();
    const first = ledger.mint(scopes(), NOW, scriptedRandom([id, new Uint8Array(32)]));
    expect(first.record.keyId).toBe('gw_deadbeef');
    const second = ledger.mint(scopes(), NOW, scriptedRandom([id, new Uint8Array(32).fill(1), Uint8Array.from([1, 2, 3, 4])]));
    expect(second.record.keyId).toBe('gw_01020304');
    expect(ledger.list().map((r) => r.keyId)).toEqual(['gw_deadbeef', 'gw_01020304']);
  });

  it('refuses invalid scopes with GatewayKeyScopeError', () => {
    const ledger = new GatewayKeyLedger();
    const invalid: Array<Partial<GatewayKeyScopes>> = [
      { budgetWei: 0n },
      { label: 'x'.repeat(65) },
      { expiresAt: NOW },
      { expiresAt: 1.5 },
      { modelAllowlist: ['Stub-Chat'] },
      { rps: 0 },
      { rps: 1001 },
    ];
    for (const overrides of invalid) {
      expect(() => ledger.mint(scopes(overrides), NOW), JSON.stringify(overrides, (_, v) => (typeof v === 'bigint' ? `${v}` : v))).toThrow(
        GatewayKeyScopeError,
      );
    }
    expect(ledger.list()).toEqual([]);
  });

  it('remove rolls back a mint', () => {
    const ledger = new GatewayKeyLedger();
    const { plaintext, record } = ledger.mint(scopes(), NOW);
    expect(ledger.remove(record.keyId)).toBe(true);
    expect(ledger.get(record.keyId)).toBeUndefined();
    expect(ledger.authenticate(plaintext, NOW)).toEqual({ ok: false, code: 'invalid_api_key' });
    expect(ledger.remove(record.keyId)).toBe(false);
  });
});

describe('authenticate', () => {
  it('accepts the minted key and refuses unknown, malformed and missing keys alike', () => {
    const ledger = new GatewayKeyLedger();
    const { plaintext, record } = ledger.mint(scopes(), NOW);
    const ok = ledger.authenticate(plaintext, NOW);
    expect(ok.ok && ok.record.keyId).toBe(record.keyId);
    const unknown = `dkg_gw_00000000_${'A'.repeat(43)}`;
    for (const presented of [unknown, undefined, '', 'Bearer x', `${plaintext}x`, plaintext.toUpperCase(), plaintext.slice(0, -1)]) {
      expect(ledger.authenticate(presented, NOW), String(presented)).toEqual({ ok: false, code: 'invalid_api_key' });
    }
  });

  it('reports revoked/expired only after the presented secret matched (S11)', () => {
    const ledger = new GatewayKeyLedger();
    const revoked = ledger.mint(scopes(), NOW);
    const expiring = ledger.mint(scopes({ expiresAt: NOW + 60 }), NOW);
    ledger.revoke(revoked.record.keyId, NOW + 1);
    expect(ledger.authenticate(revoked.plaintext, NOW + 2)).toEqual({ ok: false, code: 'key_revoked' });
    expect(ledger.authenticate(expiring.plaintext, NOW + 59).ok).toBe(true);
    expect(ledger.authenticate(expiring.plaintext, NOW + 60)).toEqual({ ok: false, code: 'key_expired' });
    // The same keyIds with a wrong secret are indistinguishable from unknown keys.
    for (const { plaintext } of [revoked, expiring]) {
      const wrongSecret = `${plaintext.slice(0, 16)}${'B'.repeat(43)}`;
      expect(GATEWAY_KEY_PATTERN.test(wrongSecret)).toBe(true);
      expect(ledger.authenticate(wrongSecret, NOW + 100)).toEqual({ ok: false, code: 'invalid_api_key' });
    }
  });

  it('revoke is idempotent and keeps the original revokedAt', () => {
    const ledger = new GatewayKeyLedger();
    const { record } = ledger.mint(scopes(), NOW);
    expect(ledger.revoke(record.keyId, NOW + 5)?.revokedAt).toBe(NOW + 5);
    expect(ledger.revoke(record.keyId, NOW + 9)?.revokedAt).toBe(NOW + 5);
    expect(ledger.revoke('gw_ffffffff', NOW)).toBeUndefined();
  });
});

describe('checkScope', () => {
  it('enforces the model allowlist and the query flag', () => {
    const ledger = new GatewayKeyLedger();
    const limited = ledger.mint(scopes({ allowQuery: false }), NOW).record;
    const open = ledger.mint(scopes({ modelAllowlist: null }), NOW).record;
    expect(ledger.checkScope(limited, { kind: 'inference', modelId: 'stub-chat' })).toEqual({ ok: true });
    expect(ledger.checkScope(limited, { kind: 'inference', modelId: 'other-model' })).toEqual({ ok: false, code: 'model_not_allowed' });
    expect(ledger.checkScope(limited, { kind: 'inference' })).toEqual({ ok: false, code: 'model_not_allowed' });
    expect(ledger.checkScope(limited, { kind: 'query' })).toEqual({ ok: false, code: 'query_not_allowed' });
    expect(ledger.checkScope(open, { kind: 'inference', modelId: 'anything' })).toEqual({ ok: true });
    expect(ledger.checkScope(open, { kind: 'query' })).toEqual({ ok: true });
  });
});

describe('reserve / settle / release', () => {
  it('holds the worst case, refuses over budget, and books settled usage', () => {
    const ledger = new GatewayKeyLedger();
    const { record } = ledger.mint(scopes({ budgetWei: 1000n }), NOW);
    expect(ledger.reserve(record.keyId, 'r1', 600n)).toEqual({ ok: true });
    expect(ledger.remainingWei(record.keyId)).toBe(400n);
    expect(ledger.reserve(record.keyId, 'r2', 401n)).toEqual({ ok: false, code: 'key_budget_exceeded', remainingWei: 400n });
    ledger.settle('r1', { costWei: 110n, servedUnits: 22n, kind: 'inference' }, NOW + 1);
    expect(ledger.get(record.keyId)?.usage).toEqual({
      spentWei: 110n,
      reservedWei: 0n,
      calls: 1,
      inferenceCalls: 1,
      queryCalls: 0,
      servedUnits: 22n,
      lastUsedAt: NOW + 1,
    });
    expect(ledger.reserve(record.keyId, 'r3', 50n)).toEqual({ ok: true });
    ledger.release('r3');
    ledger.release('r3'); // unknown ids are a no-op
    expect(ledger.get(record.keyId)?.usage).toMatchObject({ reservedWei: 0n, calls: 1 });
    expect(ledger.reserve(record.keyId, 'r4', 0n)).toEqual({ ok: true });
    ledger.settle('r4', { costWei: 0n, servedUnits: 3n, kind: 'query' }, NOW + 2);
    expect(ledger.get(record.keyId)?.usage).toMatchObject({ calls: 2, queryCalls: 1, servedUnits: 25n });
    expect(ledger.remainingWei(record.keyId)).toBe(890n);
    expect(ledger.remainingWei('gw_ffffffff')).toBe(0n);
  });

  it('refuses unknown keys, duplicate reservations and unknown settles', () => {
    const ledger = new GatewayKeyLedger();
    const { record } = ledger.mint(scopes(), NOW);
    expect(() => ledger.reserve('gw_ffffffff', 'r', 1n)).toThrow('unknown gateway key');
    ledger.reserve(record.keyId, 'dup', 1n);
    expect(() => ledger.reserve(record.keyId, 'dup', 1n)).toThrow('duplicate');
    expect(() => ledger.reserve(record.keyId, 'neg', -1n)).toThrow('non-negative');
    expect(() => ledger.settle('missing', { costWei: 1n, servedUnits: 1n, kind: 'query' }, NOW)).toThrow('no gateway key reservation');
  });

  it('conservation: Σ spentWei equals Σ settled costWei and reservations drain to 0 (randomized)', () => {
    const next = prng(1234);
    const ledger = new GatewayKeyLedger();
    const keyIds = [0, 1, 2].map((i) => ledger.mint(scopes({ label: `k${i}`, budgetWei: 50_000n }), NOW).record.keyId);
    const open: string[] = [];
    let settledTotal = 0n;
    for (let op = 0; op < 600; op++) {
      const roll = next();
      if (roll < 0.5 || open.length === 0) {
        const id = `res-${op}`;
        const worst = BigInt(1 + Math.floor(next() * 900));
        if (ledger.reserve(keyIds[Math.floor(next() * keyIds.length)], id, worst).ok) open.push(id);
        continue;
      }
      const id = open.splice(Math.floor(next() * open.length), 1)[0];
      if (roll < 0.8) {
        const cost = BigInt(Math.floor(next() * 500));
        ledger.settle(id, { costWei: cost, servedUnits: 1n, kind: next() < 0.5 ? 'inference' : 'query' }, NOW + op);
        settledTotal += cost;
      } else {
        ledger.release(id);
      }
    }
    for (const id of open.splice(0)) ledger.release(id);
    const keys = ledger.list();
    expect(keys.reduce((sum, k) => sum + k.usage.spentWei, 0n)).toBe(settledTotal);
    expect(keys.every((k) => k.usage.reservedWei === 0n)).toBe(true);
    expect(keys.every((k) => k.usage.spentWei <= k.scopes.budgetWei)).toBe(true);
  });
});

describe('persistence', () => {
  it('JSON round trip keeps keys and usage and drops in-flight reservations', () => {
    const ledger = new GatewayKeyLedger();
    const a = ledger.mint(scopes({ expiresAt: NOW + 3600 }), NOW);
    const b = ledger.mint(scopes({ modelAllowlist: null, allowQuery: false, label: '' }), NOW);
    ledger.reserve(a.record.keyId, 'done', 100n);
    ledger.settle('done', { costWei: 70n, servedUnits: 22n, kind: 'inference' }, NOW + 1);
    ledger.reserve(a.record.keyId, 'inflight', 500n);
    ledger.revoke(b.record.keyId, NOW + 2);
    const json = JSON.parse(JSON.stringify(ledger.toJSON()));
    expect(json.version).toBe(1);
    expect(json.keys[0].scopes.budgetWei).toBe('1000000000000000');
    expect(json.keys[0].usage).not.toHaveProperty('reservedWei');
    const restored = new GatewayKeyLedger(json);
    expect(restored.get(a.record.keyId)?.usage).toMatchObject({ spentWei: 70n, reservedWei: 0n, calls: 1, servedUnits: 22n });
    expect(restored.authenticate(a.plaintext, NOW + 3).ok).toBe(true);
    expect(restored.authenticate(b.plaintext, NOW + 3)).toEqual({ ok: false, code: 'key_revoked' });
    expect(restored.toJSON()).toEqual(json);
  });

  it('throws on a malformed ledger file (the daemon fails closed)', () => {
    const ledger = new GatewayKeyLedger();
    ledger.mint(scopes(), NOW);
    const good = JSON.parse(JSON.stringify(ledger.toJSON()));
    const key = good.keys[0];
    const bad: unknown[] = [
      null,
      { version: 2, keys: [] },
      { version: 1, keys: {} },
      { version: 1, keys: [{ ...key, keyId: 'nsm_k_1234' }] },
      { version: 1, keys: [{ ...key, keyHash: 'sha256:abc' }] },
      { version: 1, keys: [{ ...key, scopes: { ...key.scopes, budgetWei: 5 } }] },
      { version: 1, keys: [{ ...key, scopes: { ...key.scopes, rps: 0 } }] },
      { version: 1, keys: [{ ...key, usage: { ...key.usage, spentWei: '-1' } }] },
      { version: 1, keys: [{ ...key, usage: null }] },
      { version: 1, keys: [key, key] },
    ];
    for (const raw of bad) expect(() => new GatewayKeyLedger(raw as never), JSON.stringify(raw)).toThrow();
  });
});

describe('SlidingWindowRateLimiter', () => {
  it('allows `limit` hits per window per key', () => {
    const limiter = new SlidingWindowRateLimiter();
    for (let i = 0; i < 5; i++) expect(limiter.tryAcquire('k', 5, 1000 + i)).toBe(true);
    expect(limiter.tryAcquire('k', 5, 1100)).toBe(false);
    expect(limiter.tryAcquire('other', 5, 1100)).toBe(true);
    expect(limiter.tryAcquire('k', 5, 2000)).toBe(true); // the hit at 1000 left the window
    expect(limiter.tryAcquire('k', 5, 2000)).toBe(false); // 1001..1004 + 2000
    expect(limiter.tryAcquire('k', 5, 2001)).toBe(true); // 1001 left
    expect(limiter.tryAcquire('k', 5, 2001)).toBe(false);
    expect(limiter.tryAcquire('zero', 0, 3000)).toBe(false);
  });

  it('bounds the key map, evicting idle then least-recently-used keys', () => {
    const limiter = new SlidingWindowRateLimiter({ windowMs: 1000, maxKeys: 2 });
    limiter.tryAcquire('a', 1, 0);
    limiter.tryAcquire('b', 1, 10);
    limiter.tryAcquire('c', 1, 20);
    expect(limiter.size).toBe(2);
    expect(limiter.tryAcquire('a', 1, 30)).toBe(true); // 'a' was evicted, so its window restarted
    for (let i = 0; i < 100; i++) limiter.tryAcquire(`key-${i}`, 1, 5000 + i);
    expect(limiter.size).toBe(2);
    expect(() => new SlidingWindowRateLimiter({ maxKeys: 0 })).toThrow();
  });
});
