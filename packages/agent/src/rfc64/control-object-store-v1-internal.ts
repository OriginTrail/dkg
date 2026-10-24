import { lstat, opendir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  MAX_CONTROL_OBJECT_BYTES,
  MAX_CONTROL_SIGNATURE_VARIANT_BYTES,
  assertCanonicalDigest,
  computeControlSignatureVariantDigestHex,
  recombineCanonicalSignedControlEnvelopeV1,
  splitCanonicalSignedControlEnvelopeV1,
  type Digest32V1,
  type SignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  readVerifiedControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';
import {
  Rfc64DurableFileErrorV1,
  assertRfc64ExistingDirectoryV1,
  createRfc64DurableFileStoreWithInstrumentationV1,
  ensureRfc64SecureDirectoryTreeWithInstrumentationV1,
  type Rfc64DurableFileBoundaryV1,
  type Rfc64DurableFileInstrumentationV1,
  type Rfc64DurableFileStoreV1,
} from './durable-file-store-v1.js';
import {
  RFC64_POSIX_NAMESPACE_DURABILITY_V1,
  RFC64_SECURE_DIRECTORY_MODE_V1,
  RFC64_SECURE_FILE_MODE_V1,
  RFC64_WINDOWS_NAMESPACE_DURABILITY_V1,
  rfc64NamespaceDurabilityV1,
  type Rfc64NamespaceDurabilityV1,
} from './secure-filesystem-policy-v1.js';
import {
  RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH,
  resolveRfc64ControlObjectStorePathV1,
  resolveRfc64PersistenceRootV1,
} from './persistence-layout-v1.js';
import type { Rfc64PersistenceRootOwnershipV1 } from './persistence-root-ownership-v1-internal.js';

export { RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH };
export const RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE = RFC64_SECURE_DIRECTORY_MODE_V1;
export const RFC64_CONTROL_OBJECT_STORE_FILE_MODE = RFC64_SECURE_FILE_MODE_V1;
export const RFC64_CONTROL_OBJECT_STORE_MAX_STAGE_OBJECTS = 16;
export const RFC64_CONTROL_OBJECT_STORE_MAX_SIGNATURE_VARIANTS_PER_OBJECT = 64;
export const RFC64_CONTROL_OBJECT_STORE_POSIX_NAMESPACE_DURABILITY =
  RFC64_POSIX_NAMESPACE_DURABILITY_V1;
export const RFC64_CONTROL_OBJECT_STORE_WINDOWS_NAMESPACE_DURABILITY =
  RFC64_WINDOWS_NAMESPACE_DURABILITY_V1;

export type Rfc64ControlObjectStoreNamespaceDurabilityV1 = Rfc64NamespaceDurabilityV1;

const OBJECTS_DIRECTORY = 'objects';
const SIGNATURES_DIRECTORY = 'signatures';
const CANONICAL_FILE_SUFFIX = '.jcs';

export const RFC64_CONTROL_OBJECT_STORE_ERROR_CODES_V1 = Object.freeze([
  'control-store-input',
  'control-store-verification',
  'control-store-unsafe-path',
  'control-store-corrupt',
  'control-store-io',
  'control-store-durability',
  'control-store-closed',
] as const);

export type Rfc64ControlObjectStoreErrorCodeV1 =
  (typeof RFC64_CONTROL_OBJECT_STORE_ERROR_CODES_V1)[number];

export class Rfc64ControlObjectStoreErrorV1 extends Error {
  constructor(
    readonly code: Rfc64ControlObjectStoreErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    if (!RFC64_CONTROL_OBJECT_STORE_ERROR_CODES_V1.includes(code)) {
      throw new TypeError(`Unsupported RFC-64 control store error code: ${code}`);
    }
    this.name = 'Rfc64ControlObjectStoreErrorV1';
  }
}

type Rfc64ControlObjectStoreFileKindV1 = 'object' | 'signature';

export type Rfc64ControlObjectStoreDurabilityBoundaryV1 =
  Rfc64DurableFileBoundaryV1<Rfc64ControlObjectStoreFileKindV1>;

export interface Rfc64ControlObjectStoreInstrumentationV1
  extends Rfc64DurableFileInstrumentationV1<Rfc64ControlObjectStoreFileKindV1> {}

export interface StageVerifiedControlObjectV1 {
  readonly envelope: SignedControlEnvelopeV1;
  readonly issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
}

export interface StagedVerifiedControlObjectV1 {
  readonly objectDigest: Digest32V1;
  readonly signatureVariantDigest: Digest32V1;
}

export interface StageVerifiedControlObjectsResultV1 {
  /** Every named file and platform-supported containing-directory barrier has completed. */
  readonly durable: true;
  /** Explicitly fences later semantic ref publication from weaker namespace barriers. */
  readonly namespaceDurability: Rfc64ControlObjectStoreNamespaceDurabilityV1;
  readonly objects: readonly StagedVerifiedControlObjectV1[];
}

export interface GetVerifiedControlObjectInputV1 {
  readonly objectDigest: Digest32V1;
  readonly signatureVariantDigest: Digest32V1;
  /** Re-establishes current generic envelope cryptography after reading cache bytes. */
  readonly verifyIssuerSignature: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
}

export interface GetVerifiedControlObjectByDigestInputV1 {
  readonly objectDigest: Digest32V1;
  /** Re-establishes current generic envelope cryptography before any cache hit is returned. */
  readonly verifyIssuerSignature: (
    envelope: SignedControlEnvelopeV1,
  ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>;
}

export interface StoredVerifiedControlObjectV1 {
  readonly envelope: SignedControlEnvelopeV1;
  readonly issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
}

export type Rfc64ControlObjectOperationsV1 = Pick<
  Rfc64ControlObjectStoreV1,
  | 'namespaceDurability'
  | 'stageVerifiedObjects'
  | 'getVerifiedObject'
  | 'getVerifiedObjectByDigest'
>;

export interface Rfc64ControlObjectStoreV1 {
  readonly rootPath: string;
  readonly closed: boolean;
  readonly namespaceDurability: Rfc64ControlObjectStoreNamespaceDurabilityV1;
  /**
   * Durably stage immutable unsigned envelopes and detached signature variants.
   * Success does not advance a semantic ref or make any catalog authoritative.
   */
  stageVerifiedObjects(
    input: readonly StageVerifiedControlObjectV1[],
  ): Promise<StageVerifiedControlObjectsResultV1>;
  /** Read exact cache keys and reverify the reconstructed signed envelope. */
  getVerifiedObject(
    input: GetVerifiedControlObjectInputV1,
  ): Promise<StoredVerifiedControlObjectV1 | null>;
  /**
   * Resolve one deterministic stored signature variant by object digest, then
   * reconstruct and reverify the exact envelope before returning it.
   */
  getVerifiedObjectByDigest(
    input: GetVerifiedControlObjectByDigestInputV1,
  ): Promise<StoredVerifiedControlObjectV1 | null>;
  /** Reject new operations, then settle every admitted read/write. */
  close(): Promise<void>;
}

/** Open only with package-internal authority backed by the live persistence lease. */
export async function openRfc64ControlObjectStoreForOwnedPersistenceRootV1(
  ownership: Rfc64PersistenceRootOwnershipV1,
): Promise<Rfc64ControlObjectStoreV1> {
  const rfc64RootPath = ownership.assertHeldAndGetRootPathV1();
  return openRfc64ControlObjectStoreAtRootV1(
    rfc64RootPath,
    NOOP_RFC64_CONTROL_OBJECT_STORE_INSTRUMENTATION_V1,
  );
}

const NOOP_RFC64_CONTROL_OBJECT_STORE_INSTRUMENTATION_V1 = Object.freeze({
  boundary: (): void => {},
}) satisfies Rfc64ControlObjectStoreInstrumentationV1;

interface PreparedStoredControlObjectV1 {
  readonly objectDigest: Digest32V1;
  readonly signatureVariantDigest: Digest32V1;
  readonly unsignedBytes: Uint8Array;
  readonly signatureVariantBytes: Uint8Array;
}

interface PreparedControlObjectFileV1 {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly kind: Rfc64ControlObjectStoreFileKindV1;
}

interface PreparedControlObjectGroupV1 {
  readonly objectDigest: Digest32V1;
  readonly object: PreparedControlObjectFileV1;
  readonly signatureVariantDigests: readonly Digest32V1[];
  readonly signatures: readonly PreparedControlObjectFileV1[];
}

class FileRfc64ControlObjectStoreV1 implements Rfc64ControlObjectStoreV1 {
  #closed = false;
  #closePromise: Promise<void> | null = null;
  readonly #inFlightOperations = new Set<Promise<unknown>>();
  readonly #objectOperationTails = new Map<Digest32V1, Promise<void>>();
  readonly #reservedSignatureVariants = new Map<
    Digest32V1,
    Map<Digest32V1, number>
  >();
  readonly #durableFiles: Rfc64DurableFileStoreV1<Rfc64ControlObjectStoreFileKindV1>;
  readonly namespaceDurability = rfc64NamespaceDurabilityV1();

  constructor(
    readonly rootPath: string,
    durableFiles: Rfc64DurableFileStoreV1<Rfc64ControlObjectStoreFileKindV1>,
  ) {
    this.#durableFiles = durableFiles;
  }

  get closed(): boolean {
    return this.#closed;
  }

  stageVerifiedObjects(
    input: readonly StageVerifiedControlObjectV1[],
  ): Promise<StageVerifiedControlObjectsResultV1> {
    this.requireOpen();
    const prepared = prepareStageBatch(input);
    const groups = this.planStageGroups(prepared);
    const operation = (async () => {
      await settleAllOrThrowV1(groups.map(async (group) => {
        const releaseAdmission = await this.reserveSignatureVariants(group);
        try {
          await this.putExactFile(
            group.object.relativePath,
            group.object.bytes,
            group.object.kind,
          );
          await settleAllOrThrowV1(group.signatures.map(async (signature) => {
            await this.putExactFile(signature.relativePath, signature.bytes, signature.kind);
          }), 'RFC-64 control-object signature staging failed');
        } finally {
          await releaseAdmission();
        }
      }), 'RFC-64 control-object batch staging failed');
      const result = prepared.map((item) =>
        Object.freeze({
          objectDigest: item.objectDigest,
          signatureVariantDigest: item.signatureVariantDigest,
        }));
      return Object.freeze({
        durable: true as const,
        namespaceDurability: this.namespaceDurability,
        objects: Object.freeze(result),
      });
    })();
    return this.trackOperation(operation);
  }

  getVerifiedObject(
    input: GetVerifiedControlObjectInputV1,
  ): Promise<StoredVerifiedControlObjectV1 | null> {
    this.requireOpen();
    const objectDigest = snapshotDigest(input.objectDigest, 'objectDigest');
    const signatureVariantDigest = snapshotDigest(
      input.signatureVariantDigest,
      'signatureVariantDigest',
    );
    const verifyIssuerSignature = input.verifyIssuerSignature;
    if (typeof verifyIssuerSignature !== 'function') {
      fail('control-store-input', 'verifyIssuerSignature must be a function');
    }
    return this.trackOperation(this.readVerifiedObject(
      objectDigest,
      signatureVariantDigest,
      verifyIssuerSignature,
    ));
  }

  getVerifiedObjectByDigest(
    input: GetVerifiedControlObjectByDigestInputV1,
  ): Promise<StoredVerifiedControlObjectV1 | null> {
    this.requireOpen();
    const objectDigest = snapshotDigest(input.objectDigest, 'objectDigest');
    const verifyIssuerSignature = input.verifyIssuerSignature;
    if (typeof verifyIssuerSignature !== 'function') {
      fail('control-store-input', 'verifyIssuerSignature must be a function');
    }
    const operation = (async () => {
      const signatureVariantDigests = await this.listSignatureVariantDigests(objectDigest);
      if (signatureVariantDigests.length === 0) return null;
      const loaded = await this.readVerifiedObject(
        objectDigest,
        signatureVariantDigests[0],
        verifyIssuerSignature,
      );
      if (loaded === null) {
        fail(
          'control-store-corrupt',
          'selected control signature variant disappeared during exact lookup',
        );
      }
      return loaded;
    })();
    return this.trackOperation(operation);
  }

  private async readVerifiedObject(
    objectDigest: Digest32V1,
    signatureVariantDigest: Digest32V1,
    verifyIssuerSignature: (
      envelope: SignedControlEnvelopeV1,
    ) => Promise<VerifiedControlEnvelopeIssuerSignatureV1>,
  ): Promise<StoredVerifiedControlObjectV1 | null> {
      const objectPath = this.objectRelativePath(objectDigest);
      const signaturePath = this.signatureRelativePath(
        objectDigest,
        signatureVariantDigest,
      );
      const [unsignedBytes, variantBytes] = await settleAllOrThrowV1([
        mapDurableFileErrors(async () =>
          this.#durableFiles.readOptionalBoundedBytes({
            relativePath: objectPath,
            maxBytes: MAX_CONTROL_OBJECT_BYTES,
            label: 'control object',
          })),
        mapDurableFileErrors(async () =>
          this.#durableFiles.readOptionalBoundedBytes({
            relativePath: signaturePath,
            maxBytes: MAX_CONTROL_SIGNATURE_VARIANT_BYTES,
            label: 'control signature variant',
          })),
      ], 'RFC-64 control-object cache reads failed');
      if (unsignedBytes === null || variantBytes === null) return null;

      let envelope: SignedControlEnvelopeV1;
      try {
        envelope = deepFreezePlain(recombineCanonicalSignedControlEnvelopeV1(
          unsignedBytes,
          variantBytes,
          objectDigest,
          signatureVariantDigest,
        ));
      } catch (cause) {
        fail('control-store-corrupt', 'stored control object is not canonical for its exact keys', cause);
      }

      // The caller callback runs after both bounded file snapshots and outside
      // durable-file publication, so it may compose another exact cache read.
      let issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
      try {
        issuerSignature = await verifyIssuerSignature(envelope);
        assertProofMatchesEnvelope(envelope, issuerSignature);
      } catch (cause) {
        if (cause instanceof Rfc64ControlObjectStoreErrorV1) throw cause;
        fail('control-store-verification', 'stored control object signature verification failed', cause);
      }
      return Object.freeze({ envelope, issuerSignature });
  }

  private async listSignatureVariantDigests(
    objectDigest: Digest32V1,
  ): Promise<readonly Digest32V1[]> {
    const objectHex = objectDigest.slice(2);
    const signaturesPath = join(this.rootPath, SIGNATURES_DIRECTORY);
    const shardPath = join(signaturesPath, objectHex.slice(0, 2));
    const directoryPath = join(shardPath, objectHex);
    await this.requireSecureSignatureDirectory(
      this.rootPath,
      'control-object store root',
      false,
    );
    await this.requireSecureSignatureDirectory(
      signaturesPath,
      'control signature store directory',
      false,
    );
    if (!await this.requireSecureSignatureDirectory(
      shardPath,
      'control signature shard directory',
      true,
    )) {
      await this.requireSecureSignatureDirectory(
        this.rootPath,
        'control-object store root',
        false,
      );
      await this.requireSecureSignatureDirectory(
        signaturesPath,
        'control signature store directory',
        false,
      );
      return Object.freeze([]);
    }
    if (!await this.requireSecureSignatureDirectory(
      directoryPath,
      'control signature variant directory',
      true,
    )) {
      await this.requireSecureSignatureDirectory(
        this.rootPath,
        'control-object store root',
        false,
      );
      await this.requireSecureSignatureDirectory(
        signaturesPath,
        'control signature store directory',
        false,
      );
      await this.requireSecureSignatureDirectory(
        shardPath,
        'control signature shard directory',
        false,
      );
      return Object.freeze([]);
    }

    let directory: Awaited<ReturnType<typeof opendir>>;
    try {
      directory = await opendir(directoryPath);
    } catch (cause) {
      fail('control-store-io', 'failed to enumerate control signature variants', cause);
    }
    const variants: Digest32V1[] = [];
    let entryCount = 0;
    try {
      for await (const entry of directory) {
        entryCount += 1;
        if (entryCount > RFC64_CONTROL_OBJECT_STORE_MAX_SIGNATURE_VARIANTS_PER_OBJECT * 4) {
          fail(
            'control-store-corrupt',
            'control signature variant directory exceeds its entry ceiling',
          );
        }
        if (!entry.isFile()) {
          fail(
            entry.isSymbolicLink() ? 'control-store-unsafe-path' : 'control-store-corrupt',
            'control signature variant entry is not a regular file',
          );
        }
        if (/^\.[0-9a-f]{64}\.jcs\.[0-9a-f]{32}\.tmp$/.test(entry.name)) continue;
        const match = /^([0-9a-f]{64})\.jcs$/.exec(entry.name);
        if (match === null) {
          fail(
            'control-store-corrupt',
            'control signature variant directory contains an unknown entry',
          );
        }
        variants.push(`0x${match[1]}` as Digest32V1);
      }
    } catch (cause) {
      if (cause instanceof Rfc64ControlObjectStoreErrorV1) throw cause;
      fail('control-store-io', 'failed to iterate control signature variants', cause);
    }
    // Detect path replacement while the bounded directory handle was consumed.
    await this.requireSecureSignatureDirectory(this.rootPath, 'control-object store root', false);
    await this.requireSecureSignatureDirectory(
      signaturesPath,
      'control signature store directory',
      false,
    );
    await this.requireSecureSignatureDirectory(
      shardPath,
      'control signature shard directory',
      false,
    );
    await this.requireSecureSignatureDirectory(
      directoryPath,
      'control signature variant directory',
      false,
    );
    if (variants.length > RFC64_CONTROL_OBJECT_STORE_MAX_SIGNATURE_VARIANTS_PER_OBJECT) {
      fail('control-store-corrupt', 'control object exceeds its signature-variant ceiling');
    }
    variants.sort();
    return Object.freeze(variants);
  }

  private async requireSecureSignatureDirectory(
    path: string,
    label: string,
    optional: boolean,
  ): Promise<boolean> {
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(path);
    } catch (cause) {
      if (optional && isNodeError(cause, 'ENOENT')) return false;
      fail('control-store-io', `failed to inspect ${label}`, cause);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      fail('control-store-unsafe-path', `${label} must be a non-symlink directory`);
    }
    await mapDurableFileErrors(async () => {
      await assertRfc64ExistingDirectoryV1(path, label, { access: 'owner-only' });
    });
    return true;
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

  private planStageGroups(
    prepared: readonly PreparedStoredControlObjectV1[],
  ): readonly PreparedControlObjectGroupV1[] {
    const groups = new Map<string, {
      readonly objectDigest: Digest32V1;
      readonly object: PreparedControlObjectFileV1;
      readonly signatureVariantDigests: Set<Digest32V1>;
      readonly signatures: Map<string, PreparedControlObjectFileV1>;
    }>();
    const addUnique = (
      files: Map<string, PreparedControlObjectFileV1>,
      relativePath: string,
      bytes: Uint8Array,
      kind: Rfc64ControlObjectStoreFileKindV1,
    ): PreparedControlObjectFileV1 => {
      const existing = files.get(relativePath);
      if (existing !== undefined) {
        if (!byteArraysEqual(existing.bytes, bytes) || existing.kind !== kind) {
          fail(
            'control-store-verification',
            'one immutable control-object key resolved to conflicting prepared bytes',
          );
        }
        return existing;
      }
      const file = Object.freeze({ relativePath, bytes, kind });
      files.set(relativePath, file);
      return file;
    };
    const objects = new Map<string, PreparedControlObjectFileV1>();
    for (const item of prepared) {
      const objectPath = this.objectRelativePath(item.objectDigest);
      let group = groups.get(objectPath);
      if (group === undefined) {
        group = {
          objectDigest: item.objectDigest,
          object: addUnique(objects, objectPath, item.unsignedBytes, 'object'),
          signatureVariantDigests: new Set(),
          signatures: new Map(),
        };
        groups.set(objectPath, group);
      } else if (!byteArraysEqual(group.object.bytes, item.unsignedBytes)) {
        fail(
          'control-store-verification',
          'one immutable control-object key resolved to conflicting prepared bytes',
        );
      }
      group.signatureVariantDigests.add(item.signatureVariantDigest);
      addUnique(
        group.signatures,
        this.signatureRelativePath(item.objectDigest, item.signatureVariantDigest),
        item.signatureVariantBytes,
        'signature',
      );
    }
    return Object.freeze([...groups.values()].map((group) => Object.freeze({
      objectDigest: group.objectDigest,
      object: group.object,
      signatureVariantDigests: Object.freeze([...group.signatureVariantDigests]),
      signatures: Object.freeze([...group.signatures.values()]),
    })));
  }

  private objectRelativePath(objectDigest: Digest32V1): string {
    const hex = objectDigest.slice(2);
    return join(
      OBJECTS_DIRECTORY,
      hex.slice(0, 2),
      `${hex}${CANONICAL_FILE_SUFFIX}`,
    );
  }

  private signatureRelativePath(
    objectDigest: Digest32V1,
    signatureVariantDigest: Digest32V1,
  ): string {
    const objectHex = objectDigest.slice(2);
    const variantHex = signatureVariantDigest.slice(2);
    return join(
      SIGNATURES_DIRECTORY,
      objectHex.slice(0, 2),
      objectHex,
      `${variantHex}${CANONICAL_FILE_SUFFIX}`,
    );
  }

  private async putExactFile(
    relativePath: string,
    bytes: Uint8Array,
    kind: Rfc64ControlObjectStoreFileKindV1,
  ): Promise<void> {
    await mapDurableFileErrors(async () => {
      await this.#durableFiles.putExactBytes({
        relativePath,
        bytes,
        maxBytes: kind === 'object'
          ? MAX_CONTROL_OBJECT_BYTES
          : MAX_CONTROL_SIGNATURE_VARIANT_BYTES,
        label: kind === 'object' ? 'control object' : 'control signature variant',
        kind,
      });
    });
  }

  private requireOpen(): void {
    if (this.#closed) fail('control-store-closed', 'control object store is closed');
  }

  private reserveSignatureVariants(
    group: PreparedControlObjectGroupV1,
  ): Promise<() => Promise<void>> {
    return this.withObjectCoordination(group.objectDigest, async () => {
      const storedVariants = await this.listSignatureVariantDigests(group.objectDigest);
      let reservations = this.#reservedSignatureVariants.get(group.objectDigest);
      if (reservations === undefined) reservations = new Map();
      const admittedVariants = new Set<Digest32V1>([
        ...storedVariants,
        ...reservations.keys(),
        ...group.signatureVariantDigests,
      ]);
      if (admittedVariants.size
        > RFC64_CONTROL_OBJECT_STORE_MAX_SIGNATURE_VARIANTS_PER_OBJECT) {
        fail(
          'control-store-input',
          'control object would exceed its signature-variant ceiling',
        );
      }
      for (const digest of group.signatureVariantDigests) {
        reservations.set(digest, (reservations.get(digest) ?? 0) + 1);
      }
      this.#reservedSignatureVariants.set(group.objectDigest, reservations);

      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await this.withObjectCoordination(group.objectDigest, async () => {
          const current = this.#reservedSignatureVariants.get(group.objectDigest);
          if (current === undefined) {
            fail('control-store-corrupt', 'signature-variant admission reservation was lost');
          }
          for (const digest of group.signatureVariantDigests) {
            const count = current.get(digest);
            if (count === undefined || count < 1) {
              fail('control-store-corrupt', 'signature-variant admission count was lost');
            }
            if (count === 1) current.delete(digest);
            else current.set(digest, count - 1);
          }
          if (current.size === 0) this.#reservedSignatureVariants.delete(group.objectDigest);
        });
      };
    });
  }

  private async withObjectCoordination<T>(
    objectDigest: Digest32V1,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#objectOperationTails.get(objectDigest) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.#objectOperationTails.set(objectDigest, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#objectOperationTails.get(objectDigest) === tail) {
        this.#objectOperationTails.delete(objectDigest);
      }
    }
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.#inFlightOperations.add(operation);
    void operation.finally(() => {
      this.#inFlightOperations.delete(operation);
    }).catch(() => undefined);
    return operation;
  }
}

function byteArraysEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function isNodeError(cause: unknown, code: string): boolean {
  return cause instanceof Error
    && 'code' in cause
    && (cause as NodeJS.ErrnoException).code === code;
}

async function settleAllOrThrowV1<T>(
  operations: readonly Promise<T>[],
  aggregateMessage: string,
): Promise<T[]> {
  const outcomes = await Promise.allSettled(operations);
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : []);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, aggregateMessage);
  return outcomes.map((outcome) => {
    if (outcome.status === 'rejected') {
      throw new TypeError('settled RFC-64 operation lost its recorded failure');
    }
    return outcome.value;
  });
}

/** @internal Package-local lifecycle/instrumentation composition seam. */
export async function openRfc64ControlObjectStoreWithInstrumentationV1(
  dataDirInput: string,
  instrumentation: Rfc64ControlObjectStoreInstrumentationV1,
): Promise<Rfc64ControlObjectStoreV1> {
  if (!Object.isFrozen(instrumentation)) {
    fail('control-store-input', 'control object store instrumentation must be immutable');
  }
  if (typeof dataDirInput !== 'string' || dataDirInput.length === 0) {
    fail('control-store-input', 'dataDir must be a non-empty path');
  }
  const dataDir = resolve(dataDirInput);
  const rfc64RootPath = resolveRfc64PersistenceRootV1(dataDir);
  await mapDurableFileErrors(async () => {
    await assertRfc64ExistingDirectoryV1(
      dataDir,
      'DKG data directory',
      { access: 'owner' },
    );
    await ensureRfc64SecureDirectoryTreeWithInstrumentationV1(
      rfc64RootPath,
      dataDir,
      instrumentation,
    );
  });
  return openRfc64ControlObjectStoreAtRootV1(rfc64RootPath, instrumentation);
}

