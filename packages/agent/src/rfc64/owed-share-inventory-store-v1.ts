// SPDX-License-Identifier: Apache-2.0

/**
 * Durable markers for the signed author-inventory rows that committed shares still owe.
 *
 * A synchronous share into a catalog graph owes its author's signed SWM inventory row. While
 * this node's catalog authority for the graph is refresh-fenced (a graph created or registered
 * seconds ago, a pending roster read, the seconds after a restart) the authoring lane is
 * closed, so the share completes without the row and only the detached observer, with its
 * bounded settlement window, tries to write it. A marker kept here outlives that window and a
 * restart: its owner writes the row once the lane opens, then removes the marker.
 *
 * One file per marker in a directory of the RFC-64 persistence root, named by the SHA-256 of
 * the marker's canonical bytes. A marker is written through the durable file store (temporary
 * file, fsync, no-replace link, parent fsync) and removed by unlink and a parent fsync. The
 * directory is read once, at open: the persistence lease makes this process its only writer, so
 * the in-memory index stays exact. A separate directory, not an inventory table, keeps the
 * inventory schema version, and so a downgrade's ability to open it, unchanged.
 */

import { createHash } from 'node:crypto';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  assertAssertionCoordinateV1,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertContextGraphIdV1,
  assertSubGraphNameV1,
  assertSwmAuthorInventoryShareOperationIdV1,
  type AssertionCoordinateV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type SubGraphNameV1,
} from '@origintrail-official/dkg-core';

import {
  assertRfc64ExistingDirectoryV1,
  createRfc64DurableFileStoreV1,
  ensureRfc64SecureDirectoryTreeV1,
  type Rfc64DurableFileStoreV1,
} from './durable-file-store-v1.js';
import { fsyncRfc64DirectoryV1 } from './secure-filesystem-policy-v1.js';
import type { Rfc64PersistenceRootOwnershipV1 } from './persistence-root-ownership-v1-internal.js';

export const RFC64_OWED_SHARE_INVENTORY_DIRECTORY_NAME_V1 = 'owed-share-inventory-v1';
/** A canonical marker is a few hundred bytes; identifiers are bounded well below this. */
export const RFC64_OWED_SHARE_INVENTORY_MAX_BYTES_V1 = 4096;

const MARKER_FILE_PATTERN = /^([0-9a-f]{64})\.json$/u;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MARKER_KEYS = [
  'assertionCoordinate', 'authorAddress', 'contextGraphId', 'sealDigest',
  'shareOperationId', 'subGraphName', 'version',
].join('\n');

/** One committed share whose signed inventory row has not been written yet. */
export interface Rfc64OwedShareInventoryV1 {
  readonly version: 1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName: SubGraphNameV1 | null;
  /** Lowercase share author: its lifecycle agent and its seal's author. */
  readonly authorAddress: EvmAddressV1;
  readonly assertionCoordinate: AssertionCoordinateV1;
  /** Canonical graph-scoped author seal digest the share was admitted with. */
  readonly sealDigest: Digest32V1;
  readonly shareOperationId: string;
}

export interface Rfc64OwedShareInventoryStoreV1 {
  /** Every marker, those found at open first, then in the order they were written. */
  list(): readonly Readonly<Rfc64OwedShareInventoryV1>[];
  /** Marker files found at open that could not be read; they are left where they are. */
  readonly unreadableAtOpen: number;
  /** Durable when it resolves. Writing a marker that is already kept changes nothing. */
  put(marker: Readonly<Rfc64OwedShareInventoryV1>): Promise<void>;
  /** Durable when it resolves. Deleting a marker that is not kept changes nothing. */
  delete(marker: Readonly<Rfc64OwedShareInventoryV1>): Promise<void>;
  /** Wait for the operations in flight; later operations are refused. */
  close(): Promise<void>;
}

export function snapshotRfc64OwedShareInventoryV1(
  raw: unknown,
): Readonly<Rfc64OwedShareInventoryV1> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('RFC-64 owed share inventory marker is malformed');
  }
  const input = raw as Record<string, unknown>;
  if (input.version !== 1) throw new TypeError('RFC-64 owed share inventory version is invalid');
  assertContextGraphIdV1(input.contextGraphId, 'owed share inventory contextGraphId');
  if (input.subGraphName !== null) {
    assertSubGraphNameV1(input.subGraphName, 'owed share inventory subGraphName');
  }
  assertCanonicalEvmAddress(input.authorAddress, 'owed share inventory authorAddress');
  assertAssertionCoordinateV1(input.assertionCoordinate, 'owed share inventory assertionCoordinate');
  assertCanonicalDigest(input.sealDigest, 'owed share inventory sealDigest');
  assertSwmAuthorInventoryShareOperationIdV1(input.shareOperationId);
  return Object.freeze({
    version: 1,
    contextGraphId: input.contextGraphId,
    subGraphName: input.subGraphName,
    authorAddress: input.authorAddress,
    assertionCoordinate: input.assertionCoordinate,
    sealDigest: input.sealDigest,
    shareOperationId: input.shareOperationId,
  });
}

/** Canonical marker bytes; their SHA-256 is the marker's file name. */
export function encodeRfc64OwedShareInventoryV1(
  marker: Readonly<Rfc64OwedShareInventoryV1>,
): Uint8Array {
  return UTF8_ENCODER.encode(`${JSON.stringify(snapshotRfc64OwedShareInventoryV1(marker))}\n`);
}

