import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import {
  MAX_CONTROL_OBJECT_BYTES,
  MAX_CONTROL_SIGNATURE_VARIANT_BYTES,
  assertCanonicalDigest,
  canonicalizeControlSignatureVariantBytes,
  canonicalizeSignedControlEnvelopeBytes,
  canonicalizeUnsignedControlEnvelopeBytes,
  computeControlSignatureVariantDigestHex,
  parseCanonicalControlSignatureVariant,
  parseCanonicalSignedControlEnvelope,
  parseCanonicalUnsignedControlEnvelope,
  type ControlObjectSignatureVariantV1,
  type Digest32V1,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  readVerifiedControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';

export const RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH =
  'rfc64-sync/control-objects-v1' as const;
export const RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE = 0o700;
export const RFC64_CONTROL_OBJECT_STORE_FILE_MODE = 0o600;
export const RFC64_CONTROL_OBJECT_STORE_MAX_STAGE_OBJECTS = 16;
export const RFC64_CONTROL_OBJECT_STORE_POSIX_NAMESPACE_DURABILITY =
  'posix-atomic-rename-directory-fsync-v1' as const;
export const RFC64_CONTROL_OBJECT_STORE_WINDOWS_NAMESPACE_DURABILITY =
  'windows-file-flush-atomic-rename-v1' as const;

export type Rfc64ControlObjectStoreNamespaceDurabilityV1 =
  | typeof RFC64_CONTROL_OBJECT_STORE_POSIX_NAMESPACE_DURABILITY
  | typeof RFC64_CONTROL_OBJECT_STORE_WINDOWS_NAMESPACE_DURABILITY;

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

export type Rfc64ControlObjectStoreDurabilityBoundaryV1 =
  | 'directory.created'
  | 'directory.mode-secured'
  | 'directory.self-fsynced'
  | 'directory.parent-fsynced'
  | 'object.temp-written'
  | 'object.temp-mode-secured'
  | 'object.temp-fsynced'
  | 'object.renamed'
  | 'object.parent-fsynced'
  | 'object.existing-fsynced'
  | 'object.existing-parent-fsynced'
  | 'signature.temp-written'
  | 'signature.temp-mode-secured'
  | 'signature.temp-fsynced'
  | 'signature.renamed'
  | 'signature.parent-fsynced'
  | 'signature.existing-fsynced'
  | 'signature.existing-parent-fsynced';

interface Rfc64ControlObjectStoreIoV1 {
  readonly boundary: (boundary: Rfc64ControlObjectStoreDurabilityBoundaryV1) => void;
  readonly randomSuffix: () => string;
}

const PRODUCTION_IO = Object.freeze({
  boundary: (_boundary: Rfc64ControlObjectStoreDurabilityBoundaryV1): void => {},
  randomSuffix: (): string => randomBytes(16).toString('hex'),
}) satisfies Rfc64ControlObjectStoreIoV1;

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
  close(): void;
}

export interface Rfc64ControlObjectStoreTestIoV1 {
  readonly boundary?: (boundary: Rfc64ControlObjectStoreDurabilityBoundaryV1) => void;
  readonly randomSuffix?: () => string;
}

export type Rfc64ControlObjectStoreTestOpenerV1 = (
  dataDir: string,
) => Promise<Rfc64ControlObjectStoreV1>;

/**
 * Open after the RFC-64 inventory foundation has secured rfc64-sync and owns
 * its single-process lease. This cache deliberately does not mint that lease.
 */
export async function openRfc64ControlObjectStoreV1(
  dataDir: string,
): Promise<Rfc64ControlObjectStoreV1> {
  return openRfc64ControlObjectStoreWithIoV1(dataDir, PRODUCTION_IO);
}

/** Test-only fault-boundary opener; shipped production code cannot install hooks. */
export function createRfc64ControlObjectStoreTestOpenerV1(
  testIo: Rfc64ControlObjectStoreTestIoV1 = {},
): Rfc64ControlObjectStoreTestOpenerV1 {
  if (process.env.NODE_ENV !== 'test') {
    fail('control-store-input', 'control store test opener is available only under NODE_ENV=test');
  }
  const boundary = testIo.boundary;
  const randomSuffix = testIo.randomSuffix;
  const io = Object.freeze({
    boundary: (value: Rfc64ControlObjectStoreDurabilityBoundaryV1): void => {
      boundary?.(value);
    },
    randomSuffix: (): string => randomSuffix?.() ?? randomBytes(16).toString('hex'),
  }) satisfies Rfc64ControlObjectStoreIoV1;
  return async (dataDir: string): Promise<Rfc64ControlObjectStoreV1> =>
    openRfc64ControlObjectStoreWithIoV1(dataDir, io);
}

