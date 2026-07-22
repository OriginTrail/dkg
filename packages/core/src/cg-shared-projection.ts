import {
  parseRdfLiteralLexicalTerm,
} from '@origintrail-official/dkg-rdf-utils';
import { sha256 } from '@noble/hashes/sha2.js';

import type { AuthorCatalogRowV1 } from './author-catalog-codec.js';
import type { SignedAuthorCatalogHeadEnvelopeV1 } from './author-catalog-objects.js';
import {
  readVerifiedCatalogSealBindingV1,
  type CatalogSealDeploymentProfileV1,
} from './catalog-seal-binding.js';
import {
  type CanonicalGraphScopedAuthorSealV1,
  type SealTripleCountV1,
} from './canonical-graph-scoped-author-seal.js';
import {
  KA_BUNDLE_PROJECTION_DIGEST_DOMAIN_V1,
} from './ka-bundle-v1.js';
import {
  V10MerkleTree,
} from './crypto/v10-merkle.js';
import {
  canonicalizeObjectTermForHash,
} from './crypto/term-canon.js';
import {
  hashTripleV10,
  tripleContentV10,
} from './crypto/canonicalize.js';
import { isAbsoluteRfc3987IriV1 } from './absolute-rfc3987-iri.js';
import type {
  ByteLengthV1,
  Digest32V1,
} from './sync-wire-scalars.js';
import {
  assertVerifiedTransferredCatalogBundleForInputsV1,
  readVerifiedTransferredCatalogBundleMetadataV1,
  readVerifiedTransferredCatalogProjectionBytesV1,
  type VerifiedTransferredCatalogBundleV1,
} from './transferred-catalog-bundle.js';

declare const VERIFIED_CG_SHARED_PROJECTION_BRAND_V1: unique symbol;

export const CG_SHARED_PROJECTION_ID_V1 = 'cg-shared-v1' as const;
export const CG_SHARED_PRIVATE_COMMITMENT_SUFFIX_V1 = '/_cg-shared-v1' as const;
export const CG_SHARED_PRIVATE_ANCHOR_PREDICATE_V1 =
  'http://dkg.io/ontology/privateDataAnchor' as const;
export const CG_SHARED_PRIVATE_HASH_PREDICATE_V1 =
  'http://dkg.io/ontology/privateDataHash' as const;

const PRIVATE_COMMITMENT_PREDICATE_PREFIX =
  'http://dkg.io/ontology/privateData';
const XSD_HEX_BINARY_IRI = 'http://www.w3.org/2001/XMLSchema#hexBinary';
const UTF8 = new TextEncoder();
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const PROJECTION_DIGEST_DOMAIN = UTF8.encode(
  KA_BUNDLE_PROJECTION_DIGEST_DOMAIN_V1,
);
const SENTINEL_NO_PRIVATE_DIGEST_V10 =
  '0xdfba2a3576c2aa2d73ecd8c55d1c27cfb15691ca9d3237b86434a06592f160ee' as Digest32V1;
const LOWER_LANGUAGE_TAG = /^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/;
const HEX_ESCAPE = /^[0-9A-Fa-f]{2}$/;

/**
 * Safe defaults for this in-memory verifier. Exceeding them is a local
 * resource refusal, not proof that otherwise canonical projection bytes are
 * invalid. A streaming/external-sort verifier is required for larger inputs.
 */
export const DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1 = Object.freeze({
  maxProjectionBytes: 64 * 1024 * 1024,
  maxPublicTriples: 262_144,
  maxLineBytes: 64 * 1024 * 1024,
});

export interface CgSharedProjectionVerificationLimitsV1 {
  readonly maxProjectionBytes: number;
  readonly maxPublicTriples: number;
  readonly maxLineBytes: number;
}

export interface CgSharedPublicRootProjectionTripleV1 {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
}

/**
 * Encode public-root triples into the exact canonical bytes consumed by the
 * cg-shared-v1 verifier: V10-canonical terms, one LF per line, and raw UTF-8
 * byte ordering. Graph placement is deliberately absent from this wire view.
 */
