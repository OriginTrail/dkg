import { join, resolve } from 'node:path';

import {
  assertCanonicalDigest,
  decodeOpaqueKaBundleV1,
  type Digest32V1,
} from '@origintrail-official/dkg-core';

import {
  Rfc64DurableFileErrorV1,
  assertRfc64ExistingDirectoryV1,
  createRfc64DurableFileStoreV1,
  ensureRfc64SecureDirectoryTreeV1,
  type Rfc64DurableFileStoreV1,
} from './durable-file-store-v1.js';
import {
  RFC64_SECURE_DIRECTORY_MODE_V1,
  RFC64_SECURE_FILE_MODE_V1,
  rfc64NamespaceDurabilityV1,
  type Rfc64NamespaceDurabilityV1,
} from './secure-filesystem-policy-v1.js';
import {
  RFC64_KA_BUNDLE_STORE_RELATIVE_PATH,
  resolveRfc64KaBundleStorePathV1,
} from './persistence-layout-v1.js';
import type { Rfc64PersistenceRootOwnershipV1 } from './persistence-root-ownership-v1-internal.js';

export { RFC64_KA_BUNDLE_STORE_RELATIVE_PATH };
export const RFC64_KA_BUNDLE_STORE_DIRECTORY_MODE = RFC64_SECURE_DIRECTORY_MODE_V1;
export const RFC64_KA_BUNDLE_STORE_FILE_MODE = RFC64_SECURE_FILE_MODE_V1;
/** Gate-1 native transport response ceiling minus its one-byte status prefix. */
export const RFC64_KA_BUNDLE_STORE_MAX_BYTES_V1 = 8 * 1024 * 1024 - 1;

const BUNDLES_DIRECTORY = 'bundles';
const BUNDLE_FILE_SUFFIX = '.bundle';

export const RFC64_KA_BUNDLE_STORE_ERROR_CODES_V1 = Object.freeze([
  'ka-bundle-store-input',
  'ka-bundle-store-verification',
  'ka-bundle-store-unsafe-path',
  'ka-bundle-store-corrupt',
  'ka-bundle-store-io',
  'ka-bundle-store-durability',
  'ka-bundle-store-closed',
] as const);

export type Rfc64KaBundleStoreErrorCodeV1 =
  (typeof RFC64_KA_BUNDLE_STORE_ERROR_CODES_V1)[number];

export class Rfc64KaBundleStoreErrorV1 extends Error {
  constructor(
    readonly code: Rfc64KaBundleStoreErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    if (!RFC64_KA_BUNDLE_STORE_ERROR_CODES_V1.includes(code)) {
      throw new TypeError(`Unsupported RFC-64 KA-bundle store error code: ${code}`);
    }
    this.name = 'Rfc64KaBundleStoreErrorV1';
  }
}

export interface PutRfc64KaBundleInputV1 {
  readonly blobDigest: Digest32V1;
  /** One complete strict opaque KA-bundle frame. */
  readonly bundleBytes: Uint8Array;
}

export interface PutRfc64KaBundleResultV1 {
  readonly durable: true;
  readonly namespaceDurability: Rfc64NamespaceDurabilityV1;
  readonly blobDigest: Digest32V1;
  readonly byteLength: number;
}

export type Rfc64KaBundleOperationsV1 = Pick<
  Rfc64KaBundleStoreV1,
  'namespaceDurability' | 'putKaBundle' | 'readKaBundleByDigest'
>;

export interface Rfc64KaBundleStoreV1 {
  readonly rootPath: string;
  readonly closed: boolean;
  readonly namespaceDurability: Rfc64NamespaceDurabilityV1;
  putKaBundle(input: PutRfc64KaBundleInputV1): Promise<PutRfc64KaBundleResultV1>;
  readKaBundleByDigest(blobDigest: Digest32V1): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

type Rfc64KaBundleStoreFileKindV1 = 'ka-bundle';

class FileRfc64KaBundleStoreV1 implements Rfc64KaBundleStoreV1 {
  #closed = false;
  #closePromise: Promise<void> | null = null;
  readonly #inFlightOperations = new Set<Promise<unknown>>();
  readonly #durableFiles: Rfc64DurableFileStoreV1<Rfc64KaBundleStoreFileKindV1>;
  readonly namespaceDurability = rfc64NamespaceDurabilityV1();

  constructor(
    readonly rootPath: string,
    durableFiles: Rfc64DurableFileStoreV1<Rfc64KaBundleStoreFileKindV1>,
  ) {
    this.#durableFiles = durableFiles;
  }

  get closed(): boolean {
    return this.#closed;
  }