interface PreparedStoredControlObjectV1 {
  readonly envelope: SignedControlEnvelopeV1;
  readonly objectDigest: Digest32V1;
  readonly signatureVariantDigest: Digest32V1;
  readonly unsignedBytes: Uint8Array;
  readonly signatureVariantBytes: Uint8Array;
}

class FileRfc64ControlObjectStoreV1 implements Rfc64ControlObjectStoreV1 {
  #closed = false;
  #operationTail: Promise<void> = Promise.resolve();
  readonly namespaceDurability = process.platform === 'win32'
    ? RFC64_CONTROL_OBJECT_STORE_WINDOWS_NAMESPACE_DURABILITY
    : RFC64_CONTROL_OBJECT_STORE_POSIX_NAMESPACE_DURABILITY;

  constructor(
    readonly rootPath: string,
    private readonly io: Rfc64ControlObjectStoreIoV1,
  ) {}

  get closed(): boolean {
    return this.#closed;
  }

  stageVerifiedObjects(
    input: readonly StageVerifiedControlObjectV1[],
  ): Promise<StageVerifiedControlObjectsResultV1> {
    this.requireOpen();
    const prepared = prepareStageBatch(input);
    return this.enqueue(async () => {
      this.requireOpen();
      const result = new Array<StagedVerifiedControlObjectV1>(prepared.length);
      for (let index = 0; index < prepared.length; index += 1) {
        const item = prepared[index];
        await this.stagePrepared(item);
        result[index] = Object.freeze({
          objectDigest: item.objectDigest,
          signatureVariantDigest: item.signatureVariantDigest,
        });
      }
      return Object.freeze({
        durable: true as const,
        namespaceDurability: this.namespaceDurability,
        objects: Object.freeze(result),
      });
    });
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
    return this.enqueue(async () => {
      this.requireOpen();
      const objectPath = this.objectPath(objectDigest);
      const signaturePath = this.signaturePath(objectDigest, signatureVariantDigest);
      const [unsignedBytes, variantBytes] = await Promise.all([
        readOptionalBoundedFile(objectPath, MAX_CONTROL_OBJECT_BYTES, 'control object'),
        readOptionalBoundedFile(
          signaturePath,
          MAX_CONTROL_SIGNATURE_VARIANT_BYTES,
          'control signature variant',
        ),
      ]);
      if (unsignedBytes === null || variantBytes === null) return null;

      let unsigned: UnsignedControlEnvelopeV1;
      let variant: ControlObjectSignatureVariantV1;
      let envelope: SignedControlEnvelopeV1;
      try {
        unsigned = parseCanonicalUnsignedControlEnvelope(unsignedBytes);
        variant = parseCanonicalControlSignatureVariant(variantBytes);
        if (
          variant.objectDigest !== objectDigest
          || variant.signatureVariantDigest !== signatureVariantDigest
        ) {
          throw new Error('stored cache keys do not match the canonical records');
        }
        envelope = deepFreezePlain(parseCanonicalSignedControlEnvelope(
          canonicalizeSignedControlEnvelopeBytes({
            ...unsigned,
            objectDigest,
            signature: variant.signature,
          }),
        )) as SignedControlEnvelopeV1;
      } catch (cause) {
        fail('control-store-corrupt', 'stored control object is not canonical for its exact keys', cause);
      }

      let issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
      try {
        issuerSignature = await verifyIssuerSignature(envelope);
        assertProofMatchesEnvelope(envelope, issuerSignature);
      } catch (cause) {
        if (cause instanceof Rfc64ControlObjectStoreErrorV1) throw cause;
        fail('control-store-verification', 'stored control object signature verification failed', cause);
      }
      return Object.freeze({ envelope, issuerSignature });
    });
  }

  close(): void {
    this.#closed = true;
  }

  private async stagePrepared(item: PreparedStoredControlObjectV1): Promise<void> {
    const objectPath = this.objectPath(item.objectDigest);
    await ensureSecureDirectory(dirname(objectPath), this.rootPath, this.io);
    await stageExactFile(objectPath, item.unsignedBytes, 'object', this.io);

    const signaturePath = this.signaturePath(
      item.objectDigest,
      item.signatureVariantDigest,
    );
    await ensureSecureDirectory(dirname(signaturePath), this.rootPath, this.io);
    await stageExactFile(signaturePath, item.signatureVariantBytes, 'signature', this.io);
  }

