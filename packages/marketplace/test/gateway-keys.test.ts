// SPDX-License-Identifier: Apache-2.0
/**
 * Access keys kept in memory: the journal read once whatever token comes,
 * every change applied as it is appended, compacted every so many charges
 * without the gateway's job, the same keys after a restart, and a key's budget
 * reserved across its calls at once.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessKeys, Journal } from '../src/index.js';

let dir: string;
const scopes = (budget: bigint) => ({ label: 'test-agent', budget, services: null, rps: 1_000, expiresAt: null });
const lines = async () => (await readFile(join(dir, 'access-keys.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-keys-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('access keys in memory', () => {
  it('read the journal once, whatever token is presented, and keep every change in memory', async () => {
    const reads = vi.spyOn(Journal.prototype, 'read');
    const keys = new AccessKeys(dir);
    const { secret, key } = await keys.make(scopes(1_000n), 1);
    for (let i = 0; i < 50; i++) {
      expect(await keys.check(`dkgmk_${'00'.repeat(24)}`, 2)).toMatchObject({ ok: false, code: 'unknown_key' });
      expect(await keys.check(undefined, 2)).toMatchObject({ ok: false, code: 'missing_key' });
      expect((await keys.check(secret, 2)).ok).toBe(true);
    }
    await keys.charge(key.keyId, 7n, 3);
    await keys.revoke(key.keyId, 4);
    expect(await keys.list()).toEqual([expect.objectContaining({ spent: '7', lastUsedAt: 3, revoked: true })]);
    expect(await keys.check(secret, 5)).toMatchObject({ ok: false, code: 'revoked_key' });
    expect(reads).toHaveBeenCalledTimes(1);
    // What another process reads from the journal is what this one keeps.
    expect(await new AccessKeys(dir).list()).toEqual(await keys.list());
  });

  it('fold the charges into each key every so many charges, without the gateway', async () => {
    const keys = new AccessKeys(dir, 10);
    const { key } = await keys.make(scopes(1_000n), 1);
    for (let i = 0; i < 25; i++) await keys.charge(key.keyId, 2n, 100 + i);
    // Folded at the 10th and the 20th charge: the key with 40 spent, then five charges.
    const kept = await lines();
    expect(kept).toHaveLength(6);
    expect(kept[0]).toMatchObject({ type: 'make', keyId: key.keyId, spent: '40', lastUsedAt: 119 });
    expect(kept.slice(1).every((l) => l.type === 'use')).toBe(true);
    expect((await keys.list())[0]).toMatchObject({ spent: '50', lastUsedAt: 124 });
    // A restart reads the same keys, and folds at its own count.
    const restarted = new AccessKeys(dir, 10);
    expect(await restarted.list()).toEqual(await keys.list());
    for (let i = 0; i < 5; i++) await restarted.charge(key.keyId, 1n, 200);
    expect(await lines()).toEqual([expect.objectContaining({ type: 'make', spent: '55', lastUsedAt: 200 })]);
  });

  it("hold a key's budget across its calls at once: reserved before each, settled after", async () => {
    const keys = new AccessKeys(dir);
    const { key } = await keys.make(scopes(100n), 1);
    expect(await keys.reserve(key.keyId, 60n)).toBe(true);
    expect(await keys.reserve(key.keyId, 60n)).toBe(false);
    expect(await keys.reserve(key.keyId, 40n)).toBe(true);
    expect(keys.reservedOf(key.keyId)).toBe(100n);
    // The first cost 25 of the 60 it reserved.
    await keys.settle(key.keyId, 60n, 25n, 5);
    expect(keys.reservedOf(key.keyId)).toBe(40n);
    expect(await keys.reserve(key.keyId, 35n)).toBe(true);
    expect(await keys.reserve(key.keyId, 1n)).toBe(false);
    keys.release(key.keyId, 75n);
    expect(keys.reservedOf(key.keyId)).toBe(0n);
    // A reservation read back at load holds whatever the key has left.
    keys.hold(key.keyId, 500n);
    expect(await keys.reserve(key.keyId, 1n)).toBe(false);
    expect(await keys.reserve('dkgmk_none', 1n)).toBe(false);
    expect((await keys.list())[0]).toMatchObject({ spent: '25' });
  });

  it('show what calls not yet settled hold of each key, beside what they cost, wherever a key is shown', async () => {
    const keys = new AccessKeys(dir);
    const { secret, key } = await keys.make(scopes(100n), 1);
    expect(key).toMatchObject({ budget: '100', spent: '0', reserved: '0' });
    expect(await keys.reserve(key.keyId, 60n)).toBe(true);
    expect(await keys.list()).toEqual([expect.objectContaining({ spent: '0', reserved: '60' })]);
    expect(await keys.check(secret, 2)).toMatchObject({ ok: true, key: { reserved: '60' } });
    // The call cost 25; another, whose cost is not known yet, is read back at load.
    await keys.settle(key.keyId, 60n, 25n, 3);
    keys.hold(key.keyId, 30n);
    expect((await keys.list())[0]).toMatchObject({ spent: '25', reserved: '30' });
    // What it has left is budget − spent − reserved: 45.
    expect(await keys.reserve(key.keyId, 46n)).toBe(false);
    expect(await keys.reserve(key.keyId, 45n)).toBe(true);
    expect(await keys.revoke(key.keyId, 4)).toMatchObject({ revoked: true, spent: '25', reserved: '75' });
    keys.release(key.keyId, 75n);
    expect((await keys.list())[0]).toMatchObject({ reserved: '0' });
    // Reservations are kept in memory: a key read from the journal again holds none until its calls are held again.
    keys.hold(key.keyId, 5n);
    expect((await new AccessKeys(dir).list())[0]).toMatchObject({ spent: '25', reserved: '0' });
  });

  it('keep the journal as it is when a compaction fails, and compact at the next charge', async () => {
    const keys = new AccessKeys(dir, 3);
    const { key } = await keys.make(scopes(1_000n), 1);
    const replace = vi.spyOn(Journal.prototype, 'replace').mockRejectedValueOnce(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
    // The third charge compacts, and that fails: the charge still counts.
    for (let i = 0; i < 3; i++) await keys.charge(key.keyId, 1n, 10 + i);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(await lines()).toHaveLength(4);
    expect((await keys.list())[0]).toMatchObject({ spent: '3' });
    await keys.charge(key.keyId, 1n, 20);
    expect(await lines()).toEqual([expect.objectContaining({ type: 'make', spent: '4', lastUsedAt: 20 })]);
  });

  it('read the journal again at the next use when a read fails', async () => {
    const keys = new AccessKeys(dir);
    vi.spyOn(Journal.prototype, 'read').mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(keys.list()).rejects.toThrow('EACCES');
    const { key } = await keys.make(scopes(1n), 1);
    expect((await keys.list()).map((k) => k.keyId)).toEqual([key.keyId]);
  });
});
