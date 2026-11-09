// SPDX-License-Identifier: Apache-2.0

/**
 * What the buyer keeps on disk, under the node's data directory:
 *   - `plan.json`, the standing plan the user confirmed;
 *   - `session-keys.json`, one session key per subscription, sealed as the
 *     node seals its operational wallets' keys (core's node key store: the
 *     node's `wallets.key`, and `DKG_WALLETS_PASSPHRASE` when it is set);
 *   - `fundings.json`, the block each subscription was funded in, where reading
 *     what landed for it starts.
 *
 * A session key is written before the funding that names it is sent, so a
 * crash never leaves a funded subscription whose key is lost. Each file is
 * replaced whole (written aside, on disk, then renamed), with mode 0600.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ethers } from 'ethers';
import {
  NODE_KEY_PASSPHRASE_ENV,
  nodeKeySecret,
  openNodeKey,
  sealNodeKey,
  type NodeKeystore,
} from '@origintrail-official/dkg-core';
import { writeDurably } from './journal.js';
import { parsePlan, planToWire, type StandingPlan } from './plan.js';

/** A stored session key: its address in the clear, its key sealed, as a `wallets.json` entry is. */
interface StoredSessionKey {
  address: string;
  keystore: NodeKeystore;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
}

export class BuyerStore {
  /**
   * @param dir where the buyer's files go
   * @param keyDir the node's data directory, whose `wallets.key` seals the session keys; `dir` by default
   */
  constructor(readonly dir: string, readonly keyDir: string = dir) {}

  async readPlan(): Promise<StandingPlan | null> {
    const raw = await readJson<unknown>(join(this.dir, 'plan.json'));
    return raw === null ? null : parsePlan(raw);
  }

  async writePlan(plan: StandingPlan): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeDurably(join(this.dir, 'plan.json'), `${JSON.stringify(planToWire(plan), null, 2)}\n`);
  }

  /** The subscription's session key: the one stored for it, or a fresh one, stored before it is returned. */
  async sessionKeyFor(subscriptionId: string): Promise<ethers.Wallet> {
    const id = subscriptionId.toLowerCase();
    const keys = await this.readKeys();
    const secret = await nodeKeySecret(this.keyDir);
    const stored = keys[id];
    if (stored) return new ethers.Wallet(openNodeKey(stored.keystore, secret));
    const wallet = new ethers.Wallet(ethers.hexlify(randomBytes(32)));
    keys[id] = { address: wallet.address, keystore: sealNodeKey(wallet.privateKey, secret, process.env[NODE_KEY_PASSPHRASE_ENV]) };
    await mkdir(this.dir, { recursive: true });
    await writeDurably(join(this.dir, 'session-keys.json'), `${JSON.stringify(keys, null, 2)}\n`);
    return wallet;
  }

  /** The block a subscription was funded in, as the buyer recorded it; `null` when it did not. */
  async fundingBlock(subscriptionId: string): Promise<number | null> {
    return (await readJson<Record<string, number>>(join(this.dir, 'fundings.json')))?.[subscriptionId.toLowerCase()] ?? null;
  }

  async recordFunding(subscriptionId: string, blockNumber: number): Promise<void> {
    const fundings = (await readJson<Record<string, number>>(join(this.dir, 'fundings.json'))) ?? {};
    fundings[subscriptionId.toLowerCase()] = blockNumber;
    await mkdir(this.dir, { recursive: true });
    await writeDurably(join(this.dir, 'fundings.json'), `${JSON.stringify(fundings, null, 2)}\n`);
  }

  /** The stored session key's address, without opening it; `null` when none is stored. */
  async sessionKeyAddress(subscriptionId: string): Promise<string | null> {
    return (await this.readKeys())[subscriptionId.toLowerCase()]?.address ?? null;
  }

  private async readKeys(): Promise<Record<string, StoredSessionKey>> {
    return (await readJson<Record<string, StoredSessionKey>>(join(this.dir, 'session-keys.json'))) ?? {};
  }
}