  private objectPath(objectDigest: Digest32V1): string {
    const hex = objectDigest.slice(2);
    return join(
      this.rootPath,
      OBJECTS_DIRECTORY,
      hex.slice(0, 2),
      `${hex}${CANONICAL_FILE_SUFFIX}`,
    );
  }

  private signaturePath(
    objectDigest: Digest32V1,
    signatureVariantDigest: Digest32V1,
  ): string {
    const objectHex = objectDigest.slice(2);
    const variantHex = signatureVariantDigest.slice(2);
    return join(
      this.rootPath,
      SIGNATURES_DIRECTORY,
      objectHex.slice(0, 2),
      objectHex,
      `${variantHex}${CANONICAL_FILE_SUFFIX}`,
    );
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#operationTail.then(operation, operation);
    this.#operationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private requireOpen(): void {
    if (this.#closed) fail('control-store-closed', 'control object store is closed');
  }
}

async function openRfc64ControlObjectStoreWithIoV1(
  dataDirInput: string,
  io: Rfc64ControlObjectStoreIoV1,
): Promise<Rfc64ControlObjectStoreV1> {
  if (!Object.isFrozen(io)) {
    fail('control-store-input', 'control object store I/O adapter must be immutable');
  }
  if (typeof dataDirInput !== 'string' || dataDirInput.length === 0) {
    fail('control-store-input', 'dataDir must be a non-empty path');
  }
  const dataDir = resolve(dataDirInput);
  const rootPath = resolve(dataDir, RFC64_CONTROL_OBJECT_STORE_RELATIVE_PATH);
  const relativeRoot = relative(dataDir, rootPath);
  if (
    relativeRoot === '..'
    || relativeRoot.startsWith(`..${sep}`)
    || isAbsolute(relativeRoot)
  ) {
    fail('control-store-unsafe-path', 'control object store must remain inside dataDir');
  }
  await assertExistingDirectory(dataDir, 'DKG data directory', false);
  await ensureSecureDirectory(rootPath, dataDir, io);
  await ensureSecureDirectory(join(rootPath, OBJECTS_DIRECTORY), rootPath, io);
  await ensureSecureDirectory(join(rootPath, SIGNATURES_DIRECTORY), rootPath, io);
  return new FileRfc64ControlObjectStoreV1(rootPath, io);
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
      const envelope = deepFreezePlain(parseCanonicalSignedControlEnvelope(
        canonicalizeSignedControlEnvelopeBytes(item.envelope),
      )) as SignedControlEnvelopeV1;
      assertProofMatchesEnvelope(envelope, item.issuerSignature);
      const unsigned = unsignedFromSigned(envelope);
      const objectDigest = envelope.objectDigest as Digest32V1;
      const signatureVariantDigest = computeControlSignatureVariantDigestHex(
        objectDigest,
        envelope.signature,
      ) as Digest32V1;
      const variant = Object.freeze({
        objectDigest,
        signature: envelope.signature,
        signatureVariantDigest,
      }) satisfies ControlObjectSignatureVariantV1;
      result[index] = Object.freeze({
        envelope,
        objectDigest,
        signatureVariantDigest,
        unsignedBytes: canonicalizeUnsignedControlEnvelopeBytes(unsigned),
        signatureVariantBytes: canonicalizeControlSignatureVariantBytes(variant),
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

function unsignedFromSigned(envelope: SignedControlEnvelopeV1): UnsignedControlEnvelopeV1 {
  return {
    issuer: envelope.issuer,
    objectType: envelope.objectType,
    payload: envelope.payload,
    signatureEvidence: envelope.signatureEvidence,
    signatureSuite: envelope.signatureSuite,
  } as UnsignedControlEnvelopeV1;
}

async function ensureSecureDirectory(
  target: string,
  containmentRoot: string,
  io: Rfc64ControlObjectStoreIoV1,
): Promise<void> {
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(containmentRoot);
  const relativeTarget = relative(resolvedRoot, resolvedTarget);
  if (
    relativeTarget === '..'
    || relativeTarget.startsWith(`..${sep}`)
    || isAbsolute(relativeTarget)
  ) {
    fail('control-store-unsafe-path', 'control store directory escaped its containment root');
  }

  if (relativeTarget.length === 0) {
    await assertExistingDirectory(resolvedTarget, 'control store directory', true);
    return;
  }
  await assertExistingDirectory(resolvedRoot, 'control store containment root', false);
  let current = resolvedRoot;
  for (const component of relativeTarget.split(sep).filter(Boolean)) {
    current = join(current, component);
    let created = false;
    try {
      await mkdir(current, { mode: RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE });
      created = true;
      io.boundary('directory.created');
    } catch (cause) {
      if (!isNodeError(cause, 'EEXIST')) {
        fail('control-store-io', `failed to create control store directory ${current}`, cause);
      }
    }
    if (created) {
      await chmodSecure(current, RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE, 'directory');
      io.boundary('directory.mode-secured');
      await fsyncDirectory(current);
      io.boundary('directory.self-fsynced');
      await fsyncDirectory(dirname(current));
      io.boundary('directory.parent-fsynced');
    }
    await assertExistingDirectory(current, 'control store directory', true);
  }
}

async function stageExactFile(
  targetPath: string,
  bytes: Uint8Array,
  kind: 'object' | 'signature',
  io: Rfc64ControlObjectStoreIoV1,
): Promise<void> {
  const existing = await readOptionalBoundedFile(
    targetPath,
    kind === 'object' ? MAX_CONTROL_OBJECT_BYTES : MAX_CONTROL_SIGNATURE_VARIANT_BYTES,
    `existing ${kind}`,
  );
  if (existing !== null) {
    if (!bytesEqual(existing, bytes)) {
      fail('control-store-corrupt', `existing ${kind} bytes differ for the same digest key`);
    }
    // A prior attempt can fail after rename but before the parent-directory
    // barrier. Re-establish both barriers before an idempotent retry reports
    // success; merely observing the exact bytes is not a durability proof.
    await fsyncRegularFile(targetPath, `existing ${kind}`);
    io.boundary(`${kind}.existing-fsynced`);
    await fsyncDirectory(dirname(targetPath));
    io.boundary(`${kind}.existing-parent-fsynced`);
    return;
  }

  const suffix = io.randomSuffix();
  if (!/^[0-9a-f]{32}$/u.test(suffix)) {
    fail('control-store-input', 'control store random suffix must be 16 lowercase hex bytes');
  }
  const tempPath = join(dirname(targetPath), `.${suffix}.tmp`);
  let renamed = false;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, 'wx', RFC64_CONTROL_OBJECT_STORE_FILE_MODE);
    await handle.writeFile(bytes);
    io.boundary(`${kind}.temp-written`);
    await chmodSecure(tempPath, RFC64_CONTROL_OBJECT_STORE_FILE_MODE, `${kind} temp file`);
    io.boundary(`${kind}.temp-mode-secured`);
    await handle.sync();
    io.boundary(`${kind}.temp-fsynced`);
    await handle.close();
    handle = null;
    await rename(tempPath, targetPath);
    renamed = true;
    io.boundary(`${kind}.renamed`);
    await fsyncDirectory(dirname(targetPath));
    io.boundary(`${kind}.parent-fsynced`);
    await assertExistingRegularFile(targetPath, `${kind} cache file`, true);
  } catch (cause) {
    if (cause instanceof Rfc64ControlObjectStoreErrorV1) throw cause;
    fail('control-store-durability', `failed to durably stage ${kind} bytes`, cause);
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
    if (!renamed) await unlink(tempPath).catch(() => undefined);
  }
}

async function readOptionalBoundedFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<Uint8Array | null> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      fail('control-store-unsafe-path', `${label} must be a regular non-symlink file`);
    }
  } catch (cause) {
    if (isNodeError(cause, 'ENOENT')) return null;
    if (cause instanceof Rfc64ControlObjectStoreErrorV1) throw cause;
    fail('control-store-io', `failed to inspect ${label}`, cause);
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) {
      fail('control-store-corrupt', `${label} is outside its bounded regular-file shape`);
    }
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) {
        fail('control-store-corrupt', `${label} was truncated during its bounded read`);
      }
      offset += read.bytesRead;
    }
    const extra = new Uint8Array(1);
    const tail = await handle.read(extra, 0, 1, offset);
    if (tail.bytesRead !== 0) {
      fail('control-store-corrupt', `${label} grew during its bounded read`);
    }
    assertOwner(stat.uid, label);
    await assertFileMode(stat.mode, label);
    return bytes;
  } catch (cause) {
    if (cause instanceof Rfc64ControlObjectStoreErrorV1) throw cause;
    fail('control-store-io', `failed to read ${label}`, cause);
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
  return fail('control-store-io', `failed to complete bounded read of ${label}`);
}

