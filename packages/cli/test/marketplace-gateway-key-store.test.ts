// OT-RFC-27 gateway key store: 0600 hashed-at-rest persistence, atomic and
// SERIALIZED writes, durable mint (rollback on a failed write), reload
// preserving usage, and fail-closed loading of a malformed file.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  MarketplaceGatewayKeyStore,
  gatewayKeyStorePath,
  openGatewayKeyStore,
  type GatewayKeyStoreIo,
} from '../src/marketplace-gateway-key-store.js';
import { tempHome } from './marketplace-gateway-fixtures.js';
import { handleMarketplaceKeyRoutes } from '../src/daemon/routes/marketplace-keys.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

const scopes = {
  label: 'ci',
  budgetWei: 10n ** 18n,
  expiresAt: null,
  modelAllowlist: ['stub-chat'],
  allowQuery: true,
  rps: 5,
};
const NOW = 1_800_000_000;
const mode = (path: string): number => statSync(path).mode & 0o777;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MarketplaceGatewayKeyStore', () => {
  it('mint persists a hashed record at 0600 (dir 0700) and returns the plaintext once', async () => {
    const path = gatewayKeyStorePath(tempHome());
    const store = new MarketplaceGatewayKeyStore(path);
    const { plaintext, record } = await store.mint(scopes, NOW);
    expect(plaintext).toMatch(/^dkg_gw_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    expect(record.keyId).toBe(`gw_${plaintext.slice(7, 15)}`);
    expect(mode(path)).toBe(0o600);
    expect(mode(dirname(path))).toBe(0o700);
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).not.toContain(plaintext);
    expect(onDisk).not.toContain(plaintext.slice(-43));
    const json = JSON.parse(onDisk);
    expect(json.version).toBe(1);
    expect(json.keys[0]).toMatchObject({ keyId: record.keyId, keyHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect(json.keys[0].usage).not.toHaveProperty('reservedWei');
  });

  it('re-asserts 0600 when overwriting a pre-existing 0644 file', async () => {
    const path = gatewayKeyStorePath(tempHome());
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, keys: [] }));
    chmodSync(path, 0o644);
    const store = new MarketplaceGatewayKeyStore(path);
    await store.mint(scopes, NOW);
    expect(mode(path)).toBe(0o600);
  });

  it('a reload preserves keys and usage (reservations are not persisted)', async () => {
    const path = gatewayKeyStorePath(tempHome());
    const store = new MarketplaceGatewayKeyStore(path);
    const { plaintext, record } = await store.mint(scopes, NOW);
    expect(store.reserve(record.keyId, 'r1', 1000n)).toEqual({ ok: true });
    await store.settle('r1', { costWei: 600n, servedUnits: 12n, kind: 'inference' }, NOW + 5);
    expect(store.reserve(record.keyId, 'r2', 5000n)).toEqual({ ok: true });
    await store.persist();
    const reloaded = new MarketplaceGatewayKeyStore(path);
    const again = reloaded.ledger().get(record.keyId)!;
    expect(again.usage).toEqual({
      spentWei: 600n, reservedWei: 0n, calls: 1, inferenceCalls: 1, queryCalls: 0, servedUnits: 12n, lastUsedAt: NOW + 5,
    });
    expect(reloaded.ledger().authenticate(plaintext, NOW + 10).ok).toBe(true);
  });

  it('revocation persists and is idempotent', async () => {
    const path = gatewayKeyStorePath(tempHome());
    const store = new MarketplaceGatewayKeyStore(path);
    const { plaintext, record } = await store.mint(scopes, NOW);
    expect((await store.revoke(record.keyId, NOW + 1))!.revokedAt).toBe(NOW + 1);
    expect((await store.revoke(record.keyId, NOW + 99))!.revokedAt).toBe(NOW + 1);
    expect(await store.revoke('gw_00000000', NOW)).toBeUndefined();
    const reloaded = new MarketplaceGatewayKeyStore(path);
    expect(reloaded.ledger().authenticate(plaintext, NOW + 2)).toEqual({ ok: false, code: 'key_revoked' });
  });

  it('serializes writes: 50 concurrent settles at a frozen clock leave one well-formed file and no tmp files', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const path = gatewayKeyStorePath(tempHome());
    let inFlight = 0;
    let maxInFlight = 0;
    const io: GatewayKeyStoreIo = {
      readFileSync: (p) => readFileSync(p, 'utf8'),
      writeFile: async (p, data, opts) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        try {
          return await writeFile(p, data, opts);
        } finally {
          inFlight -= 1;
        }
      },
      rename, unlink, chmod, mkdir,
    };
    const store = new MarketplaceGatewayKeyStore(path, { io });
    const { record } = await store.mint(scopes, NOW);
    for (let i = 0; i < 50; i++) expect(store.reserve(record.keyId, `r${i}`, 10n)).toEqual({ ok: true });
    await Promise.all(Array.from({ length: 50 }, (_, i) =>
      store.settle(`r${i}`, { costWei: BigInt(i + 1), servedUnits: 1n, kind: i % 2 ? 'query' : 'inference' }, NOW + i)));
    await store.flush();
    expect(maxInFlight).toBe(1);
    const leftovers = readdirSync(dirname(path)).filter((name) => name.includes('.tmp.'));
    expect(leftovers).toEqual([]);
    const reloaded = new MarketplaceGatewayKeyStore(path);
    const usage = reloaded.ledger().get(record.keyId)!.usage;
    expect(usage).toEqual({ ...store.ledger().get(record.keyId)!.usage });
    expect(usage.spentWei).toBe(BigInt((50 * 51) / 2));
    expect(usage.calls).toBe(50);
    expect(usage.queryCalls).toBe(25);
  });

  it('mint is durable before it returns: a failed write rejects, returns no plaintext, and rolls the key back', async () => {
    const path = gatewayKeyStorePath(tempHome());
    const io: GatewayKeyStoreIo = {
      readFileSync: (p) => readFileSync(p, 'utf8'),
      writeFile: async () => { throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }); },
      rename, unlink, chmod, mkdir,
    };
    const store = new MarketplaceGatewayKeyStore(path, { io });
    let minted: unknown;
    await expect((async () => { minted = await store.mint(scopes, NOW); })()).rejects.toThrow(/ENOSPC/);
    expect(minted).toBeUndefined();
    expect(store.ledger().list()).toEqual([]);
  });

  it('a malformed file fails closed: no ledger, mint refuses, the file is never overwritten', async () => {
    const path = gatewayKeyStorePath(tempHome());
    mkdirSync(dirname(path), { recursive: true });
    const garbage = '{ not json';
    writeFileSync(path, garbage);
    const logs: string[] = [];
    const store = new MarketplaceGatewayKeyStore(path, { log: (line) => logs.push(line) });
    expect(store.available).toBe(false);
    expect(store.loadError).toMatch(/malformed/);
    expect(() => store.ledger()).toThrow(path);
    await expect(store.mint(scopes, NOW)).rejects.toThrow(/unusable/);
    expect(() => store.persist()).toThrow(/unusable/);
    expect(readFileSync(path, 'utf8')).toBe(garbage);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(path);
  });

  it('a structurally invalid ledger (bad record) also fails closed', () => {
    const path = gatewayKeyStorePath(tempHome());
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ version: 1, keys: [{ keyId: 'gw_zz', keyHash: 'x' }] }));
    expect(new MarketplaceGatewayKeyStore(path).available).toBe(false);
  });

  it('openGatewayKeyStore returns one shared store per data dir', () => {
    const home = tempHome();
    expect(openGatewayKeyStore(home)).toBe(openGatewayKeyStore(`${home}/`));
    expect(openGatewayKeyStore(home)).not.toBe(openGatewayKeyStore(tempHome()));
  });
});

