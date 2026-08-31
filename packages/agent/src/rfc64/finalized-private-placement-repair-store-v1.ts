// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';

import {
  assertAssertionCoordinateV1,
  assertCanonicalDeterministicUalV1,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertContextGraphIdV1,
  assertSwmAuthorInventoryScopeV1,
  parseCanonicalDecimalU64,
  type AssertionCoordinateV1,
  type CanonicalDeterministicUalV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type PositiveDecimalU64V1,
  type SwmAuthorInventoryScopeV1,
} from '@origintrail-official/dkg-core';

import {
  assertRfc64ExistingDirectoryV1,
  createRfc64DurableFileStoreV1,
} from './durable-file-store-v1.js';
import {
  RFC64_FINALIZED_PRIVATE_PLACEMENT_REPAIR_STORE_DIRECTORY_NAME_V1,
  resolveRfc64FinalizedPrivatePlacementRepairStorePathV1,
} from './persistence-layout-v1.js';
import type { Rfc64PersistenceRootOwnershipV1 } from
  './persistence-root-ownership-v1-internal.js';
import type { Rfc64ConfirmedSwmAuthorInventoryRowIdentityV1 } from
  './swm-author-inventory-producer-v1.js';

const MAX_MARKER_BYTES_V1 = 8 * 1024;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const MARKER_FILENAME_V1 = /^[0-9a-f]{64}\.json$/u;
const TEMP_MARKER_FILENAME_V1 = /^\.([0-9a-f]{64}\.json)\.[0-9a-f]{32}\.tmp$/u;

export interface Rfc64FinalizedPrivatePlacementRepairV1
  extends Rfc64ConfirmedSwmAuthorInventoryRowIdentityV1 {
  readonly version: 1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly authorAddress: EvmAddressV1;
  /** Exact confirmation-time scope; a policy transition must not redirect recovery. */
  readonly inventoryScope: SwmAuthorInventoryScopeV1;
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly assertionVersion: PositiveDecimalU64V1;
  readonly kaUal: CanonicalDeterministicUalV1;
  readonly sealDigest: Digest32V1;
}

export interface Rfc64FinalizedPrivatePlacementRepairStoreV1 {
  list(): readonly Readonly<Rfc64FinalizedPrivatePlacementRepairV1>[];
  put(repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>): Promise<void>;
  delete(repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>): Promise<void>;
}

