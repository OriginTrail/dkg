// SPDX-License-Identifier: Apache-2.0

import { chmodSync, mkdirSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';
import type {
  ContextGraphIdV1,
  Digest32V1,
  EvmAddressV1,
  NetworkIdV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import {
  INVENTORY_V1_APPLICATION_ID,
  INVENTORY_V1_RELATIVE_PATH,
  INVENTORY_V1_USER_OBJECTS,
  INVENTORY_V1_USER_VERSION,
  INVENTORY_V1_V4_USER_OBJECTS,
  INVENTORY_V1_V4_USER_VERSION,
  openInventoryV1,
} from '../src/rfc64/inventory-v1/index.js';
import { openRfc64PersistenceV1 } from '../src/rfc64/persistence-v1.js';
import {
  RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1,
  Rfc64UnregisteredAuthoritySeedErrorV1,
  createRfc64UnregisteredAuthoritySeedStoreV1,
  resolveRfc64WalletNamespaceOwnerV1,
  snapshotRfc64UnregisteredAuthoritySeedV1,
  type Rfc64UnregisteredAuthoritySeedRecordV1,
} from '../src/rfc64/unregistered-authority-seed-store-v1.js';
import { mintRfc64UnregisteredReplicaAuthoritySeedV1 } from
  '../src/rfc64/unregistered-replica-authority-v1.js';

const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const OWNER_WALLET = new ethers.Wallet(`0x${'71'.repeat(32)}`);
const OWNER = OWNER_WALLET.address.toLowerCase() as EvmAddressV1;
const CONTEXT_GRAPH_ID = `${OWNER}/seed-store` as ContextGraphIdV1;

const roots: string[] = [];
const inventories: Array<Awaited<ReturnType<typeof openInventoryV1>>> = [];
const persistences: Array<Awaited<ReturnType<typeof openRfc64PersistenceV1>>> = [];

afterEach(async () => {
  for (const persistence of persistences.splice(0)) {
    if (!persistence.closed) await persistence.close();
  }
  for (const inventory of inventories.splice(0)) {
    if (!inventory.closed) inventory.close();
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDataDir(label: string): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), `rfc64-seed-store-${label}-`));
  roots.push(dataDir);
  return dataDir;
}

async function openStore(dataDir: string) {
  const inventory = await openInventoryV1(dataDir);
  inventories.push(inventory);
  return createRfc64UnregisteredAuthoritySeedStoreV1(inventory);
}

async function mintRecord(input: Readonly<{
  readonly contextGraphId?: ContextGraphIdV1;
  readonly publishPolicy?: 0 | 1;
}> = {}): Promise<Readonly<Rfc64UnregisteredAuthoritySeedRecordV1>> {
  const contextGraphId = input.contextGraphId ?? CONTEXT_GRAPH_ID;
  const minted = await mintRfc64UnregisteredReplicaAuthoritySeedV1({
    networkId: NETWORK_ID,
    contextGraphId,
    ownerAddress: OWNER,
    accessPolicy: 0,
    publishPolicy: input.publishPolicy ?? 1,
    publishAuthorityAccountId: '0',
    memberAddresses: [],
    rosterVersion: '0',
    signer: {
      issuer: OWNER,
      signDigest: (digest) => OWNER_WALLET.signMessage(digest),
    },
  });
  return Object.freeze({
    networkId: NETWORK_ID,
    contextGraphId,
    ownerAddress: OWNER,
    policyDigest: minted.policyDigest,
    signedEnvelope: minted.canonicalEnvelopeBytes,
  });
}

describe('RFC-64 unregistered authority seed store (inventory table)', () => {
  it('round-trips one seed per (network, graph), replays identical bytes, and survives reopen', async () => {
    const dataDir = await temporaryDataDir('roundtrip');
    const record = await mintRecord();
    const store = await openStore(dataDir);

    await expect(store.read(NETWORK_ID, CONTEXT_GRAPH_ID)).resolves.toBeNull();
    await store.put(record);
    await store.put(record);
    const stored = await store.read(NETWORK_ID, CONTEXT_GRAPH_ID);
    expect(stored).not.toBeNull();
    expect(stored?.ownerAddress).toBe(OWNER);
    expect(stored?.policyDigest).toBe(record.policyDigest);
    expect(Buffer.from(stored!.signedEnvelope).equals(Buffer.from(record.signedEnvelope))).toBe(true);
    // Another graph in the same namespace is a different key.
    await expect(store.read(NETWORK_ID, `${OWNER}/other` as ContextGraphIdV1)).resolves.toBeNull();

    inventories.pop()?.close();
    const restarted = await openStore(dataDir);
    const durable = await restarted.read(NETWORK_ID, CONTEXT_GRAPH_ID);
    expect(durable?.policyDigest).toBe(record.policyDigest);
    expect(Buffer.from(durable!.signedEnvelope).equals(Buffer.from(record.signedEnvelope))).toBe(true);
  });

  it('keeps the first verified generation and refuses a differing digest for the same key', async () => {
    const dataDir = await temporaryDataDir('conflict');
    const first = await mintRecord({ publishPolicy: 1 });
    const second = await mintRecord({ publishPolicy: 0 });
    expect(second.policyDigest).not.toBe(first.policyDigest);
    const store = await openStore(dataDir);

    await store.put(first);
    await expect(store.put(second)).rejects.toMatchObject({
      name: 'Rfc64UnregisteredAuthoritySeedErrorV1',
      code: 'seed-conflict',
    });
    const stored = await store.read(NETWORK_ID, CONTEXT_GRAPH_ID);
    expect(stored?.policyDigest).toBe(first.policyDigest);
    expect(Buffer.from(stored!.signedEnvelope).equals(Buffer.from(first.signedEnvelope))).toBe(true);
  });

  it('rejects malformed records at the storage boundary before any write', async () => {
    const dataDir = await temporaryDataDir('input');
    const record = await mintRecord();
    const store = await openStore(dataDir);
    const attacker = `0x${'72'.repeat(20)}` as EvmAddressV1;

    const cases: ReadonlyArray<Readonly<Rfc64UnregisteredAuthoritySeedRecordV1>> = [
      // Not wallet-namespaced: a signature must never self-assign a bare name.
      { ...record, contextGraphId: 'global-name' as ContextGraphIdV1 },
      // Owner differs from the namespace prefix.
      { ...record, ownerAddress: attacker },
      // Oversize envelope.
      { ...record, signedEnvelope: new Uint8Array(RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1 + 1) },
      // Empty envelope.
      { ...record, signedEnvelope: new Uint8Array(0) },
      // Non-canonical digest.
      { ...record, policyDigest: 'not-a-digest' as Digest32V1 },
    ];
    for (const malformed of cases) {
      await expect(store.put(malformed)).rejects.toBeInstanceOf(Rfc64UnregisteredAuthoritySeedErrorV1);
      await expect(store.put(malformed)).rejects.toMatchObject({ code: 'seed-input' });
    }
    await expect(store.read(NETWORK_ID, CONTEXT_GRAPH_ID)).resolves.toBeNull();
    expect(() => snapshotRfc64UnregisteredAuthoritySeedV1(cases[0]!)).toThrowError(
      /wallet-namespaced/u,
    );
    expect(resolveRfc64WalletNamespaceOwnerV1('global-name')).toBeNull();
    expect(resolveRfc64WalletNamespaceOwnerV1(OWNER.toUpperCase().replace('0X', '0x'))).toBe(OWNER);
  });

  it('fails closed on a stored row that no longer satisfies the storage-boundary shape', async () => {
    const dataDir = await temporaryDataDir('corrupt-row');
    const record = await mintRecord();
    const store = await openStore(dataDir);
    await store.put(record);
    inventories.pop()?.close();

    // Bypass the store: rewrite the owner to a wallet that is not the graph's
    // namespace prefix. The SQL CHECK only pins the blob length, so the
    // row-level snapshot is the guard that must refuse it on read.
    const database = new DatabaseSync(join(dataDir, INVENTORY_V1_RELATIVE_PATH));
    try {
      database.prepare(
        'UPDATE rfc64_unregistered_authority_seeds_v1 SET owner_address = ? '
        + 'WHERE network_id = ? AND context_graph_id = ?',
      ).run(Buffer.alloc(20, 0x42), NETWORK_ID, CONTEXT_GRAPH_ID);
    } finally {
      database.close();
    }

    const reopened = await openStore(dataDir);
    await expect(reopened.read(NETWORK_ID, CONTEXT_GRAPH_ID)).rejects.toMatchObject({
      code: 'candidate-database-corrupt',
      message: /row is malformed/u,
    });
    // A replay of the legitimate seed conflicts with the row (no changes) and
    // the stored-generation check runs into the same corrupt row.
    await expect(reopened.put(record)).rejects.toMatchObject({
      code: 'candidate-database-corrupt',
    });
  });

  it('keeps the seed table co-located with SQLite and creates no parallel directory', async () => {
    const dataDir = await temporaryDataDir('layout');
    const store = await openStore(dataDir);
    await store.put(await mintRecord());
    const entries = await readdir(join(dataDir, 'rfc64-sync'));
    expect(entries.some((entry) => entry.includes('unregistered-authority'))).toBe(false);
  });

  it('migrates an exact V4 database to V5 without losing rows and opens an empty seed table', async () => {
    const dataDir = await temporaryDataDir('migrate');
    const path = join(dataDir, INVENTORY_V1_RELATIVE_PATH);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const v4 = new DatabaseSync(path);
    v4.exec([
      `PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID}`,
      'PRAGMA journal_mode = WAL',
      ...Object.values(INVENTORY_V1_V4_USER_OBJECTS),
      `PRAGMA user_version = ${INVENTORY_V1_V4_USER_VERSION}`,
    ].join(';\n'));
    v4.prepare(
      'INSERT INTO rfc64_finalized_private_placement_repairs_v1 VALUES (?, ?)',
    ).run(Buffer.alloc(32, 9), '{"kept":true}');
    v4.close();
    chmodSync(path, 0o600);

    const inventory = await openInventoryV1(dataDir);
    inventories.push(inventory);
    const store = createRfc64UnregisteredAuthoritySeedStoreV1(inventory);
    await expect(store.read(NETWORK_ID, CONTEXT_GRAPH_ID)).resolves.toBeNull();
    const record = await mintRecord();
    await store.put(record);
    inventories.pop()?.close();

    const migrated = new DatabaseSync(path, { readOnly: true });
    try {
      expect(migrated.prepare('PRAGMA user_version').get()?.user_version)
        .toBe(INVENTORY_V1_USER_VERSION);
      expect(migrated.prepare(
        'SELECT count(*) AS count FROM rfc64_finalized_private_placement_repairs_v1',
      ).get()?.count).toBe(1);
      expect(migrated.prepare(
        'SELECT count(*) AS count FROM rfc64_unregistered_authority_seeds_v1',
      ).get()?.count).toBe(1);
      const objects = migrated.prepare(
        `SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name`,
      ).all().map((row) => String(row.name));
      expect(objects).toEqual(Object.keys(INVENTORY_V1_USER_OBJECTS).sort());
    } finally {
      migrated.close();
    }
  });

  it('exposes the store on the persistence owner and fences it once closed', async () => {
    const dataDir = await temporaryDataDir('persistence');
    const persistence = await openRfc64PersistenceV1(dataDir, {
      yieldAfterPurgeBatch: async () => undefined,
    });
    persistences.push(persistence);
    const record = await mintRecord();

    await persistence.unregisteredAuthoritySeeds.put(record);
    await expect(persistence.unregisteredAuthoritySeeds.read(NETWORK_ID, CONTEXT_GRAPH_ID))
      .resolves.toMatchObject({ policyDigest: record.policyDigest });

    await persistence.close();
    await expect(persistence.unregisteredAuthoritySeeds.read(NETWORK_ID, CONTEXT_GRAPH_ID))
      .rejects.toThrow('RFC-64 persistence owner is closed');
    await expect(persistence.unregisteredAuthoritySeeds.put(record))
      .rejects.toThrow('RFC-64 persistence owner is closed');
  });
});
