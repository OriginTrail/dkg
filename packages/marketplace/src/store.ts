// SPDX-License-Identifier: Apache-2.0

/**
 * What the buyer keeps on disk, under the node's data directory:
 *   - `plan.json`, the standing plan the user confirmed;
 *   - `session-keys.json`, one session key per subscription, each encrypted
 *     with AES-256-GCM under `session-keys.secret`, 32 random bytes made on
 *     first use, as the operational wallets' keys are kept (`wallets.key`).
 *
 * A session key is written before the funding that names it is sent, so a
 * crash never leaves a funded subscription whose key is lost. Each file is
 * replaced whole (written aside, then renamed), with mode 0600.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { parsePlan, planToWire, type StandingPlan } from './plan.js';

interface SealedKey {
  address: string;
  iv: string;
  ct: string;
  tag: string;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
}

async function writeAtomically(file: string, text: string): Promise<void> {
  const aside = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(aside, text, { mode: 0o600 });
  await rename(aside, file);
}

export class BuyerStore {
  private secret: Buffer | undefined;

  constructor(readonly dir: string) {}

  async readPlan(): Promise<StandingPlan | null> {
    const raw = await readJson<unknown>(join(this.dir, 'plan.json'));
    return raw === null ? null : parsePlan(raw);
  }

  async writePlan(plan: StandingPlan): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeAtomically(join(this.dir, 'plan.json'), `${JSON.stringify(planToWire(plan), null, 2)}\n`);
  }

  /** The subscription's session key: the one stored for it, or a fresh one, stored before it is returned. */
  async sessionKeyFor(subscriptionId: string): Promise<ethers.Wallet> {
    const id = subscriptionId.toLowerCase();
    const keys = await this.readKeys();
    const sealed = keys[id];
    if (sealed) return new ethers.Wallet(await this.open(sealed));
    const wallet = new ethers.Wallet(ethers.hexlify(randomBytes(32)));
    keys[id] = await this.seal(wallet);
    await writeAtomically(join(this.dir, 'session-keys.json'), `${JSON.stringify(keys, null, 2)}\n`);
    return wallet;
  }

  /** The stored session key's address, without decrypting it; `null` when none is stored. */
  async sessionKeyAddress(subscriptionId: string): Promise<string | null> {
    return (await this.readKeys())[subscriptionId.toLowerCase()]?.address ?? null;
  }

  private async readKeys(): Promise<Record<string, SealedKey>> {
    return (await readJson<Record<string, SealedKey>>(join(this.dir, 'session-keys.json'))) ?? {};
  }

  private async key(): Promise<Buffer> {
    if (this.secret) return this.secret;
    const file = join(this.dir, 'session-keys.secret');
    const stored = await readFile(file, 'utf8').catch((err: { code?: string }) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (stored !== null) {
      const secret = Buffer.from(stored.trim(), 'base64');
      if (secret.length !== 32) throw new Error(`${file} is malformed: expected 32 bytes in base64`);
      return (this.secret = secret);
    }
    await mkdir(this.dir, { recursive: true });
    const secret = randomBytes(32);
    await writeFile(file, `${secret.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
    return (this.secret = secret);
  }

  private async seal(wallet: ethers.Wallet): Promise<SealedKey> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await this.key(), iv);
    const ct = Buffer.concat([cipher.update(wallet.privateKey, 'utf8'), cipher.final()]);
    return { address: wallet.address, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }

  private async open(sealed: SealedKey): Promise<string> {
    const decipher = createDecipheriv('aes-256-gcm', await this.key(), Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]).toString('utf8');
  }
}