/** Open only with package-internal authority backed by the live persistence lease. */
export async function openRfc64FinalizedPrivatePlacementRepairStoreForOwnedPersistenceRootV1(
  ownership: Rfc64PersistenceRootOwnershipV1,
): Promise<Rfc64FinalizedPrivatePlacementRepairStoreV1> {
  const persistenceRoot = ownership.assertHeldAndGetRootPathV1();
  await assertRfc64ExistingDirectoryV1(
    persistenceRoot,
    'RFC-64 persistence root',
    { access: 'owner-only' },
  );
  const durableFiles = createRfc64DurableFileStoreV1<'placement-repair'>(persistenceRoot);
  const directoryPath = resolveRfc64FinalizedPrivatePlacementRepairStorePathV1(
    persistenceRoot,
  );
  let entries: Array<{ readonly name: string; isFile(): boolean }>;
  let directoryExists = true;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true, encoding: 'utf8' });
  } catch (cause) {
    if (isNodeErrorV1(cause, 'ENOENT')) {
      entries = [];
      directoryExists = false;
    }
    else throw cause;
  }
  if (directoryExists) {
    await assertRfc64ExistingDirectoryV1(
      directoryPath,
      'RFC-64 finalized-private placement repair directory',
      { access: 'owner-only' },
    );
  }
  const markerEntries: typeof entries = [];
  const tempEntries: Array<{
    readonly entry: (typeof entries)[number];
    readonly targetFilename: string;
  }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) {
      throw new Error('RFC-64 finalized-private placement repair directory is malformed');
    }
    if (MARKER_FILENAME_V1.test(entry.name)) {
      markerEntries.push(entry);
      continue;
    }
    const tempMatch = TEMP_MARKER_FILENAME_V1.exec(entry.name);
    if (tempMatch?.[1] !== undefined) {
      tempEntries.push({ entry, targetFilename: tempMatch[1] });
      continue;
    }
    throw new Error('RFC-64 finalized-private placement repair directory is malformed');
  }

  const repairs = new Map<string, Readonly<Rfc64FinalizedPrivatePlacementRepairV1>>();
  for (const entry of markerEntries) {
    const bytes = await durableFiles.readOptionalBoundedBytes({
      relativePath: markerRelativePathV1(entry.name),
      maxBytes: MAX_MARKER_BYTES_V1,
      label: 'RFC-64 finalized-private placement repair marker',
    });
    if (bytes === null) {
      throw new Error('RFC-64 finalized-private placement repair marker disappeared during open');
    }
    const repair = parseRepairV1(bytes);
    if (markerFilenameV1(repair) !== entry.name || repairs.has(entry.name)) {
      throw new Error('RFC-64 finalized-private placement repair marker identity is invalid');
    }
    repairs.set(entry.name, repair);
  }
  for (const { entry, targetFilename } of tempEntries) {
    const tempRelativePath = markerRelativePathV1(entry.name);
    const bytes = await durableFiles.readOptionalBoundedBytes({
      relativePath: tempRelativePath,
      maxBytes: MAX_MARKER_BYTES_V1,
      label: 'RFC-64 finalized-private placement repair temporary marker',
    });
    if (bytes === null) {
      throw new Error(
        'RFC-64 finalized-private placement repair temporary marker disappeared during open',
      );
    }
    const repair = parseRepairV1(bytes);
    if (
      markerFilenameV1(repair) !== targetFilename
      || !bytesEqualV1(bytes, encodeRepairV1(repair))
    ) {
      throw new Error(
        'RFC-64 finalized-private placement repair temporary marker identity is invalid',
      );
    }
    await durableFiles.putExactBytes({
      relativePath: markerRelativePathV1(targetFilename),
      bytes,
      maxBytes: MAX_MARKER_BYTES_V1,
      label: 'RFC-64 finalized-private placement repair marker',
      kind: 'placement-repair',
    });
    const deleted = await durableFiles.deleteExactBytes({
      relativePath: tempRelativePath,
      expectedBytes: bytes,
      maxBytes: MAX_MARKER_BYTES_V1,
      label: 'RFC-64 finalized-private placement repair temporary marker',
      kind: 'placement-repair',
    });
    if (!deleted) {
      throw new Error(
        'RFC-64 finalized-private placement repair temporary marker disappeared during recovery',
      );
    }
    const current = repairs.get(targetFilename);
    if (
      current !== undefined
      && !bytesEqualV1(encodeRepairV1(current), bytes)
    ) {
      throw new Error('RFC-64 finalized-private placement repair recovery conflicts');
    }
    repairs.set(targetFilename, repair);
  }

  return Object.freeze({
    list: () => Object.freeze([...repairs.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, repair]) => repair)),
    put: async (input: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>) => {
      const repair = snapshotRepairV1(input);
      const filename = markerFilenameV1(repair);
      await durableFiles.putExactBytes({
        relativePath: markerRelativePathV1(filename),
        bytes: encodeRepairV1(repair),
        maxBytes: MAX_MARKER_BYTES_V1,
        label: 'RFC-64 finalized-private placement repair marker',
        kind: 'placement-repair',
      });
      repairs.set(filename, repair);
    },
    delete: async (input: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>) => {
      const repair = snapshotRepairV1(input);
      const filename = markerFilenameV1(repair);
      const current = repairs.get(filename);
      if (current === undefined) return;
      if (!bytesEqualV1(encodeRepairV1(current), encodeRepairV1(repair))) {
        throw new Error('RFC-64 finalized-private placement repair deletion conflicts');
      }
      const deleted = await durableFiles.deleteExactBytes({
        relativePath: markerRelativePathV1(filename),
        expectedBytes: encodeRepairV1(repair),
        maxBytes: MAX_MARKER_BYTES_V1,
        label: 'RFC-64 finalized-private placement repair marker',
        kind: 'placement-repair',
      });
      if (!deleted) {
        throw new Error('RFC-64 finalized-private placement repair marker changed before delete');
      }
      repairs.delete(filename);
    },
  });
}