export function encodeCanonicalCgSharedPublicRootProjectionV1(
  triples: readonly CgSharedPublicRootProjectionTripleV1[],
): Uint8Array {
  const lines = triples.map(({ subject, predicate, object }) => {
    const content = tripleContentV10(subject, predicate, object);
    const line = new Uint8Array(content.byteLength + 1);
    line.set(content);
    line[line.byteLength - 1] = 0x0a;
    return line;
  });
  lines.sort(compareBytes);
  const byteLength = lines.reduce((sum, line) => sum + line.byteLength, 0);
  const projection = new Uint8Array(byteLength);
  let offset = 0;
  for (const line of lines) {
    projection.set(line, offset);
    offset += line.byteLength;
  }
  return projection;
}

/**
 * Process-local proof that one structurally verified transferred bundle carries
 * the exact canonical `cg-shared-v1` projection committed by its author seal.
 *
 * This is precommit evidence only. It grants no catalog authority, policy,
 * author-attestation, VM-finality, semantic-store, or activation authority.
 */
export interface VerifiedCgSharedProjectionV1 {
  readonly [VERIFIED_CG_SHARED_PROJECTION_BRAND_V1]: true;
}

export interface VerifiedCgSharedProjectionSnapshotV1 {
  readonly headObjectDigest: Digest32V1;
  readonly catalogScopeDigest: Digest32V1;
  readonly catalogRowDigest: Digest32V1;
  readonly transferIdentityDigest: Digest32V1;
  readonly projectionId: typeof CG_SHARED_PROJECTION_ID_V1;
  readonly projectionDigest: Digest32V1;
  readonly projectionByteLength: ByteLengthV1;
  readonly publicTripleCount: SealTripleCountV1;
  readonly privateTripleCount: SealTripleCountV1;
  readonly publicRoot: Digest32V1;
  readonly privateDataHash: Digest32V1;
  readonly assertionMerkleRoot: Digest32V1;
  readonly privateMerkleRoot: Digest32V1 | null;
  readonly kaUal: string;
  /** Local in-memory verifier limits used for this successful proof. */
  readonly verificationLimits: Readonly<CgSharedProjectionVerificationLimitsV1>;
  /** Fresh caller-owned copy of the exact canonical projection bytes. */
  readonly projectionBytes: Uint8Array;
}

export type VerifiedCgSharedProjectionMetadataV1 = Omit<
  VerifiedCgSharedProjectionSnapshotV1,
  'projectionBytes'
>;

export type CgSharedProjectionErrorCode =
  | 'projection-input'
  | 'projection-empty'
  | 'projection-utf8'
  | 'projection-line-ending'
  | 'projection-line'
  | 'projection-order'
  | 'projection-duplicate'
  | 'projection-iri'
  | 'projection-literal'
  | 'projection-private-predicate'
  | 'projection-private-cardinality'
  | 'projection-private-subject'
  | 'projection-private-root-mismatch'
  | 'projection-public-count'
  | 'projection-digest'
  | 'projection-structured-root'
  | 'projection-resource-refused'
  | 'projection-capability'
  | 'projection-binding';

export class CgSharedProjectionError extends Error {
  constructor(
    readonly code: CgSharedProjectionErrorCode,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'CgSharedProjectionError';
  }
}

interface CanonicalProjectionTripleV1 {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly leaf: Uint8Array;
}

interface VerifiedCgSharedProjectionStateV1 {
  readonly transferredBundle: VerifiedTransferredCatalogBundleV1;
  readonly snapshot: Omit<VerifiedCgSharedProjectionSnapshotV1, 'projectionBytes'>;
}

const VERIFIED_CG_SHARED_PROJECTIONS_V1 = new WeakMap<
  object,
  VerifiedCgSharedProjectionStateV1
>();