async function openRfc64ControlObjectStoreAtRootV1(
  rfc64RootPathInput: string,
  instrumentation: Rfc64ControlObjectStoreInstrumentationV1,
): Promise<Rfc64ControlObjectStoreV1> {
  if (!Object.isFrozen(instrumentation)) {
    fail('control-store-input', 'control object store instrumentation must be immutable');
  }
  const rfc64RootPath = resolve(rfc64RootPathInput);
  const rootPath = resolveRfc64ControlObjectStorePathV1(rfc64RootPath);
  await mapDurableFileErrors(async () => {
    await assertRfc64ExistingDirectoryV1(
      rfc64RootPath,
      'RFC-64 persistence root',
      { access: 'owner-only' },
    );
    const ensureTree = (target: string, root: string) =>
      ensureRfc64SecureDirectoryTreeWithInstrumentationV1(
        target,
        root,
        instrumentation,
      );
    await ensureTree(rootPath, rfc64RootPath);
    await ensureTree(join(rootPath, OBJECTS_DIRECTORY), rootPath);
    await ensureTree(join(rootPath, SIGNATURES_DIRECTORY), rootPath);
  });
  const durableFiles = createRfc64DurableFileStoreWithInstrumentationV1<
    Rfc64ControlObjectStoreFileKindV1
  >(rootPath, instrumentation);
  return new FileRfc64ControlObjectStoreV1(rootPath, durableFiles);
}