async function assertExistingDirectory(
  path: string,
  label: string,
  requireSecureMode: boolean,
): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      fail('control-store-unsafe-path', `${label} must be a non-symlink directory`);
    }
    assertOwner(entry.uid, label);
    if (requireSecureMode) await assertDirectoryMode(entry.mode, label);
  } catch (cause) {
    if (cause instanceof Rfc64ControlObjectStoreErrorV1) throw cause;
    fail('control-store-io', `failed to inspect ${label}`, cause);
  }
}

async function assertExistingRegularFile(
  path: string,
  label: string,
  requireSecureMode: boolean,
): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      fail('control-store-unsafe-path', `${label} must be a regular non-symlink file`);
    }
    assertOwner(entry.uid, label);
    if (requireSecureMode) await assertFileMode(entry.mode, label);
  } catch (cause) {
    if (cause instanceof Rfc64ControlObjectStoreErrorV1) throw cause;
    fail('control-store-io', `failed to inspect ${label}`, cause);
  }
}

async function chmodSecure(path: string, mode: number, label: string): Promise<void> {
  try {
    if (process.platform !== 'win32') await chmod(path, mode);
    const entry = await lstat(path);
    assertOwner(entry.uid, label);
    if (process.platform !== 'win32' && (entry.mode & 0o777) !== mode) {
      throw new Error(`${label} mode is ${(entry.mode & 0o777).toString(8)}, expected ${mode.toString(8)}`);
    }
  } catch (cause) {
    fail('control-store-unsafe-path', `failed to secure ${label}`, cause);
  }
}