export function parseRfc64OwedShareInventoryV1(
  bytes: Uint8Array,
): Readonly<Rfc64OwedShareInventoryV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch (cause) {
    throw new Error('RFC-64 owed share inventory marker is not valid JSON', { cause });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RFC-64 owed share inventory marker is malformed');
  }
  if (Object.keys(parsed).sort().join('\n') !== MARKER_KEYS) {
    throw new Error('RFC-64 owed share inventory marker has unknown fields');
  }
  return snapshotRfc64OwedShareInventoryV1(parsed);
}

function markerKey(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isNodeError(cause: unknown, code: string): boolean {
  return cause instanceof Error && (cause as NodeJS.ErrnoException).code === code;
}

type OwedShareInventoryFileKindV1 = 'owed-share-inventory';

class FileRfc64OwedShareInventoryStoreV1 implements Rfc64OwedShareInventoryStoreV1 {
  readonly #ownership: Rfc64PersistenceRootOwnershipV1;
  readonly #rootPath: string;
  readonly #durableFiles: Rfc64DurableFileStoreV1<OwedShareInventoryFileKindV1>;
  readonly #markers: Map<string, Readonly<Rfc64OwedShareInventoryV1>>;
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(
    ownership: Rfc64PersistenceRootOwnershipV1,
    rootPath: string,
    markers: Map<string, Readonly<Rfc64OwedShareInventoryV1>>,
    readonly unreadableAtOpen: number,
  ) {
    this.#ownership = ownership;
    this.#rootPath = rootPath;
    this.#durableFiles = createRfc64DurableFileStoreV1<OwedShareInventoryFileKindV1>(rootPath);
    this.#markers = markers;
  }

  list(): readonly Readonly<Rfc64OwedShareInventoryV1>[] {
    return Object.freeze([...this.#markers.values()]);
  }

  put(input: Readonly<Rfc64OwedShareInventoryV1>): Promise<void> {
    const marker = snapshotRfc64OwedShareInventoryV1(input);
    const bytes = encodeRfc64OwedShareInventoryV1(marker);
    const key = markerKey(bytes);
    return this.#serialize(async () => {
      // The index holds only markers that are already durable.
      if (this.#markers.has(key)) return;
      const rfc64RootPath = this.#ownership.assertHeldAndGetRootPathV1();
      await ensureRfc64SecureDirectoryTreeV1(this.#rootPath, rfc64RootPath, 'owner-only');
      await this.#durableFiles.putExactBytes({
        relativePath: `${key}.json`,
        bytes,
        maxBytes: RFC64_OWED_SHARE_INVENTORY_MAX_BYTES_V1,
        label: 'owed share inventory marker',
        kind: 'owed-share-inventory',
      });
      this.#markers.set(key, marker);
    });
  }

  delete(input: Readonly<Rfc64OwedShareInventoryV1>): Promise<void> {
    const key = markerKey(encodeRfc64OwedShareInventoryV1(input));
    return this.#serialize(async () => {
      this.#ownership.assertHeldAndGetRootPathV1();
      let removed = true;
      try {
        await unlink(join(this.#rootPath, `${key}.json`));
      } catch (cause) {
        if (!isNodeError(cause, 'ENOENT')) throw cause;
        removed = false;
      }
      // An earlier delete can have unlinked the file and failed on its directory fsync.
      if (removed || this.#markers.has(key)) await fsyncRfc64DirectoryV1(this.#rootPath);
      this.#markers.delete(key);
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail.catch(() => undefined);
  }

  /** One operation at a time keeps the file and its index entry in step. */
  #serialize(operation: () => Promise<void>): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('RFC-64 owed share inventory store is closed'));
    const next = this.#tail.catch(() => undefined).then(operation);
    this.#tail = next;
    return next;
  }
}

/** Open only with package-internal authority backed by the live persistence lease. */
export async function openRfc64OwedShareInventoryStoreForOwnedPersistenceRootV1(
  ownership: Rfc64PersistenceRootOwnershipV1,
): Promise<Rfc64OwedShareInventoryStoreV1> {
  const rfc64RootPath = ownership.assertHeldAndGetRootPathV1();
  const rootPath = resolve(rfc64RootPath, RFC64_OWED_SHARE_INVENTORY_DIRECTORY_NAME_V1);
  const markers = new Map<string, Readonly<Rfc64OwedShareInventoryV1>>();
  let unreadable = 0;
  try {
    await lstat(rootPath);
  } catch (cause) {
    if (isNodeError(cause, 'ENOENT')) {
      return new FileRfc64OwedShareInventoryStoreV1(ownership, rootPath, markers, 0);
    }
    throw cause;
  }
  await assertRfc64ExistingDirectoryV1(rootPath, 'RFC-64 owed share inventory directory', {
    access: 'owner-only',
  });
  const durableFiles = createRfc64DurableFileStoreV1<OwedShareInventoryFileKindV1>(rootPath);
  for (const name of (await readdir(rootPath)).sort()) {
    const key = MARKER_FILE_PATTERN.exec(name)?.[1];
    if (key === undefined) {
      // A temporary file of a write that a crash interrupted; nothing else writes here.
      if (name.startsWith('.') && name.endsWith('.tmp')) {
        await unlink(join(rootPath, name)).catch(() => undefined);
      }
      continue;
    }
    try {
      const bytes = await durableFiles.readOptionalBoundedBytes({
        relativePath: name,
        maxBytes: RFC64_OWED_SHARE_INVENTORY_MAX_BYTES_V1,
        label: 'owed share inventory marker',
      });
      if (bytes === null) continue;
      if (markerKey(bytes) !== key) throw new Error('marker bytes differ from their file name');
      markers.set(key, parseRfc64OwedShareInventoryV1(bytes));
    } catch {
      unreadable += 1;
    }
  }
  return new FileRfc64OwedShareInventoryStoreV1(ownership, rootPath, markers, unreadable);
}