export function snapshotRfc64FinalizedPrivatePlacementRepairV1(
  input: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
): Readonly<Rfc64FinalizedPrivatePlacementRepairV1> {
  return snapshotRepairV1(input);
}

function snapshotRepairV1(
  input: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
): Readonly<Rfc64FinalizedPrivatePlacementRepairV1> {
  if (input.version !== 1) throw new TypeError('RFC-64 placement repair version is invalid');
  assertContextGraphIdV1(input.contextGraphId, 'placement repair contextGraphId');
  assertCanonicalEvmAddress(input.authorAddress, 'placement repair authorAddress');
  assertSwmAuthorInventoryScopeV1(input.inventoryScope);
  if (input.inventoryScope.authorAddress !== input.authorAddress) {
    throw new TypeError('RFC-64 placement repair inventory scope author differs');
  }
  if (input.inventoryScope.contextGraphId !== input.contextGraphId) {
    throw new TypeError('RFC-64 placement repair inventory scope graph differs');
  }
  assertAssertionCoordinateV1(input.assertionCoordinate, 'placement repair assertionCoordinate');
  parseCanonicalDecimalU64(input.assertionVersion, 'placement repair assertionVersion');
  if (BigInt(input.assertionVersion) < 1n) {
    throw new TypeError('RFC-64 placement repair assertionVersion must be positive');
  }
  const canonicalUal = assertCanonicalDeterministicUalV1(input.kaUal);
  assertCanonicalDigest(input.sealDigest, 'placement repair sealDigest');
  return Object.freeze({
    version: 1,
    contextGraphId: input.contextGraphId,
    authorAddress: input.authorAddress,
    inventoryScope: Object.freeze({ ...input.inventoryScope }),
    assertionCoordinate: input.assertionCoordinate,
    assertionVersion: input.assertionVersion,
    kaUal: canonicalUal.ual,
    sealDigest: input.sealDigest,
  });
}

function encodeRepairV1(
  repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
): Uint8Array {
  return UTF8_ENCODER.encode(`${JSON.stringify(repair)}\n`);
}

function parseRepairV1(bytes: Uint8Array): Readonly<Rfc64FinalizedPrivatePlacementRepairV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch (cause) {
    throw new Error('RFC-64 finalized-private placement repair marker is not valid JSON', {
      cause,
    });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RFC-64 finalized-private placement repair marker is malformed');
  }
  const value = parsed as Record<string, unknown>;
  const expectedKeys = [
    'assertionCoordinate',
    'assertionVersion',
    'authorAddress',
    'contextGraphId',
    'inventoryScope',
    'kaUal',
    'sealDigest',
    'version',
  ];
  if (Object.keys(value).sort().join('\n') !== expectedKeys.join('\n')) {
    throw new Error('RFC-64 finalized-private placement repair marker has unknown fields');
  }
  try {
    return snapshotRepairV1(value as unknown as Rfc64FinalizedPrivatePlacementRepairV1);
  } catch (cause) {
    throw new Error('RFC-64 finalized-private placement repair marker is malformed', { cause });
  }
}

function markerFilenameV1(
  repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
): string {
  return `${createHash('sha256').update(encodeRepairV1(repair)).digest('hex')}.json`;
}

function markerRelativePathV1(filename: string): string {
  return `${RFC64_FINALIZED_PRIVATE_PLACEMENT_REPAIR_STORE_DIRECTORY_NAME_V1}/${filename}`;
}

function bytesEqualV1(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}

function isNodeErrorV1(cause: unknown, code: string): cause is NodeJS.ErrnoException {
  return cause instanceof Error && (cause as NodeJS.ErrnoException).code === code;
}