/** Verify canonical bytes, private commitment, counts, and structured V10 root. */
export function verifyCgSharedProjectionV1(
  transferredBundle: VerifiedTransferredCatalogBundleV1,
  signedHead: SignedAuthorCatalogHeadEnvelopeV1,
  row: AuthorCatalogRowV1,
  deployment: CatalogSealDeploymentProfileV1,
  limits: CgSharedProjectionVerificationLimitsV1 =
    DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1,
): VerifiedCgSharedProjectionV1 {
  let metadata: ReturnType<typeof readVerifiedTransferredCatalogBundleMetadataV1>;
  try {
    metadata = readVerifiedTransferredCatalogBundleMetadataV1(
      transferredBundle,
      signedHead,
      row,
      deployment,
    );
  } catch (cause) {
    fail(
      'projection-input',
      'projection input is not an exact verified transferred catalog bundle',
      cause,
    );
  }

  const sealBinding = readVerifiedCatalogSealBindingV1(
    metadata.catalogSealBinding,
  );
  if (
    sealBinding.catalogScopeDigest !== metadata.catalogScopeDigest
    || sealBinding.catalogRowDigest !== metadata.catalogRowDigest
  ) {
    fail('projection-binding', 'seal binding and transferred bundle identify different rows');
  }
  if (metadata.transfer.projectionId !== CG_SHARED_PROJECTION_ID_V1) {
    fail('projection-binding', 'transferred row does not advertise cg-shared-v1');
  }
  const verificationLimits = normalizeVerificationLimits(limits);
  assertProjectionWithinLocalLimits(
    metadata.projectionByteLength,
    sealBinding.seal.publicTripleCount,
    verificationLimits,
  );

  let projectionBytes: Uint8Array;
  try {
    projectionBytes = readVerifiedTransferredCatalogProjectionBytesV1(
      transferredBundle,
      signedHead,
      row,
      deployment,
    );
  } catch (cause) {
    fail(
      'projection-input',
      'verified transferred projection bytes could not be read',
      cause,
    );
  }
  if (projectionBytes.byteLength > verificationLimits.maxProjectionBytes) {
    fail(
      'projection-resource-refused',
      'projection exceeds the local in-memory byte limit',
    );
  }

  const projectionDigest = computeProjectionDigest(projectionBytes);
  if (
    projectionDigest !== metadata.projectionDigest
    || projectionDigest !== metadata.transfer.projectionDigest
  ) {
    fail('projection-digest', 'canonical projection bytes differ from the transferred digest');
  }

  const semantic = verifyCanonicalProjectionBytes(
    projectionBytes,
    sealBinding.seal,
    verificationLimits,
  );
  const snapshot = Object.freeze({
    headObjectDigest: metadata.headObjectDigest,
    catalogScopeDigest: metadata.catalogScopeDigest,
    catalogRowDigest: metadata.catalogRowDigest,
    transferIdentityDigest: metadata.transferIdentityDigest,
    projectionId: CG_SHARED_PROJECTION_ID_V1,
    projectionDigest,
    projectionByteLength: String(projectionBytes.byteLength) as ByteLengthV1,
    publicTripleCount: sealBinding.seal.publicTripleCount,
    privateTripleCount: sealBinding.seal.privateTripleCount,
    publicRoot: semantic.publicRoot,
    privateDataHash: semantic.privateDataHash,
    assertionMerkleRoot: semantic.assertionMerkleRoot,
    privateMerkleRoot: sealBinding.seal.privateMerkleRoot,
    kaUal: sealBinding.seal.kaUal,
    verificationLimits,
  });
  const capability = Object.freeze(
    Object.create(null),
  ) as VerifiedCgSharedProjectionV1;
  VERIFIED_CG_SHARED_PROJECTIONS_V1.set(capability as object, Object.freeze({
    transferredBundle,
    snapshot,
  }));
  return capability;
}

export function assertVerifiedCgSharedProjectionV1(
  value: unknown,
): asserts value is VerifiedCgSharedProjectionV1 {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    fail('projection-capability', 'projection proof was not minted by this verifier');
  }
  if (!VERIFIED_CG_SHARED_PROJECTIONS_V1.has(value as object)) {
    fail('projection-capability', 'projection proof was not minted by this verifier');
  }
}

export function assertVerifiedCgSharedProjectionForTransferV1(
  value: unknown,
  transferredBundle: VerifiedTransferredCatalogBundleV1,
  signedHead: SignedAuthorCatalogHeadEnvelopeV1,
  row: AuthorCatalogRowV1,
  deployment: CatalogSealDeploymentProfileV1,
): asserts value is VerifiedCgSharedProjectionV1 {
  assertVerifiedCgSharedProjectionV1(value);
  try {
    assertVerifiedTransferredCatalogBundleForInputsV1(
      transferredBundle,
      signedHead,
      row,
      deployment,
    );
  } catch (cause) {
    fail('projection-binding', 'transferred bundle context is not canonical', cause);
  }
  const state = VERIFIED_CG_SHARED_PROJECTIONS_V1.get(value as object)!;
  if (state.transferredBundle !== transferredBundle) {
    fail('projection-binding', 'projection proof belongs to another transferred bundle');
  }
}

