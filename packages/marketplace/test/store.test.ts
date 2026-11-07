// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BuyerStore, parsePlan } from '../src/index.js';

let dir: string;
const SUBSCRIPTION = `0x${'cd'.repeat(32)}`;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'marketplace-store-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

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

  it('makes one session key per subscription, stores it encrypted, and returns it again', async () => {
    const store = new BuyerStore(dir);
    expect(await store.sessionKeyAddress(SUBSCRIPTION)).toBeNull();
    const key = await store.sessionKeyFor(SUBSCRIPTION);
    expect(await store.sessionKeyAddress(SUBSCRIPTION.toUpperCase().replace('0X', '0x'))).toBe(key.address);

    const onDisk = await readFile(join(dir, 'session-keys.json'), 'utf8');
    expect(onDisk).toContain(key.address);
    expect(onDisk).not.toContain(key.privateKey.slice(2));
    expect((await stat(join(dir, 'session-keys.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'session-keys.secret'))).mode & 0o777).toBe(0o600);

    // Another process over the same directory reads the same key.
    const again = await new BuyerStore(dir).sessionKeyFor(SUBSCRIPTION);
    expect(again.privateKey).toBe(key.privateKey);
    const other = await store.sessionKeyFor(`0x${'ef'.repeat(32)}`);
    expect(other.address).not.toBe(key.address);
  });

  it('refuses to open the keys under another secret', async () => {
    await new BuyerStore(dir).sessionKeyFor(SUBSCRIPTION);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'session-keys.secret'), `${Buffer.alloc(32, 7).toString('base64')}\n`);
    await expect(new BuyerStore(dir).sessionKeyFor(SUBSCRIPTION)).rejects.toThrow();
  });
});