async function assertDirectoryMode(mode: number, label: string): Promise<void> {
  if (
    process.platform !== 'win32'
    && (mode & 0o777) !== RFC64_CONTROL_OBJECT_STORE_DIRECTORY_MODE
  ) {
    fail('control-store-unsafe-path', `${label} must have owner-only mode 0700`);
  }
}

async function assertFileMode(mode: number, label: string): Promise<void> {
  if (
    process.platform !== 'win32'
    && (mode & 0o777) !== RFC64_CONTROL_OBJECT_STORE_FILE_MODE
  ) {
    fail('control-store-unsafe-path', `${label} must have owner-only mode 0600`);
  }
}

function assertOwner(uid: number, label: string): void {
  if (process.platform === 'win32') return;
  const processUid = process.getuid?.();
  if (processUid !== undefined && uid !== processUid) {
    fail('control-store-unsafe-path', `${label} is not owned by the current process user`);
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  // Match the inventory-v1 durability primitive: Node maps fsync to
  // FlushFileBuffers on Windows, which rejects directory handles with EPERM.
  // Regular files are still flushed before rename (and again on idempotent
  // recovery); the directory barrier is available only on POSIX backends.
  if (process.platform === 'win32') return;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, constants.O_RDONLY);
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      fail('control-store-unsafe-path', 'directory fsync target is not a directory');
    }
    await handle.sync();
  } catch (cause) {
    if (cause instanceof Rfc64ControlObjectStoreErrorV1) throw cause;
    fail('control-store-durability', `failed to fsync directory ${path}`, cause);
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
  }
}

async function fsyncRegularFile(path: string, label: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    // FlushFileBuffers requires a write-capable Windows handle. POSIX retains
    // a read-only descriptor so an idempotent recovery never gains write access.
    handle = await open(
      path,
      process.platform === 'win32' ? 'r+' : constants.O_RDONLY | noFollow,
    );
    const stat = await handle.stat();
    if (!stat.isFile()) {
      fail('control-store-unsafe-path', `${label} fsync target is not a regular file`);
    }
    await handle.sync();
  } catch (cause) {
    if (cause instanceof Rfc64ControlObjectStoreErrorV1) throw cause;
    fail('control-store-durability', `failed to fsync ${label}`, cause);
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
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

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let different = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    different |= left[index] ^ right[index];
  }
  return different === 0;
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

function isNodeError(cause: unknown, code: string): boolean {
  return cause instanceof Error && 'code' in cause
    && (cause as NodeJS.ErrnoException).code === code;
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