export function readVerifiedCgSharedProjectionV1(
  value: unknown,
  transferredBundle: VerifiedTransferredCatalogBundleV1,
  signedHead: SignedAuthorCatalogHeadEnvelopeV1,
  row: AuthorCatalogRowV1,
  deployment: CatalogSealDeploymentProfileV1,
): VerifiedCgSharedProjectionSnapshotV1 {
  const metadata = readVerifiedCgSharedProjectionMetadataV1(
    value,
    transferredBundle,
    signedHead,
    row,
    deployment,
  );
  return Object.freeze({
    ...metadata,
    projectionBytes: readVerifiedCgSharedProjectionBytesV1(
      value,
      transferredBundle,
      signedHead,
      row,
      deployment,
    ),
  });
}

/** Read verified scalar/root metadata without allocating projection bytes. */
export function readVerifiedCgSharedProjectionMetadataV1(
  value: unknown,
  transferredBundle: VerifiedTransferredCatalogBundleV1,
  signedHead: SignedAuthorCatalogHeadEnvelopeV1,
  row: AuthorCatalogRowV1,
  deployment: CatalogSealDeploymentProfileV1,
): VerifiedCgSharedProjectionMetadataV1 {
  assertVerifiedCgSharedProjectionForTransferV1(
    value,
    transferredBundle,
    signedHead,
    row,
    deployment,
  );
  const state = VERIFIED_CG_SHARED_PROJECTIONS_V1.get(value as object)!;
  return Object.freeze({ ...state.snapshot });
}

/** Read one fresh caller-owned copy of the verified canonical projection. */
export function readVerifiedCgSharedProjectionBytesV1(
  value: unknown,
  transferredBundle: VerifiedTransferredCatalogBundleV1,
  signedHead: SignedAuthorCatalogHeadEnvelopeV1,
  row: AuthorCatalogRowV1,
  deployment: CatalogSealDeploymentProfileV1,
): Uint8Array {
  assertVerifiedCgSharedProjectionForTransferV1(
    value,
    transferredBundle,
    signedHead,
    row,
    deployment,
  );
  return readVerifiedTransferredCatalogProjectionBytesV1(
    transferredBundle,
    signedHead,
    row,
    deployment,
  );
}