  putKaBundle(input: PutRfc64KaBundleInputV1): Promise<PutRfc64KaBundleResultV1> {
    this.requireOpen();
    const prepared = prepareBundle(input);
    const operation = (async () => {
      await mapDurableFileErrors(async () => {
        await this.#durableFiles.putExactBytes({
          relativePath: bundleRelativePath(prepared.blobDigest),
          bytes: prepared.bundleBytes,
          maxBytes: RFC64_KA_BUNDLE_STORE_MAX_BYTES_V1,
          label: 'opaque KA bundle',
          kind: 'ka-bundle',
        });
      });
      return Object.freeze({
        durable: true as const,
        namespaceDurability: this.namespaceDurability,
        blobDigest: prepared.blobDigest,
        byteLength: prepared.bundleBytes.byteLength,
      });
    })();
    return this.trackOperation(operation);
  }

  readKaBundleByDigest(blobDigestInput: Digest32V1): Promise<Uint8Array | null> {
    this.requireOpen();
    const blobDigest = snapshotDigest(blobDigestInput, 'blobDigest');
    const operation = (async () => {
      const bundleBytes = await mapDurableFileErrors(async () =>
        this.#durableFiles.readOptionalBoundedBytes({
          relativePath: bundleRelativePath(blobDigest),
          maxBytes: RFC64_KA_BUNDLE_STORE_MAX_BYTES_V1,
          label: 'opaque KA bundle',
        }));
      if (bundleBytes === null) return null;
      assertBundleMatchesDigest(bundleBytes, blobDigest, 'ka-bundle-store-corrupt');
      return bundleBytes;
    })();
    return this.trackOperation(operation);
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      while (this.#inFlightOperations.size > 0) {
        await Promise.allSettled([...this.#inFlightOperations]);
      }
    })();
    return this.#closePromise;
  }

  private requireOpen(): void {
    if (this.#closed) fail('ka-bundle-store-closed', 'KA-bundle store is closed');
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.#inFlightOperations.add(operation);
    void operation.finally(() => {
      this.#inFlightOperations.delete(operation);
    }).catch(() => undefined);
    return operation;
  }
}

interface PreparedRfc64KaBundleV1 {
  readonly blobDigest: Digest32V1;
  readonly bundleBytes: Uint8Array;
}

function prepareBundle(input: PutRfc64KaBundleInputV1): PreparedRfc64KaBundleV1 {
  const blobDigest = snapshotDigest(input?.blobDigest, 'blobDigest');
  const bundleBytes = snapshotBundleBytes(input?.bundleBytes);
  assertBundleMatchesDigest(bundleBytes, blobDigest, 'ka-bundle-store-verification');
  return Object.freeze({ blobDigest, bundleBytes });
}

function snapshotBundleBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    fail('ka-bundle-store-input', 'bundleBytes must be a Uint8Array');
  }
  if (!(value.buffer instanceof ArrayBuffer)) {
    fail('ka-bundle-store-input', 'bundleBytes must not use shared backing memory');
  }
  if ((value.buffer as ArrayBuffer & { readonly resizable?: boolean }).resizable === true) {
    fail('ka-bundle-store-input', 'bundleBytes must not use resizable backing memory');
  }
  if (value.byteLength < 1 || value.byteLength > RFC64_KA_BUNDLE_STORE_MAX_BYTES_V1) {
    fail(
      'ka-bundle-store-input',
      `bundleBytes must contain 1..${RFC64_KA_BUNDLE_STORE_MAX_BYTES_V1} bytes`,
    );
  }
  return Uint8Array.from(value);
}

function assertBundleMatchesDigest(
  bundleBytes: Uint8Array,
  expectedDigest: Digest32V1,
  errorCode: 'ka-bundle-store-verification' | 'ka-bundle-store-corrupt',
): void {
  try {
    const decoded = decodeOpaqueKaBundleV1(bundleBytes);
    if (decoded.blobDigest !== expectedDigest) {
      throw new Error('opaque KA-bundle digest differs from its immutable key');
    }
  } catch (cause) {
    fail(errorCode, 'opaque KA bundle is not canonical for its blob digest', cause);
  }
}

function bundleRelativePath(blobDigest: Digest32V1): string {
  const hex = blobDigest.slice(2);
  return join(BUNDLES_DIRECTORY, hex.slice(0, 2), `${hex}${BUNDLE_FILE_SUFFIX}`);
}

function snapshotDigest(value: unknown, label: string): Digest32V1 {
  try {
    assertCanonicalDigest(value as string, label);
  } catch (cause) {
    fail('ka-bundle-store-input', `${label} is not a canonical digest`, cause);
  }
  return value as Digest32V1;
}

async function mapDurableFileErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (!(cause instanceof Rfc64DurableFileErrorV1)) throw cause;
    const code: Rfc64KaBundleStoreErrorCodeV1 = cause.code === 'input'
      ? 'ka-bundle-store-input'
      : cause.code === 'unsafe-path'
        ? 'ka-bundle-store-unsafe-path'
        : cause.code === 'corrupt'
          ? 'ka-bundle-store-corrupt'
          : cause.code === 'io'
            ? 'ka-bundle-store-io'
            : 'ka-bundle-store-durability';
    return fail(code, cause.message, cause);
  }
}

/** Open only with package-internal authority backed by the live persistence lease. */
export async function openRfc64KaBundleStoreForOwnedPersistenceRootV1(
  ownership: Rfc64PersistenceRootOwnershipV1,
): Promise<Rfc64KaBundleStoreV1> {
  const rfc64RootPath = ownership.assertHeldAndGetRootPathV1();
  const rootPath = resolveRfc64KaBundleStorePathV1(rfc64RootPath);
  await mapDurableFileErrors(async () => {
    await assertRfc64ExistingDirectoryV1(
      rfc64RootPath,
      'RFC-64 persistence root',
      { access: 'owner-only' },
    );
    await ensureRfc64SecureDirectoryTreeV1(rootPath, rfc64RootPath);
    await ensureRfc64SecureDirectoryTreeV1(join(rootPath, BUNDLES_DIRECTORY), rootPath);
  });
  return new FileRfc64KaBundleStoreV1(
    resolve(rootPath),
    createRfc64DurableFileStoreV1<Rfc64KaBundleStoreFileKindV1>(rootPath),
  );
}

function fail(
  code: Rfc64KaBundleStoreErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64KaBundleStoreErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