function prepareStageBatch(
  input: readonly StageVerifiedControlObjectV1[],
): readonly PreparedStoredControlObjectV1[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    fail('control-store-input', 'stage input must be an ordinary dense Array');
  }
  const length = input.length;
  if (
    !Number.isSafeInteger(length)
    || length < 1
    || length > RFC64_CONTROL_OBJECT_STORE_MAX_STAGE_OBJECTS
  ) {
    fail(
      'control-store-input',
      `stage input must contain 1..${RFC64_CONTROL_OBJECT_STORE_MAX_STAGE_OBJECTS} objects`,
    );
  }
  const result = new Array<PreparedStoredControlObjectV1>(length);
  for (let index = 0; index < length; index += 1) {
    if (!(index in input)) fail('control-store-input', 'stage input must not contain holes');
    const item = input[index];
    try {
      const split = splitCanonicalSignedControlEnvelopeV1(item.envelope);
      const envelope = deepFreezePlain(split.envelope);
      assertProofMatchesEnvelope(envelope, item.issuerSignature);
      const objectDigest = snapshotDigest(envelope.objectDigest, 'objectDigest');
      const signatureVariantDigest = snapshotDigest(
        split.signatureVariant.signatureVariantDigest,
        'signatureVariantDigest',
      );
      result[index] = Object.freeze({
        objectDigest,
        signatureVariantDigest,
        unsignedBytes: split.unsignedEnvelopeBytes,
        signatureVariantBytes: split.signatureVariantBytes,
      });
    } catch (cause) {
      if (cause instanceof Rfc64ControlObjectStoreErrorV1) throw cause;
      fail('control-store-input', `stage input ${index} is not one verified canonical snapshot`, cause);
    }
  }
  return Object.freeze(result);
}