describe('key admin routes over a failed-closed store', () => {
  it('answer 500 naming the file and the parse error; nothing is minted or written', async () => {
    const path = gatewayKeyStorePath(tempHome());
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not json');
    const store = new MarketplaceGatewayKeyStore(path);
    for (const [method, route, body] of [
      ['GET', '/api/marketplace/keys', undefined],
      ['POST', '/api/marketplace/keys', { budgetTrac: '1' }],
      ['POST', '/api/marketplace/keys/gw_00000000/revoke', {}],
    ] as const) {
      const res: any = { statusCode: 0, body: '' };
      res.writeHead = (status: number) => { res.statusCode = status; };
      res.end = (text: string) => { res.body = text; };
      const req: any = { method, url: route, ...(body ? { __dkgPrebufferedBody: Buffer.from(JSON.stringify(body)) } : {}) };
      const ctx = { req, res, path: route, url: new URL(`http://127.0.0.1${route}`) } as unknown as RequestContext;
      expect(await handleMarketplaceKeyRoutes(ctx, () => true, () => store)).toBe(true);
      expect(res.statusCode, `${method} ${route}`).toBe(500);
      const parsed = JSON.parse(res.body);
      expect(parsed.code).toBe('KEY_STORE_UNAVAILABLE');
      expect(parsed.file).toBe(path);
      expect(parsed.reason).toMatch(/malformed/);
    }
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });
});
