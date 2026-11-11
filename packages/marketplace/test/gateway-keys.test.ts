// SPDX-License-Identifier: Apache-2.0
/**
 * Access keys kept in memory, in the buyer's ledger: the journal read once
 * whatever token comes, every change applied as it is appended, what calls
 * charged folded into each key when their epoch is made final, the same keys
 * after a restart, and a key's budget reserved across its calls at once.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessKeys, BUYER_LEDGER_FILE, Journal, type KeptReceipt } from '../src/index.js';

let dir: string;
const scopes = (budget: bigint) => ({ label: 'test-agent', budget, services: null, rps: 1_000, expiresAt: null });
const lines = async () => (await readFile(join(dir, BUYER_LEDGER_FILE), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const SUBSCRIPTION = `0x${'0a'.repeat(32)}`;
let calls = 0;
/** A call of `epoch` accepted with a receipt worth `value`, as the gateway records it. */
const accepted = (keyId: string, value: bigint, epoch = 1): KeptReceipt => {
  const nonce = String(calls++);
  return {
    callId: `0x${nonce.padStart(64, '0')}`, epoch, subscriptionId: SUBSCRIPTION, budgetIndex: 0, seller: '1', keyId,
    request: { subscriptionId: SUBSCRIPTION, serviceId: SUBSCRIPTION, seller: '1', nonce, pricePerUnit: '1', maxUnits: '1000', maxValueWei: '1000', issuedAt: 1, expiry: 2 },
    signature: '0x', receipt: { requestDigest: SUBSCRIPTION, resultCommitment: SUBSCRIPTION, units: String(value), valueWei: String(value), completedAt: 2 },
    receiptSignature: '0x', state: 'held',
  };
};
/** What the gateway does once a call's receipt is checked: the call kept with its key's charge, in one record. */
const charge = (keys: AccessKeys, keyId: string, value: bigint, at: number, epoch = 1) => keys.ledger.recordAccepted(accepted(keyId, value, epoch), at);

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
    // The first use reads what there is: on a node new to the ledger, the journals it replaces, none written here.
    const read = reads.mock.calls.length;
    for (let i = 0; i < 50; i++) {
      expect(await keys.check(`dkgmk_${'00'.repeat(24)}`, 2)).toMatchObject({ ok: false, code: 'unknown_key' });
      expect(await keys.check(undefined, 2)).toMatchObject({ ok: false, code: 'missing_key' });
      expect((await keys.check(secret, 2)).ok).toBe(true);
    }
    await charge(keys, key.keyId, 7n, 3);
    await keys.revoke(key.keyId, 4);
    expect(await keys.list()).toEqual([expect.objectContaining({ spent: '7', lastUsedAt: 3, revoked: true })]);
    expect(await keys.check(secret, 5)).toMatchObject({ ok: false, code: 'revoked_key' });
    expect(reads).toHaveBeenCalledTimes(read);
    // What another process reads from the journal is what this one keeps.
    expect(await new AccessKeys(dir).list()).toEqual(await keys.list());
  });

  it('give two keys made at once ids of their own, each checked under the ledger lock', async () => {
    // Both makes draw the same first secret; the one that writes second draws again.
    const draws = [Buffer.alloc(24, 1), Buffer.alloc(24, 1), Buffer.alloc(24, 2)];
    const keys = new AccessKeys(dir, () => draws.shift()!);
    const made = await Promise.all([keys.make(scopes(1n), 1), keys.make(scopes(1n), 1)]);
    expect(made.map((m) => m.key.keyId)).toEqual([`dkgmk_${'01'.repeat(8)}`, `dkgmk_${'02'.repeat(8)}`]);
    expect((await lines()).map((l) => l.keyId)).toEqual(made.map((m) => m.key.keyId));
  });

  it('fold what the calls of an epoch made final charged into each key', async () => {
    const keys = new AccessKeys(dir);
    const { key } = await keys.make(scopes(1_000n), 1);
    for (let i = 0; i < 20; i++) await charge(keys, key.keyId, 2n, 100 + i, 1);
    for (let i = 0; i < 5; i++) await charge(keys, key.keyId, 2n, 200 + i, 2);
    expect((await keys.list())[0]).toMatchObject({ spent: '50', lastUsedAt: 204 });
    // Epoch 1 made final: its calls go, folded into the key with 40 spent; epoch 2's five stay with their charges.
    await keys.ledger.finalize(1, SUBSCRIPTION, [], []);
    const kept = await lines();
    expect(kept[0]).toMatchObject({ type: 'key', keyId: key.keyId, spent: '40', lastUsedAt: 119 });
    expect(kept.filter((l) => l.type === 'call')).toHaveLength(5);
    expect((await keys.list())[0]).toMatchObject({ spent: '50', lastUsedAt: 204 });
    // A restart reads the same keys.
    const restarted = new AccessKeys(dir);
    expect(await restarted.list()).toEqual(await keys.list());
    await restarted.ledger.finalize(2, SUBSCRIPTION, [], []);
    expect((await lines()).filter((l) => l.type === 'key')).toEqual([expect.objectContaining({ spent: '50', lastUsedAt: 204 })]);
  });

  it("hold a key's budget across its calls at once: reserved before each, settled after", async () => {
    const keys = new AccessKeys(dir);
    const { key } = await keys.make(scopes(100n), 1);
    expect(await keys.reserve(key.keyId, 60n)).toBe(true);
    expect(await keys.reserve(key.keyId, 60n)).toBe(false);
    expect(await keys.reserve(key.keyId, 40n)).toBe(true);
    expect(keys.reservedOf(key.keyId)).toBe(100n);
    // The first cost 25 of the 60 it reserved: kept with its charge, then its reservation released.
    await charge(keys, key.keyId, 25n, 5);
    keys.release(key.keyId, 60n);
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
    await charge(keys, key.keyId, 25n, 3);
    keys.release(key.keyId, 60n);
    keys.hold(key.keyId, 30n);
    expect((await keys.list())[0]).toMatchObject({ spent: '25', reserved: '30' });
    // What it has left is budget − spent − reserved: 45.
    expect(await keys.reserve(key.keyId, 46n)).toBe(false);
    expect(await keys.reserve(key.keyId, 45n)).toBe(true);
    expect(await keys.revoke(key.keyId, 4)).toMatchObject({ revoked: true, spent: '25', reserved: '75' });
    keys.release(key.keyId, 75n);
    expect((await keys.list())[0]).toMatchObject({ reserved: '0' });
    // Reservations are kept in memory: a key read from the ledger again holds none until its calls are held again.
    keys.hold(key.keyId, 5n);
    expect((await new AccessKeys(dir).list())[0]).toMatchObject({ spent: '25', reserved: '0' });
  });

  it('keep the journal as it is when making an epoch final fails, and make it final at the next try', async () => {
    const keys = new AccessKeys(dir);
    const { key } = await keys.make(scopes(1_000n), 1);
    for (let i = 0; i < 3; i++) await charge(keys, key.keyId, 1n, 10 + i);
    const replace = vi.spyOn(Journal.prototype, 'replace').mockRejectedValueOnce(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
    // The rewrite fails: the journal and what the ledger holds stay as they were.
    await expect(keys.ledger.finalize(1, SUBSCRIPTION, [], [{ keyId: key.keyId, value: 5n, at: 30 }])).rejects.toThrow('ENOSPC');
    expect(replace).toHaveBeenCalledTimes(1);
    expect(await lines()).toHaveLength(4);
    expect((await keys.list())[0]).toMatchObject({ spent: '3', lastUsedAt: 12 });
    expect(keys.ledger.final(1)).toBeUndefined();
    await keys.ledger.finalize(1, SUBSCRIPTION, [], [{ keyId: key.keyId, value: 5n, at: 30 }]);
    expect(await lines()).toEqual([expect.objectContaining({ type: 'key', spent: '8', lastUsedAt: 30 }), { type: 'final', epoch: 1, rows: [] }]);
    expect((await keys.list())[0]).toMatchObject({ spent: '8', lastUsedAt: 30 });
  });

  it('read the journal again at the next use when a read fails', async () => {
    const keys = new AccessKeys(dir);
    vi.spyOn(Journal.prototype, 'read').mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(keys.list()).rejects.toThrow('EACCES');
    const { key } = await keys.make(scopes(1n), 1);
    expect((await keys.list()).map((k) => k.keyId)).toEqual([key.keyId]);
  });
});