function assertProofMatchesEnvelope(
  envelope: SignedControlEnvelopeV1,
  proof: VerifiedControlEnvelopeIssuerSignatureV1,
): void {
  let snapshot;
  try {
    snapshot = readVerifiedControlEnvelopeIssuerSignatureV1(proof);
  } catch (cause) {
    fail('control-store-verification', 'issuer signature proof was not minted by the verifier', cause);
  }
  const expectedVariant = computeControlSignatureVariantDigestHex(
    envelope.objectDigest,
    envelope.signature,
  );
  if (
    snapshot.objectDigest !== envelope.objectDigest
    || snapshot.signatureVariantDigest !== expectedVariant
    || snapshot.issuer !== envelope.issuer
    || snapshot.signatureSuite !== envelope.signatureSuite
  ) {
    fail('control-store-verification', 'issuer signature proof is not bound to this envelope');
  }
}

async function mapDurableFileErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (!(cause instanceof Rfc64DurableFileErrorV1)) throw cause;
    const code: Rfc64ControlObjectStoreErrorCodeV1 = cause.code === 'input'
      ? 'control-store-input'
      : cause.code === 'unsafe-path'
        ? 'control-store-unsafe-path'
        : cause.code === 'corrupt'
          ? 'control-store-corrupt'
          : cause.code === 'io'
            ? 'control-store-io'
            : 'control-store-durability';
    return fail(code, cause.message, cause);
  }
}

function snapshotDigest(value: string, label: string): Digest32V1 {
  try {
    assertCanonicalDigest(value, label);
  } catch (cause) {
    fail('control-store-input', `${label} is not a canonical digest`, cause);
  }
  return value as Digest32V1;
}

function deepFreezePlain<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreezePlain(item);
    return Object.freeze(value);
  }
  for (const key of Object.keys(value)) {
    deepFreezePlain((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

function fail(
  code: Rfc64ControlObjectStoreErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64ControlObjectStoreErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
