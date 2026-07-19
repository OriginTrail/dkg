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
  createRfc64DurableFileStoreV1,
  ensureRfc64SecureDirectoryTreeV1,
  type Rfc64DurableFileBoundaryV1,
  type Rfc64DurableFileLifecycleV1,
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
import type {
  Rfc64InventoryOwnedRootCapabilityV1,
} from './inventory-v1/open.js';

export { RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH };
export const RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE = RFC64_SECURE_DIRECTORY_MODE_V1;
export const RFC64_CONTROL_OBJECT_STORE_FILE_MODE = RFC64_SECURE_FILE_MODE_V1;
export const RFC64_CONTROL_OBJECT_STORE_MAX_STAGE_OBJECTS = 16;
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

interface Rfc64ControlObjectStoreLifecycleV1
  extends Rfc64DurableFileLifecycleV1<Rfc64ControlObjectStoreFileKindV1> {}

const PRODUCTION_LIFECYCLE = Object.freeze({
  boundary: (_boundary: Rfc64ControlObjectStoreDurabilityBoundaryV1): void => {},
}) satisfies Rfc64ControlObjectStoreLifecycleV1;

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

export interface StoredVerifiedControlObjectV1 {
  readonly envelope: SignedControlEnvelopeV1;
  readonly issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
}

export type Rfc64ControlObjectOperationsV1 = Pick<
  Rfc64ControlObjectStoreV1,
  'namespaceDurability' | 'stageVerifiedObjects' | 'getVerifiedObject'
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
  /** Reject new operations, then settle every admitted read/write. */
  close(): Promise<void>;
}

/** Open only with lifecycle authority minted by the leased inventory owner. */
export async function openRfc64ControlObjectStoreForOwnedInventoryV1(
  ownership: Rfc64InventoryOwnedRootCapabilityV1,
): Promise<Rfc64ControlObjectStoreV1> {
  const rfc64RootPath = ownership.assertOwnedAndGetRootPathV1();
  return openRfc64ControlObjectStoreAtRootV1(rfc64RootPath, PRODUCTION_LIFECYCLE);
}

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
  readonly object: PreparedControlObjectFileV1;
  readonly signatures: readonly PreparedControlObjectFileV1[];
}

class FileRfc64ControlObjectStoreV1 implements Rfc64ControlObjectStoreV1 {
  #closed = false;
  #closePromise: Promise<void> | null = null;
  readonly #inFlightOperations = new Set<Promise<unknown>>();
  readonly #durableFiles: Rfc64DurableFileStoreV1<Rfc64ControlObjectStoreFileKindV1>;
  readonly namespaceDurability = rfc64NamespaceDurabilityV1();

  constructor(
    readonly rootPath: string,
    lifecycle: Rfc64ControlObjectStoreLifecycleV1,
  ) {
    this.#durableFiles = createRfc64DurableFileStoreV1(rootPath, lifecycle);
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
        await this.putExactFile(
          group.object.relativePath,
          group.object.bytes,
          group.object.kind,
        );
        await settleAllOrThrowV1(group.signatures.map(async (signature) => {
          await this.putExactFile(signature.relativePath, signature.bytes, signature.kind);
        }), 'RFC-64 control-object signature staging failed');
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
    const operation = (async () => {
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

  private planStageGroups(
    prepared: readonly PreparedStoredControlObjectV1[],
  ): readonly PreparedControlObjectGroupV1[] {
    const groups = new Map<string, {
      readonly object: PreparedControlObjectFileV1;
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
          object: addUnique(objects, objectPath, item.unsignedBytes, 'object'),
          signatures: new Map(),
        };
        groups.set(objectPath, group);
      } else if (!byteArraysEqual(group.object.bytes, item.unsignedBytes)) {
        fail(
          'control-store-verification',
          'one immutable control-object key resolved to conflicting prepared bytes',
        );
      }
      addUnique(
        group.signatures,
        this.signatureRelativePath(item.objectDigest, item.signatureVariantDigest),
        item.signatureVariantBytes,
        'signature',
      );
    }
    return Object.freeze([...groups.values()].map((group) => Object.freeze({
      object: group.object,
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

/** @internal Used only by the package-local test support module. */
export async function openRfc64ControlObjectStoreForTestV1(
  dataDirInput: string,
  lifecycle: Rfc64ControlObjectStoreLifecycleV1,
): Promise<Rfc64ControlObjectStoreV1> {
  assertRfc64ControlObjectStoreTestEnvironmentV1();
  if (!Object.isFrozen(lifecycle)) {
    fail('control-store-input', 'control object store lifecycle adapter must be immutable');
  }
  if (typeof dataDirInput !== 'string' || dataDirInput.length === 0) {
    fail('control-store-input', 'dataDir must be a non-empty path');
  }
  const guardedLifecycle = Object.freeze({
    boundary: async (
      boundary: Rfc64ControlObjectStoreDurabilityBoundaryV1,
    ): Promise<void> => {
      assertRfc64ControlObjectStoreTestEnvironmentV1();
      await lifecycle.boundary(boundary);
    },
  });
  const dataDir = resolve(dataDirInput);
  const rfc64RootPath = resolveRfc64PersistenceRootV1(dataDir);
  await mapDurableFileErrors(async () => {
    await assertRfc64ExistingDirectoryV1(
      dataDir,
      'DKG data directory',
      { access: 'owner' },
    );
    await ensureRfc64SecureDirectoryTreeV1(rfc64RootPath, dataDir, guardedLifecycle);
  });
  return openRfc64ControlObjectStoreAtRootV1(rfc64RootPath, guardedLifecycle);
}

function assertRfc64ControlObjectStoreTestEnvironmentV1(): void {
  if (process.env.NODE_ENV !== 'test') {
    fail(
      'control-store-input',
      'control store test opener is available only under NODE_ENV=test',
    );
  }
}

async function openRfc64ControlObjectStoreAtRootV1(
  rfc64RootPathInput: string,
  lifecycle: Rfc64ControlObjectStoreLifecycleV1,
): Promise<Rfc64ControlObjectStoreV1> {
  if (!Object.isFrozen(lifecycle)) {
    fail('control-store-input', 'control object store lifecycle adapter must be immutable');
  }
  const rfc64RootPath = resolve(rfc64RootPathInput);
  const rootPath = resolveRfc64ControlObjectStorePathV1(rfc64RootPath);
  await mapDurableFileErrors(async () => {
    await assertRfc64ExistingDirectoryV1(
      rfc64RootPath,
      'RFC-64 persistence root',
      { access: 'owner-only' },
    );
    await ensureRfc64SecureDirectoryTreeV1(rootPath, rfc64RootPath, lifecycle);
    await ensureRfc64SecureDirectoryTreeV1(
      join(rootPath, OBJECTS_DIRECTORY),
      rootPath,
      lifecycle,
    );
    await ensureRfc64SecureDirectoryTreeV1(
      join(rootPath, SIGNATURES_DIRECTORY),
      rootPath,
      lifecycle,
    );
  });
  return new FileRfc64ControlObjectStoreV1(rootPath, lifecycle);
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