function verifyCanonicalProjectionBytes(
  projectionBytes: Uint8Array,
  seal: Readonly<CanonicalGraphScopedAuthorSealV1>,
  limits: Readonly<CgSharedProjectionVerificationLimitsV1>,
): {
  readonly publicRoot: Digest32V1;
  readonly privateDataHash: Digest32V1;
  readonly assertionMerkleRoot: Digest32V1;
} {
  if (projectionBytes.byteLength === 0) {
    fail('projection-empty', 'cg-shared-v1 projection must not be empty');
  }
  if (
    projectionBytes.byteLength >= 3
    && projectionBytes[0] === 0xef
    && projectionBytes[1] === 0xbb
    && projectionBytes[2] === 0xbf
  ) {
    fail('projection-utf8', 'cg-shared-v1 projection must not start with a UTF-8 BOM');
  }
  if (projectionBytes[projectionBytes.byteLength - 1] !== 0x0a) {
    fail('projection-line-ending', 'cg-shared-v1 projection must end with one LF');
  }

  const leaves: Uint8Array[] = [];
  let anchor: CanonicalProjectionTripleV1 | undefined;
  let privateHash: CanonicalProjectionTripleV1 | undefined;
  let previousLine: Uint8Array | undefined;
  let lineStart = 0;
  let lineNumber = 0;
  const signedPublicTripleCount = BigInt(seal.publicTripleCount);
  const reservedCommitmentSubject =
    `${seal.kaUal}${CG_SHARED_PRIVATE_COMMITMENT_SUFFIX_V1}`;
  for (let cursor = 0; cursor < projectionBytes.byteLength; cursor += 1) {
    const byte = projectionBytes[cursor];
    if (byte === 0x0d) {
      fail('projection-line-ending', 'raw CR is forbidden in cg-shared-v1 bytes');
    }
    if (byte !== 0x0a) continue;
    const line = projectionBytes.subarray(lineStart, cursor);
    lineNumber += 1;
    if (BigInt(lineNumber) > signedPublicTripleCount) {
      fail(
        'projection-public-count',
        'projection contains more lines than the signed publicTripleCount',
      );
    }
    if (line.byteLength === 0) {
      fail('projection-line', `projection line ${lineNumber} is empty`);
    }
    if (line.byteLength > limits.maxLineBytes) {
      fail(
        'projection-resource-refused',
        `projection line ${lineNumber} exceeds the local in-memory line limit`,
      );
    }
    if (previousLine !== undefined) {
      const ordering = compareBytes(previousLine, line);
      if (ordering === 0) {
        fail('projection-duplicate', `projection line ${lineNumber} duplicates its predecessor`);
      }
      if (ordering > 0) {
        fail('projection-order', `projection line ${lineNumber} is not in raw UTF-8 order`);
      }
    }
    const triple = parseCanonicalProjectionLine(line, lineNumber);
    if (
      triple.subject === reservedCommitmentSubject
      && triple.predicate !== CG_SHARED_PRIVATE_ANCHOR_PREDICATE_V1
      && triple.predicate !== CG_SHARED_PRIVATE_HASH_PREDICATE_V1
    ) {
      fail(
        'projection-private-subject',
        `projection line ${lineNumber} reuses the reserved commitment subject`,
      );
    }
    if (triple.predicate === CG_SHARED_PRIVATE_ANCHOR_PREDICATE_V1) {
      if (anchor !== undefined) {
        fail('projection-private-cardinality', 'projection contains duplicate private anchors');
      }
      anchor = triple;
    } else if (triple.predicate === CG_SHARED_PRIVATE_HASH_PREDICATE_V1) {
      if (privateHash !== undefined) {
        fail('projection-private-cardinality', 'projection contains duplicate private hashes');
      }
      privateHash = triple;
    } else if (triple.predicate.startsWith(PRIVATE_COMMITMENT_PREDICATE_PREFIX)) {
      fail(
        'projection-private-predicate',
        `projection line ${lineNumber} uses an unknown reserved private-data predicate`,
      );
    }
    leaves.push(triple.leaf);
    previousLine = line;
    lineStart = cursor + 1;
  }
  if (lineStart !== projectionBytes.byteLength) {
    fail('projection-line-ending', 'projection contains bytes after its final complete line');
  }

  if (BigInt(lineNumber) !== BigInt(seal.publicTripleCount)) {
    fail(
      'projection-public-count',
      'canonical projection line count differs from seal publicTripleCount',
    );
  }
  assertPrivateCommitment(anchor, privateHash, seal);

  const publicTree = new V10MerkleTree(leaves);
  const publicRoot = bytesToDigest(publicTree.root);
  const privateDataHash = seal.privateMerkleRoot ?? SENTINEL_NO_PRIVATE_DIGEST_V10;
  const assertionMerkleRoot = bytesToDigest(V10MerkleTree.computeKARoot(
    publicTree.root,
    digestToBytes(privateDataHash),
  ));
  if (assertionMerkleRoot !== seal.assertionMerkleRoot) {
    fail(
      'projection-structured-root',
      'recomputed structured assertion root differs from the author seal',
    );
  }
  return Object.freeze({ publicRoot, privateDataHash, assertionMerkleRoot });
}

function assertPrivateCommitment(
  anchor: CanonicalProjectionTripleV1 | undefined,
  privateHash: CanonicalProjectionTripleV1 | undefined,
  seal: Readonly<CanonicalGraphScopedAuthorSealV1>,
): void {
  const privateCount = BigInt(seal.privateTripleCount);
  if (privateCount === 0n) {
    if (seal.privateMerkleRoot !== null || anchor !== undefined || privateHash !== undefined) {
      fail(
        'projection-private-cardinality',
        'public-only projection must not contain a private commitment',
      );
    }
    return;
  }
  if (
    seal.privateMerkleRoot === null
    || anchor === undefined
    || privateHash === undefined
  ) {
    fail(
      'projection-private-cardinality',
      'private-bearing projection requires exactly one anchor and one hash statement',
    );
  }
  const expectedSubject = `${seal.kaUal}${CG_SHARED_PRIVATE_COMMITMENT_SUFFIX_V1}`;
  if (anchor.subject !== expectedSubject || privateHash.subject !== expectedSubject) {
    fail(
      'projection-private-subject',
      'private commitment subject is not derived from the canonical author-seal UAL',
    );
  }
  if (anchor.object !== '"true"') {
    fail('projection-private-cardinality', 'privateDataAnchor must be the plain literal "true"');
  }
  const expectedHash =
    `"${seal.privateMerkleRoot.slice(2)}"^^<${XSD_HEX_BINARY_IRI}>`;
  if (privateHash.object !== expectedHash) {
    fail(
      'projection-private-root-mismatch',
      'privateDataHash does not reproduce the seal privateMerkleRoot',
    );
  }
}

