// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NODE_KEY_PASSPHRASE_ENV, NODE_KEY_SECRET_FILE } from '@origintrail-official/dkg-core';
import { BuyerStore, parsePlan } from '../src/index.js';

let dir: string;
const SUBSCRIPTION = `0x${'cd'.repeat(32)}`;
// An obvious placeholder, made for this test only.
const PASSPHRASE = 'test-only passphrase';
const passphraseBefore = process.env[NODE_KEY_PASSPHRASE_ENV];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-store-'));
  delete process.env[NODE_KEY_PASSPHRASE_ENV];
});
afterEach(async () => {
  if (passphraseBefore === undefined) delete process.env[NODE_KEY_PASSPHRASE_ENV];
  else process.env[NODE_KEY_PASSPHRASE_ENV] = passphraseBefore;
  await rm(dir, { recursive: true, force: true });
});

describe('the buyer store', () => {
  it('keeps the standing plan', async () => {
    const store = new BuyerStore(join(dir, 'marketplace'));
    expect(await store.readPlan()).toBeNull();
    const plan = parsePlan({
      services: [{ serviceId: `0x${'0a'.repeat(32)}`, serviceClass: 'inference', value: '10', maxPricePerUnit: '1' }],
      source: { kind: 'wallet' },
      renew: true,
      renewUntilEpoch: 9,
    });
    await store.writePlan(plan);
    expect(await new BuyerStore(join(dir, 'marketplace')).readPlan()).toEqual(plan);
  });

  it("seals one session key per subscription under the node's wallets.key, and returns it again", async () => {
    const store = new BuyerStore(join(dir, 'marketplace'), dir);
    expect(await store.sessionKeyAddress(SUBSCRIPTION)).toBeNull();
    const key = await store.sessionKeyFor(SUBSCRIPTION);
    expect(await store.sessionKeyAddress(SUBSCRIPTION.toUpperCase().replace('0X', '0x'))).toBe(key.address);

    // As a wallets.json entry: the address in the clear, the key in a keystore.
    const onDisk = JSON.parse(await readFile(join(dir, 'marketplace', 'session-keys.json'), 'utf8'));
    expect(onDisk[SUBSCRIPTION]).toEqual({ address: key.address, keystore: expect.objectContaining({ v: 1, alg: 'aes-256-gcm', kdf: 'raw' }) });
    expect(JSON.stringify(onDisk)).not.toContain(key.privateKey.slice(2));
    expect((await stat(join(dir, 'marketplace', 'session-keys.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, NODE_KEY_SECRET_FILE))).mode & 0o777).toBe(0o600);

    // Another process over the same directories opens the same key.
    const again = await new BuyerStore(join(dir, 'marketplace'), dir).sessionKeyFor(SUBSCRIPTION);
    expect(again.privateKey).toBe(key.privateKey);
    const other = await store.sessionKeyFor(`0x${'ef'.repeat(32)}`);
    expect(other.address).not.toBe(key.address);
  });

  it('refuses to open the keys under another secret', async () => {
    await new BuyerStore(dir).sessionKeyFor(SUBSCRIPTION);
    await writeFile(join(dir, NODE_KEY_SECRET_FILE), `${Buffer.alloc(32, 7).toString('base64')}\n`);
    await expect(new BuyerStore(dir).sessionKeyFor(SUBSCRIPTION)).rejects.toThrow();
  });

  it('a key sealed with DKG_WALLETS_PASSPHRASE opens only with it', async () => {
    process.env[NODE_KEY_PASSPHRASE_ENV] = PASSPHRASE;
    const key = await new BuyerStore(dir).sessionKeyFor(SUBSCRIPTION);
    const onDisk = JSON.parse(await readFile(join(dir, 'session-keys.json'), 'utf8'));
    expect(onDisk[SUBSCRIPTION].keystore.kdf).toBe('scrypt');

    delete process.env[NODE_KEY_PASSPHRASE_ENV];
    await expect(new BuyerStore(dir).sessionKeyFor(SUBSCRIPTION)).rejects.toThrow(/DKG_WALLETS_PASSPHRASE which is not currently set/);
    process.env[NODE_KEY_PASSPHRASE_ENV] = 'another passphrase';
    await expect(new BuyerStore(dir).sessionKeyFor(SUBSCRIPTION)).rejects.toThrow();
    process.env[NODE_KEY_PASSPHRASE_ENV] = PASSPHRASE;
    expect((await new BuyerStore(dir).sessionKeyFor(SUBSCRIPTION)).privateKey).toBe(key.privateKey);
  });
});
