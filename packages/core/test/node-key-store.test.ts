// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NODE_KEY_PASSPHRASE_ENV,
  NODE_KEY_SECRET_FILE,
  nodeKeySecret,
  openNodeKey,
  readNodeKeySecret,
  sealNodeKey,
} from '../src/node-key-store.js';

// A key and a passphrase made up for this test only.
const KEY = `0x${'5a'.repeat(32)}`;
const PASSPHRASE = 'test-only passphrase';
const passphraseBefore = process.env[NODE_KEY_PASSPHRASE_ENV];
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'node-key-store-'));
  delete process.env[NODE_KEY_PASSPHRASE_ENV];
});
afterEach(async () => {
  if (passphraseBefore === undefined) delete process.env[NODE_KEY_PASSPHRASE_ENV];
  else process.env[NODE_KEY_PASSPHRASE_ENV] = passphraseBefore;
  await rm(dir, { recursive: true, force: true });
});

describe('the node key store', () => {
  it('makes the secret once, with mode 0600, and every caller gets that one', async () => {
    expect(await readNodeKeySecret(dir)).toBeUndefined();
    const [a, b] = await Promise.all([nodeKeySecret(dir), nodeKeySecret(dir)]);
    expect(a.equals(b)).toBe(true);
    expect((await nodeKeySecret(dir)).equals(a)).toBe(true);
    expect(Buffer.from((await readFile(join(dir, NODE_KEY_SECRET_FILE), 'utf8')).trim(), 'base64').equals(a)).toBe(true);
    expect((await stat(join(dir, NODE_KEY_SECRET_FILE))).mode & 0o777).toBe(0o600);
    await writeFile(join(dir, NODE_KEY_SECRET_FILE), 'c2hvcnQ=\n');
    await expect(readNodeKeySecret(dir)).rejects.toThrow(/malformed/);
  });

  it('seals and opens a key under the secret', async () => {
    const secret = await nodeKeySecret(dir);
    const sealed = sealNodeKey(KEY, secret);
    expect(sealed).toMatchObject({ v: 1, alg: 'aes-256-gcm', kdf: 'raw' });
    expect(JSON.stringify(sealed)).not.toContain(KEY.slice(2));
    expect(openNodeKey(sealed, secret)).toBe(KEY);
    expect(() => openNodeKey(sealed, Buffer.alloc(32, 1))).toThrow();
  });

  it('a key sealed with the passphrase opens only with it', async () => {
    const secret = await nodeKeySecret(dir);
    const sealed = sealNodeKey(KEY, secret, PASSPHRASE);
    expect(sealed.kdf).toBe('scrypt');
    expect(() => openNodeKey(sealed, secret)).toThrow(/not currently set/);
    process.env[NODE_KEY_PASSPHRASE_ENV] = 'another passphrase';
    expect(() => openNodeKey(sealed, secret)).toThrow();
    process.env[NODE_KEY_PASSPHRASE_ENV] = PASSPHRASE;
    expect(openNodeKey(sealed, secret)).toBe(KEY);
  });
});