function parseCanonicalProjectionLine(
  lineBytes: Uint8Array,
  lineNumber: number,
): CanonicalProjectionTripleV1 {
  let line: string;
  try {
    line = STRICT_UTF8.decode(lineBytes);
  } catch (cause) {
    fail('projection-utf8', `projection line ${lineNumber} is not valid UTF-8`, cause);
  }
  if (line.codePointAt(0) === 0xfeff) {
    fail('projection-utf8', `projection line ${lineNumber} starts with a BOM`);
  }
  if (!line.endsWith(' .')) {
    fail('projection-line', `projection line ${lineNumber} must end with exactly " ."`);
  }

  const objectEnd = line.length - 2;
  const subject = parseCanonicalIriTerm(line, 0, lineNumber, 'subject');
  if (line[subject.end] !== ' ') {
    fail('projection-line', `projection line ${lineNumber} must contain one subject separator`);
  }
  const predicate = parseCanonicalIriTerm(
    line,
    subject.end + 1,
    lineNumber,
    'predicate',
  );
  if (line[predicate.end] !== ' ') {
    fail('projection-line', `projection line ${lineNumber} must contain one predicate separator`);
  }
  const objectStart = predicate.end + 1;
  if (objectStart >= objectEnd) {
    fail('projection-line', `projection line ${lineNumber} has no object`);
  }
  const object = line.slice(objectStart, objectEnd);
  assertCanonicalObjectTerm(object, lineNumber);

  const reconstructed = tripleContentV10(
    subject.value,
    predicate.value,
    object,
  );
  if (!equalBytes(reconstructed, lineBytes)) {
    fail(
      object.startsWith('"') ? 'projection-literal' : 'projection-line',
      `projection line ${lineNumber} is not a canonical V10 fixed point`,
    );
  }
  return Object.freeze({
    subject: subject.value,
    predicate: predicate.value,
    object,
    leaf: hashTripleV10(subject.value, predicate.value, object),
  });
}

function parseCanonicalIriTerm(
  input: string,
  start: number,
  lineNumber: number,
  label: 'subject' | 'predicate' | 'object',
): { readonly value: string; readonly end: number } {
  if (input[start] !== '<') {
    fail('projection-iri', `projection line ${lineNumber} ${label} must be an IRI`);
  }
  const endBracket = input.indexOf('>', start + 1);
  if (endBracket < 0) {
    fail('projection-iri', `projection line ${lineNumber} ${label} IRI is unterminated`);
  }
  const value = input.slice(start + 1, endBracket);
  assertCanonicalIriValue(value, lineNumber, label);
  return Object.freeze({ value, end: endBracket + 1 });
}

function assertCanonicalObjectTerm(object: string, lineNumber: number): void {
  if (object.startsWith('<')) {
    const parsed = parseCanonicalIriTerm(object, 0, lineNumber, 'object');
    if (parsed.end !== object.length) {
      fail('projection-iri', `projection line ${lineNumber} object has trailing bytes`);
    }
    return;
  }
  if (!object.startsWith('"')) {
    fail(
      'projection-line',
      `projection line ${lineNumber} object must be a named node or literal`,
    );
  }
  const literal = parseRdfLiteralLexicalTerm(object);
  if (!literal) {
    fail('projection-literal', `projection line ${lineNumber} literal is malformed`);
  }
  assertCanonicalLiteralBody(literal.body, lineNumber);
  if (literal.suffix.kind === 'language') {
    if (!LOWER_LANGUAGE_TAG.test(literal.suffix.language)) {
      fail(
        'projection-literal',
        `projection line ${lineNumber} language tag is not canonical lowercase BCP47`,
      );
    }
  } else if (literal.suffix.kind === 'datatype') {
    if (literal.suffix.syntax !== 'bracketed') {
      fail('projection-literal', `projection line ${lineNumber} datatype IRI is not bracketed`);
    }
    assertCanonicalIriValue(literal.suffix.datatype, lineNumber, 'object');
  }
  if (canonicalizeObjectTermForHash(object) !== object) {
    fail(
      'projection-literal',
      `projection line ${lineNumber} literal is not the canonical V10 fixed point`,
    );
  }
}

function assertCanonicalLiteralBody(body: string, lineNumber: number): void {
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      fail('projection-literal', `projection line ${lineNumber} literal contains a raw control`);
    }
    if (body[index] !== '\\') continue;
    const escaped = body[index + 1];
    if (escaped !== '\\' && escaped !== '"' && escaped !== 'n' && escaped !== 'r') {
      fail(
        'projection-literal',
        `projection line ${lineNumber} literal uses a noncanonical escape`,
      );
    }
    index += 1;
  }
}

function assertCanonicalIriValue(
  value: string,
  lineNumber: number,
  label: string,
): void {
  if (!isAbsoluteRfc3987IriV1(value)) {
    fail('projection-iri', `projection line ${lineNumber} ${label} IRI is not absolute and safe`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '%') {
      if (!HEX_ESCAPE.test(value.slice(index + 1, index + 3))) {
        fail('projection-iri', `projection line ${lineNumber} ${label} IRI has a bad percent escape`);
      }
      index += 2;
      continue;
    }
    const codePoint = value.codePointAt(index)!;
    if (
      codePoint <= 0x20
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      fail('projection-iri', `projection line ${lineNumber} ${label} IRI has a forbidden code point`);
    }
    if (codePoint > 0xffff) index += 1;
  }
}

function normalizeVerificationLimits(
  value: CgSharedProjectionVerificationLimitsV1,
): Readonly<CgSharedProjectionVerificationLimitsV1> {
  const hard = DEFAULT_CG_SHARED_PROJECTION_VERIFICATION_LIMITS_V1;
  // Capture each caller-controlled limit exactly once. A stateful getter or
  // Proxy could otherwise return a safe value during validation and an
  // oversized value when the frozen result is built, smuggling a limit past
  // the hard resource ceilings. Every check and the returned object below read
  // only these captured scalars, never `value` a second time.
  const maxProjectionBytes = value?.maxProjectionBytes;
  const maxPublicTriples = value?.maxPublicTriples;
  const maxLineBytes = value?.maxLineBytes;
  for (const [name, member, ceiling] of [
    ['maxProjectionBytes', maxProjectionBytes, hard.maxProjectionBytes],
    ['maxPublicTriples', maxPublicTriples, hard.maxPublicTriples],
    ['maxLineBytes', maxLineBytes, hard.maxLineBytes],
  ] as const) {
    if (
      !Number.isSafeInteger(member)
      || member < 1
      || member > ceiling
    ) {
      fail(
        'projection-resource-refused',
        `${name} is outside this in-memory verifier's supported range`,
      );
    }
  }
  if (maxLineBytes > maxProjectionBytes) {
    fail(
      'projection-resource-refused',
      'maxLineBytes cannot exceed maxProjectionBytes',
    );
  }
  return Object.freeze({
    maxProjectionBytes,
    maxPublicTriples,
    maxLineBytes,
  });
}

function assertProjectionWithinLocalLimits(
  projectionByteLength: ByteLengthV1,
  publicTripleCount: SealTripleCountV1,
  limits: Readonly<CgSharedProjectionVerificationLimitsV1>,
): void {
  if (BigInt(projectionByteLength) > BigInt(limits.maxProjectionBytes)) {
    fail(
      'projection-resource-refused',
      'projection exceeds the local in-memory byte limit',
    );
  }
  if (BigInt(publicTripleCount) > BigInt(limits.maxPublicTriples)) {
    fail(
      'projection-resource-refused',
      'signed publicTripleCount exceeds the local in-memory leaf limit',
    );
  }
}

function computeProjectionDigest(projectionBytes: Uint8Array): Digest32V1 {
  const hasher = sha256.create();
  hasher.update(PROJECTION_DIGEST_DOMAIN);
  hasher.update(projectionBytes);
  return bytesToDigest(hasher.digest());
}

function digestToBytes(value: Digest32V1): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}

function bytesToDigest(bytes: Uint8Array): Digest32V1 {
  let value = '0x';
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0');
  return value as Digest32V1;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.byteLength - right.byteLength;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function fail(
  code: CgSharedProjectionErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new CgSharedProjectionError(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
