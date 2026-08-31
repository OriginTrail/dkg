import { sha256 } from '@noble/hashes/sha2.js';
import {
  AuthorCatalogAuthorityCodecError,
  AuthorCatalogObjectCodecError,
  assertAuthorCatalogBucketScopeBindingV1,
  assertCanonicalChainId,
  assertCanonicalDigest,
  assertCanonicalKaId,
  assertContextGraphIdV1,
  assertNetworkIdV1,
  assertSubGraphNameV1,
  canonicalizeAuthorCatalogBucketPayloadBytesV1,
  canonicalizeAuthorCatalogRowV1,
  canonicalizeSignedAuthorCatalogBucketEnvelopeBytesV1,
  canonicalizeSignedAuthorCatalogDirectoryNodeEnvelopeBytesV1,
  canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1,
  canonicalizeSignedAuthorCatalogIssuerDelegationEnvelopeBytesV1,
  catalogKeyToBucketIdV1,
  computeAuthorCatalogRowDigestV1,
  computeAuthorCatalogScopeDigestV1,
  computeControlSignatureVariantDigestHex,
  computeKaTransferIdentityDigestV1,
  deriveAuthorCatalogScopeFromHeadV1,
  parseCanonicalAuthorCatalogRowV1,
  parseCanonicalDecimalU64,
  parseCanonicalSignedAuthorCatalogBucketEnvelopeV1,
  parseCanonicalSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  parseCanonicalSignedAuthorCatalogHeadEnvelopeV1,
  parseCanonicalSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  readVerifiedAuthorCatalogBucketDescriptorV1,
  verifyAuthorCatalogDirectoryPathV1,
  type AuthorCatalogRowV1,
  type ChainIdV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type KaIdV1,
  type NetworkIdV1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  type SubGraphNameV1,
  type TimestampMsV1,
  type VerifiedAuthorCatalogDirectoryPathV1,
} from '@origintrail-official/dkg-core';
import {
  readVerifiedControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureSnapshotV1,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';

import { computeDelegationDigest } from '../auth/agent-delegation.js';

export const AUTHOR_CATALOG_AGENT_SCOPE_DIGEST_DOMAIN_V1 =
  'dkg-author-catalog-agent-scope-v1\n' as const;
export const AUTHOR_AGENT_DELEGATION_EVIDENCE_DIGEST_DOMAIN_V1 =
  'dkg-author-agent-delegation-evidence-v1\n' as const;
export const AUTHOR_CATALOG_AGENT_SCOPE_PREFIX_V1 =
  'dkg:rfc64:author-catalog-issuer-v1:' as const;
export const MAX_AUTHOR_AGENT_DELEGATION_EVIDENCE_BYTES_V1 = 4_096;
export const MAX_AUTHOR_AGENT_DELEGATEE_PEER_ID_BYTES_V1 = 256;
export const MAX_AUTHOR_AGENT_DELEGATION_TIMESTAMP_V1 = 9_007_199_254_740_991n;

const UTF8 = new TextEncoder();
const AUTHOR_CATALOG_AGENT_SCOPE_DOMAIN_BYTES_V1 = UTF8.encode(
  AUTHOR_CATALOG_AGENT_SCOPE_DIGEST_DOMAIN_V1,
);
const AUTHOR_AGENT_EVIDENCE_DOMAIN_BYTES_V1 = UTF8.encode(
  AUTHOR_AGENT_DELEGATION_EVIDENCE_DIGEST_DOMAIN_V1,
);
const SECP256K1_N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);
const SECP256K1_HALF_N = BigInt(
  '0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0',
);

export interface AuthorCatalogAgentScopeV1 {
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly governanceChainId: ChainIdV1 | null;
  readonly governanceContractAddress: EvmAddressV1 | null;
  readonly ownershipTransitionDigest: Digest32V1 | null;
  readonly subGraphName: SubGraphNameV1 | null;
  readonly authorAddress: EvmAddressV1;
}

export interface AuthorAgentDelegationEvidenceV1 {
  readonly authorAddress: EvmAddressV1;
  readonly delegateeOpKey: EvmAddressV1;
  readonly delegateePeerId: string | null;
  readonly expiresAt: TimestampMsV1;
  readonly issuedAt: TimestampMsV1;
  readonly scope: string;
  readonly signature: string;
}

export interface VerifyAuthorCatalogRowAuthorshipInputV1 {
  readonly catalogIssuerDelegation: SignedAuthorCatalogIssuerDelegationEnvelopeV1;
  readonly catalogIssuerDelegationSignature: VerifiedControlEnvelopeIssuerSignatureV1;
  readonly parentAuthorAgentEvidence: AuthorAgentDelegationEvidenceV1 | null;
  readonly catalogHead: SignedAuthorCatalogHeadEnvelopeV1;
  readonly catalogHeadSignature: VerifiedControlEnvelopeIssuerSignatureV1;
  readonly directoryPathEnvelopes: readonly SignedAuthorCatalogDirectoryNodeEnvelopeV1[];
  readonly directoryPathSignatures: readonly VerifiedControlEnvelopeIssuerSignatureV1[];
  readonly directoryPathProof: VerifiedAuthorCatalogDirectoryPathV1;
  readonly catalogBucket: SignedAuthorCatalogBucketEnvelopeV1;
  readonly catalogBucketSignature: VerifiedControlEnvelopeIssuerSignatureV1;
  readonly targetKaId: KaIdV1;
}

declare const VERIFIED_AUTHOR_CATALOG_ROW_AUTHORSHIP_BRAND_V1: unique symbol;

/**
 * Process-local proof of only the exact author/catalog-key/signed-row closure.
 * The phantom type brand is not present on the runtime token.
 */
export interface VerifiedAuthorCatalogRowAuthorshipV1 {
  readonly [VERIFIED_AUTHOR_CATALOG_ROW_AUTHORSHIP_BRAND_V1]: true;
}

export interface VerifiedAuthorCatalogRowAuthorshipSnapshotV1 {
  readonly authorCatalogAgentScopeDigest: Digest32V1;
  readonly authorAuthorityEvidenceDigest: Digest32V1 | null;
  readonly catalogIssuerDelegationObjectDigest: Digest32V1;
  readonly catalogIssuerDelegationSignatureVariantDigest: Digest32V1;
  readonly catalogHeadObjectDigest: Digest32V1;
  readonly catalogHeadSignatureVariantDigest: Digest32V1;
  readonly directoryPathObjectDigests: readonly Digest32V1[];
  readonly directoryPathSignatureVariantDigests: readonly Digest32V1[];
  readonly bucketObjectDigest: Digest32V1;
  readonly bucketSignatureVariantDigest: Digest32V1;
  readonly catalogScopeDigest: Digest32V1;
  readonly catalogRowDigest: Digest32V1;
  readonly transferIdentityDigest: Digest32V1;
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly governanceChainId: ChainIdV1 | null;
  readonly governanceContractAddress: EvmAddressV1 | null;
  readonly ownershipTransitionDigest: Digest32V1 | null;
  readonly subGraphName: SubGraphNameV1 | null;
  readonly authorAddress: EvmAddressV1;
  readonly catalogIssuerKey: EvmAddressV1;
  readonly era: SignedAuthorCatalogHeadEnvelopeV1['payload']['era'];
  readonly version: SignedAuthorCatalogHeadEnvelopeV1['payload']['version'];
  readonly bucketId: SignedAuthorCatalogBucketEnvelopeV1['payload']['bucketId'];
  readonly effectiveAt: TimestampMsV1;
  readonly expiresAt: TimestampMsV1;
  readonly headIssuedAt: TimestampMsV1;
  readonly row: Readonly<AuthorCatalogRowV1>;
}

export const AUTHOR_CATALOG_ROW_AUTHORSHIP_ERROR_CODES_V1 = Object.freeze([
  'AUTHORSHIP_INPUT_INVALID',
  'AUTHORSHIP_DEPENDENCY_MISSING',
  'AUTHORSHIP_SIGNATURE_PROOF_INVALID',
  'AUTHORSHIP_PARENT_EVIDENCE_INVALID',
  'AUTHORSHIP_PARENT_DIGEST_MISMATCH',
  'AUTHORSHIP_PARENT_SCOPE_MISMATCH',
  'AUTHORSHIP_ISSUER_CLOSURE_MISMATCH',
  'AUTHORSHIP_INTERVAL_MISMATCH',
  'AUTHORSHIP_HEAD_BINDING_MISMATCH',
  'AUTHORSHIP_PATH_BINDING_MISMATCH',
  'AUTHORSHIP_BUCKET_BINDING_MISMATCH',
  'AUTHORSHIP_ROW_BINDING_MISMATCH',
  'AUTHORSHIP_CAPABILITY_INVALID',
] as const);

export type AuthorCatalogRowAuthorshipErrorCodeV1 =
  (typeof AUTHOR_CATALOG_ROW_AUTHORSHIP_ERROR_CODES_V1)[number];

export class AuthorCatalogRowAuthorshipErrorV1 extends Error {
  readonly code: AuthorCatalogRowAuthorshipErrorCodeV1;

  constructor(
    code: AuthorCatalogRowAuthorshipErrorCodeV1,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    if (!AUTHOR_CATALOG_ROW_AUTHORSHIP_ERROR_CODES_V1.includes(code)) {
      throw new TypeError(`Unsupported catalog-row authorship error code: ${String(code)}`);
    }
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AuthorCatalogRowAuthorshipErrorV1';
    this.code = code;
    Object.freeze(this);
  }
}

const VERIFIED_AUTHOR_CATALOG_ROW_AUTHORSHIPS_V1 = new WeakMap<
  object,
  VerifiedAuthorCatalogRowAuthorshipSnapshotV1
>();

/** Derive the exact seven-key logical lane scoped by a parent author delegation. */
export function deriveAuthorCatalogAgentScopeV1(
  delegation: SignedAuthorCatalogIssuerDelegationEnvelopeV1,
): Readonly<AuthorCatalogAgentScopeV1> {
  const snapshot = snapshotCatalogIssuerDelegation(delegation);
  const payload = snapshot.payload;
  return Object.freeze({
    authorAddress: payload.authorAddress,
    contextGraphId: payload.contextGraphId,
    governanceChainId: payload.governanceChainId,
    governanceContractAddress: payload.governanceContractAddress,
    networkId: payload.networkId,
    ownershipTransitionDigest: payload.ownershipTransitionDigest,
    subGraphName: payload.subGraphName,
  });
}

export function computeAuthorCatalogAgentScopeDigestV1(
  scope: AuthorCatalogAgentScopeV1,
): Digest32V1 {
  const snapshot = snapshotAuthorCatalogAgentScope(scope);
  return digestWithDomain(
    AUTHOR_CATALOG_AGENT_SCOPE_DOMAIN_BYTES_V1,
    UTF8.encode(canonicalizeStringRecord(snapshot)),
  );
}

export function buildAuthorCatalogAgentScopeV1(
  scope: AuthorCatalogAgentScopeV1,
): string {
  return `${AUTHOR_CATALOG_AGENT_SCOPE_PREFIX_V1}${computeAuthorCatalogAgentScopeDigestV1(scope).slice(2)}`;
}

export function computeAuthorAgentDelegationEvidenceDigestV1(
  evidence: AuthorAgentDelegationEvidenceV1,
): Digest32V1 {
  const snapshot = snapshotParentEvidence(evidence);
  return computeParentEvidenceDigestAfterSnapshot(snapshot);
}

/**
 * Close one exact signed catalog row under its author-authorized catalog key.
 * No policy, timeliness, history, finality, persistence, RDF, or activation work
 * is performed here.
 */
export function verifyAuthorCatalogRowAuthorshipV1(
  untrustedInput: VerifyAuthorCatalogRowAuthorshipInputV1,
): VerifiedAuthorCatalogRowAuthorshipV1 {
  const input = snapshotTopLevelInput(untrustedInput);
  const delegation = snapshotCatalogIssuerDelegation(input.catalogIssuerDelegation);
  const head = snapshotCatalogHead(input.catalogHead);
  const bucket = snapshotCatalogBucket(input.catalogBucket);
  const targetKaId = snapshotTargetKaId(input.targetKaId);

  // A canonical head caps directoryHeight at seven, so its exact root-to-leaf
  // path contains 1..8 nodes. Preflight BOTH attacker-controlled arrays before
  // canonicalizing a single envelope or opening a signature capability. This
  // keeps an oversized dense array from turning a structurally invalid proof
  // into unbounded parser/signature work before the core path verifier rejects
  // it.
  const expectedDirectoryPathLength = Number(BigInt(head.payload.directoryHeight) + 1n);
  assertOrdinaryArrayExactLength(
    input.directoryPathEnvelopes,
    'directoryPathEnvelopes',
    'AUTHORSHIP_PATH_BINDING_MISMATCH',
    expectedDirectoryPathLength,
  );
  assertOrdinaryArrayExactLength(
    input.directoryPathSignatures,
    'directoryPathSignatures',
    'AUTHORSHIP_PATH_BINDING_MISMATCH',
    expectedDirectoryPathLength,
  );

  const directoryEnvelopes = snapshotDirectoryPath(
    input.directoryPathEnvelopes,
    head.payload.bucketCount,
    expectedDirectoryPathLength,
  );
  const directorySignatureProofs = snapshotProofArray(
    input.directoryPathSignatures,
    'directoryPathSignatures',
    expectedDirectoryPathLength,
  );

  const delegationSignature = bindExactSignatureProof(
    input.catalogIssuerDelegationSignature,
    delegation,
  );
  const headSignature = bindExactSignatureProof(input.catalogHeadSignature, head);
  const bucketSignature = bindExactSignatureProof(input.catalogBucketSignature, bucket);
  const directorySignatures = directoryEnvelopes.map((envelope, index) => {
    try {
      return bindExactSignatureProof(directorySignatureProofs[index], envelope);
    } catch (cause) {
      if (
        cause instanceof AuthorCatalogRowAuthorshipErrorV1
        && cause.code === 'AUTHORSHIP_SIGNATURE_PROOF_INVALID'
      ) {
        fail(
          'AUTHORSHIP_PATH_BINDING_MISMATCH',
          `directory path signature proof ${index} is not bound to its exact node`,
          cause,
        );
      }
      throw cause;
    }
  });

  const delegationPayload = delegation.payload;
  const agentScope = snapshotAuthorCatalogAgentScope({
    authorAddress: delegationPayload.authorAddress,
    contextGraphId: delegationPayload.contextGraphId,
    governanceChainId: delegationPayload.governanceChainId,
    governanceContractAddress: delegationPayload.governanceContractAddress,
    networkId: delegationPayload.networkId,
    ownershipTransitionDigest: delegationPayload.ownershipTransitionDigest,
    subGraphName: delegationPayload.subGraphName,
  });
  const authorCatalogAgentScopeDigest = computeAuthorCatalogAgentScopeDigestV1(agentScope);
  const expectedAgentScope =
    `${AUTHOR_CATALOG_AGENT_SCOPE_PREFIX_V1}${authorCatalogAgentScopeDigest.slice(2)}`;

  const issuerIsAuthor = delegation.issuer === delegationPayload.authorAddress;
  const evidenceDigest = delegationPayload.authorAuthorityEvidenceDigest;
  if (issuerIsAuthor) {
    if (evidenceDigest !== null || input.parentAuthorAgentEvidence !== null) {
      fail(
        'AUTHORSHIP_ISSUER_CLOSURE_MISMATCH',
        'direct author issuance requires null evidence and no parent evidence object',
      );
    }
  } else {
    if (evidenceDigest === null) {
      fail(
        'AUTHORSHIP_ISSUER_CLOSURE_MISMATCH',
        'delegated issuance must name exact parent author-agent evidence',
      );
    }
    if (input.parentAuthorAgentEvidence === null) {
      fail(
        'AUTHORSHIP_DEPENDENCY_MISSING',
        'the referenced parent author-agent evidence object is unavailable',
      );
    }
    const parent = snapshotParentEvidence(input.parentAuthorAgentEvidence);
    if (computeParentEvidenceDigestAfterSnapshot(parent) !== evidenceDigest) {
      fail(
        'AUTHORSHIP_PARENT_DIGEST_MISMATCH',
        'parent author-agent evidence does not hash to the delegated reference',
      );
    }
    verifyParentEvidenceSignature(parent);
    if (
      parent.authorAddress !== delegationPayload.authorAddress
      || parent.scope !== expectedAgentScope
    ) {
      fail(
        'AUTHORSHIP_PARENT_SCOPE_MISMATCH',
        'parent evidence is not scoped to the exact author, CG, governance tuple, and lane',
      );
    }
    if (
      parent.delegateeOpKey !== delegation.issuer
      || parent.delegateeOpKey !== delegationPayload.catalogIssuerKey
    ) {
      fail(
        'AUTHORSHIP_ISSUER_CLOSURE_MISMATCH',
        'parent operational key, delegation issuer, and selected catalog key must match',
      );
    }
    if (
      BigInt(parent.issuedAt) > BigInt(delegationPayload.effectiveAt)
      || BigInt(delegationPayload.effectiveAt) >= BigInt(delegationPayload.expiresAt)
      || BigInt(delegationPayload.expiresAt) > BigInt(parent.expiresAt)
    ) {
      fail(
        'AUTHORSHIP_INTERVAL_MISMATCH',
        'catalog issuer interval is not contained in the parent half-open interval',
      );
    }
  }

  if (!issuerIsAuthor && delegation.issuer !== delegationPayload.catalogIssuerKey) {
    fail(
      'AUTHORSHIP_ISSUER_CLOSURE_MISMATCH',
      'a delegated issuer may nominate only its own operational key as catalogIssuerKey',
    );
  }

  assertHeadBinding(delegation, head);
  const catalogIssuerKey = delegationPayload.catalogIssuerKey;
  if (
    head.issuer !== catalogIssuerKey
    || bucket.issuer !== catalogIssuerKey
    || directoryEnvelopes.some((envelope) => envelope.issuer !== catalogIssuerKey)
  ) {
    fail(
      'AUTHORSHIP_HEAD_BINDING_MISMATCH',
      'head, directory path, and bucket must all be signed by the exact catalog issuer key',
    );
  }

  const headIssuedAt = BigInt(head.payload.issuedAt);
  if (
    headIssuedAt < BigInt(delegationPayload.effectiveAt)
    || headIssuedAt >= BigInt(delegationPayload.expiresAt)
  ) {
    fail(
      'AUTHORSHIP_INTERVAL_MISMATCH',
      'catalog head issuedAt is outside the child half-open interval',
    );
  }

  const scope = deriveAuthorCatalogScopeFromHeadV1(head.payload);
  const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(scope);
  const selectedBucketId = catalogKeyToBucketIdV1(targetKaId, scope.bucketCount);
  const descriptor = readBoundPathDescriptor(
    input.directoryPathProof,
    head,
    directoryEnvelopes,
    selectedBucketId,
  );
  if (descriptor.rowCount === '0' || descriptor.byteLength === '0') {
    fail(
      'AUTHORSHIP_BUCKET_BINDING_MISMATCH',
      'an authorship proof requires a non-empty selected bucket descriptor',
    );
  }

  const bucketPayloadBytes = canonicalizeAuthorCatalogBucketPayloadBytesV1(bucket.payload);
  if (
    descriptor.bucketDigest !== bucket.objectDigest
    || descriptor.bucketId !== bucket.payload.bucketId
    || descriptor.bucketId !== selectedBucketId
    || BigInt(descriptor.byteLength) !== BigInt(bucketPayloadBytes.byteLength)
    || BigInt(descriptor.rowCount) !== BigInt(bucket.payload.rows.length)
  ) {
    fail(
      'AUTHORSHIP_BUCKET_BINDING_MISMATCH',
      'signed leaf descriptor does not exactly describe the supplied signed bucket',
    );
  }
  try {
    assertAuthorCatalogBucketScopeBindingV1(bucket.payload, scope);
  } catch (cause) {
    fail(
      isPackedAuthorFailure(cause)
        ? 'AUTHORSHIP_ROW_BINDING_MISMATCH'
        : 'AUTHORSHIP_BUCKET_BINDING_MISMATCH',
      'signed bucket does not match the head-derived scope or packed author lane',
      cause,
    );
  }

  const matchingRows = bucket.payload.rows.filter((row) => row.kaId === targetKaId);
  if (matchingRows.length !== 1) {
    fail(
      'AUTHORSHIP_ROW_BINDING_MISMATCH',
      'target kaId must occur exactly once in its mathematically derived bucket',
    );
  }
  const row = snapshotCatalogRow(matchingRows[0]);
  if ((BigInt(row.kaId) >> 96n) !== BigInt(head.payload.authorAddress)) {
    fail(
      'AUTHORSHIP_ROW_BINDING_MISMATCH',
      'target kaId high 160 bits do not equal the signed head author',
    );
  }
  const catalogRowDigest = computeAuthorCatalogRowDigestV1(catalogScopeDigest, row);
  const transferIdentityDigest = computeKaTransferIdentityDigestV1(row.transfer);

  return mintVerifiedAuthorship({
    authorCatalogAgentScopeDigest,
    authorAuthorityEvidenceDigest: evidenceDigest,
    catalogIssuerDelegationObjectDigest: delegation.objectDigest as Digest32V1,
    catalogIssuerDelegationSignatureVariantDigest: delegationSignature.signatureVariantDigest,
    catalogHeadObjectDigest: head.objectDigest as Digest32V1,
    catalogHeadSignatureVariantDigest: headSignature.signatureVariantDigest,
    directoryPathObjectDigests: Object.freeze(
      directoryEnvelopes.map((envelope) => envelope.objectDigest as Digest32V1),
    ),
    directoryPathSignatureVariantDigests: Object.freeze(
      directorySignatures.map((signature) => signature.signatureVariantDigest),
    ),
    bucketObjectDigest: bucket.objectDigest as Digest32V1,
    bucketSignatureVariantDigest: bucketSignature.signatureVariantDigest,
    catalogScopeDigest,
    catalogRowDigest,
    transferIdentityDigest,
    networkId: head.payload.networkId,
    contextGraphId: head.payload.contextGraphId,
    governanceChainId: head.payload.governanceChainId,
    governanceContractAddress: head.payload.governanceContractAddress,
    ownershipTransitionDigest: head.payload.ownershipTransitionDigest,
    subGraphName: head.payload.subGraphName,
    authorAddress: head.payload.authorAddress,
    catalogIssuerKey,
    era: head.payload.era,
    version: head.payload.version,
    bucketId: bucket.payload.bucketId,
    effectiveAt: delegationPayload.effectiveAt,
    expiresAt: delegationPayload.expiresAt,
    headIssuedAt: head.payload.issuedAt,
    row,
  });
}

export function assertVerifiedAuthorCatalogRowAuthorshipV1(
  value: unknown,
): asserts value is VerifiedAuthorCatalogRowAuthorshipV1 {
  if (
    (typeof value !== 'object' && typeof value !== 'function')
    || value === null
    || !VERIFIED_AUTHOR_CATALOG_ROW_AUTHORSHIPS_V1.has(value as object)
  ) {
    fail(
      'AUTHORSHIP_CAPABILITY_INVALID',
      'catalog-row authorship capability was not minted by this verifier',
    );
  }
}

export function assertVerifiedAuthorCatalogRowAuthorshipForTargetV1(
  value: unknown,
  catalogRowDigest: Digest32V1,
  transferIdentityDigest: Digest32V1,
): asserts value is VerifiedAuthorCatalogRowAuthorshipV1 {
  assertVerifiedAuthorCatalogRowAuthorshipV1(value);
  try {
    assertCanonicalDigest(catalogRowDigest, 'catalogRowDigest');
    assertCanonicalDigest(transferIdentityDigest, 'transferIdentityDigest');
  } catch (cause) {
    fail('AUTHORSHIP_CAPABILITY_INVALID', 'authorship target digests are not canonical', cause);
  }
  const snapshot = VERIFIED_AUTHOR_CATALOG_ROW_AUTHORSHIPS_V1.get(value as object)!;
  if (
    snapshot.catalogRowDigest !== catalogRowDigest
    || snapshot.transferIdentityDigest !== transferIdentityDigest
  ) {
    fail(
      'AUTHORSHIP_CAPABILITY_INVALID',
      'catalog-row authorship capability is bound to different target digests',
    );
  }
}

export function readVerifiedAuthorCatalogRowAuthorshipV1(
  value: unknown,
): VerifiedAuthorCatalogRowAuthorshipSnapshotV1 {
  assertVerifiedAuthorCatalogRowAuthorshipV1(value);
  return VERIFIED_AUTHOR_CATALOG_ROW_AUTHORSHIPS_V1.get(value as object)!;
}

/**
 * Expand one fully verified row capability across the other rows in the exact
 * same signed bucket. The anchor already closes the delegation, head, path,
 * bucket signature, scope, and packed-author binding for the bucket object.
 * Requiring the identical bucket digest makes it safe to avoid repeating that
 * fixed proof for every row while retaining row-specific digest capabilities.
 */
export function deriveVerifiedAuthorCatalogBucketRowAuthorshipsV1(
  anchor: unknown,
  catalogBucket: SignedAuthorCatalogBucketEnvelopeV1,
): readonly VerifiedAuthorCatalogRowAuthorshipV1[] {
  assertVerifiedAuthorCatalogRowAuthorshipV1(anchor);
  const anchorSnapshot = VERIFIED_AUTHOR_CATALOG_ROW_AUTHORSHIPS_V1.get(anchor as object)!;
  const bucket = snapshotCatalogBucket(catalogBucket);
  if (
    bucket.objectDigest !== anchorSnapshot.bucketObjectDigest
    || bucket.payload.bucketId !== anchorSnapshot.bucketId
    || !bucket.payload.rows.some((row) => (
      computeAuthorCatalogRowDigestV1(anchorSnapshot.catalogScopeDigest, row)
      === anchorSnapshot.catalogRowDigest
    ))
  ) {
    fail(
      'AUTHORSHIP_BUCKET_BINDING_MISMATCH',
      'bulk authorship derivation requires the anchor\'s exact signed bucket',
    );
  }
  return Object.freeze(bucket.payload.rows.map((candidate) => {
    const row = snapshotCatalogRow(candidate);
    if ((BigInt(row.kaId) >> 96n) !== BigInt(anchorSnapshot.authorAddress)) {
      fail(
        'AUTHORSHIP_ROW_BINDING_MISMATCH',
        'bulk authorship row high 160 bits do not equal the verified bucket author',
      );
    }
    return mintVerifiedAuthorship({
      ...anchorSnapshot,
      catalogRowDigest: computeAuthorCatalogRowDigestV1(
        anchorSnapshot.catalogScopeDigest,
        row,
      ),
      transferIdentityDigest: computeKaTransferIdentityDigestV1(row.transfer),
      row,
    });
  }));
}

function snapshotTopLevelInput(
  input: VerifyAuthorCatalogRowAuthorshipInputV1,
): VerifyAuthorCatalogRowAuthorshipInputV1 {
  if (!isPlainRecord(input)) {
    fail('AUTHORSHIP_INPUT_INVALID', 'authorship input must be a plain object');
  }
  const expected = [
    'catalogBucket',
    'catalogBucketSignature',
    'catalogHead',
    'catalogHeadSignature',
    'catalogIssuerDelegation',
    'catalogIssuerDelegationSignature',
    'directoryPathEnvelopes',
    'directoryPathProof',
    'directoryPathSignatures',
    'parentAuthorAgentEvidence',
    'targetKaId',
  ];
  const actual = Reflect.ownKeys(input);
  if (actual.some((key) => typeof key !== 'string')) {
    fail('AUTHORSHIP_INPUT_INVALID', 'authorship input must not contain symbol fields');
  }
  const actualStrings = actual as string[];
  if (actualStrings.some((key) => !expected.includes(key))) {
    fail('AUTHORSHIP_INPUT_INVALID', 'authorship input contains unknown fields');
  }
  const missing = expected.filter((key) => !actualStrings.includes(key));
  if (missing.length > 0) {
    const code = missing.every((key) => key !== 'targetKaId')
      ? 'AUTHORSHIP_DEPENDENCY_MISSING'
      : 'AUTHORSHIP_INPUT_INVALID';
    fail(code, `authorship input is missing ${missing.join(', ')}`);
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail('AUTHORSHIP_INPUT_INVALID', `authorship input ${key} must be an enumerable data field`);
    }
    snapshot[key] = descriptor.value;
  }
  for (const key of expected) {
    if (key !== 'parentAuthorAgentEvidence' && key !== 'targetKaId' && snapshot[key] == null) {
      fail('AUTHORSHIP_DEPENDENCY_MISSING', `authorship dependency ${key} is unavailable`);
    }
  }
  return Object.freeze(snapshot) as unknown as VerifyAuthorCatalogRowAuthorshipInputV1;
}

function snapshotCatalogIssuerDelegation(
  input: SignedAuthorCatalogIssuerDelegationEnvelopeV1,
): SignedAuthorCatalogIssuerDelegationEnvelopeV1 {
  try {
    return deepFreezeJson(parseCanonicalSignedAuthorCatalogIssuerDelegationEnvelopeV1(
      canonicalizeSignedAuthorCatalogIssuerDelegationEnvelopeBytesV1(input),
    )) as SignedAuthorCatalogIssuerDelegationEnvelopeV1;
  } catch (cause) {
    if (
      cause instanceof AuthorCatalogAuthorityCodecError
      && cause.code === 'catalog-authority-authority'
    ) {
      fail(
        'AUTHORSHIP_ISSUER_CLOSURE_MISMATCH',
        'catalog issuer delegation has an invalid direct/delegated evidence branch',
        cause,
      );
    }
    if (
      cause instanceof AuthorCatalogAuthorityCodecError
      && cause.code === 'catalog-authority-time'
    ) {
      fail('AUTHORSHIP_INTERVAL_MISMATCH', 'catalog issuer interval is invalid', cause);
    }
    fail('AUTHORSHIP_INPUT_INVALID', 'catalog issuer delegation is invalid', cause);
  }
}

function snapshotCatalogHead(
  input: SignedAuthorCatalogHeadEnvelopeV1,
): SignedAuthorCatalogHeadEnvelopeV1 {
  try {
    return deepFreezeJson(parseCanonicalSignedAuthorCatalogHeadEnvelopeV1(
      canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1(input),
    )) as SignedAuthorCatalogHeadEnvelopeV1;
  } catch (cause) {
    fail('AUTHORSHIP_INPUT_INVALID', 'catalog head is invalid', cause);
  }
}

function snapshotCatalogBucket(
  input: SignedAuthorCatalogBucketEnvelopeV1,
): SignedAuthorCatalogBucketEnvelopeV1 {
  try {
    return deepFreezeJson(parseCanonicalSignedAuthorCatalogBucketEnvelopeV1(
      canonicalizeSignedAuthorCatalogBucketEnvelopeBytesV1(input),
    )) as SignedAuthorCatalogBucketEnvelopeV1;
  } catch (cause) {
    if (
      cause instanceof AuthorCatalogObjectCodecError
      && [
        'catalog-object-bucket-mapping',
        'catalog-object-duplicate',
        'catalog-object-row-order',
      ].includes(cause.code)
    ) {
      fail('AUTHORSHIP_ROW_BINDING_MISMATCH', 'catalog bucket row closure is invalid', cause);
    }
    fail('AUTHORSHIP_INPUT_INVALID', 'catalog bucket is invalid', cause);
  }
}

function snapshotDirectoryPath(
  input: readonly SignedAuthorCatalogDirectoryNodeEnvelopeV1[],
  bucketCount: SignedAuthorCatalogHeadEnvelopeV1['payload']['bucketCount'],
  expectedLength: number,
): readonly SignedAuthorCatalogDirectoryNodeEnvelopeV1[] {
  const values = snapshotDenseOrdinaryArray(
    input,
    'directoryPathEnvelopes',
    'AUTHORSHIP_PATH_BINDING_MISMATCH',
    expectedLength,
  );
  const snapshots = values.map((envelope) => {
    try {
      return deepFreezeJson(parseCanonicalSignedAuthorCatalogDirectoryNodeEnvelopeV1(
        canonicalizeSignedAuthorCatalogDirectoryNodeEnvelopeBytesV1(
          envelope as SignedAuthorCatalogDirectoryNodeEnvelopeV1,
          bucketCount,
        ),
        bucketCount,
      )) as SignedAuthorCatalogDirectoryNodeEnvelopeV1;
    } catch (cause) {
      fail('AUTHORSHIP_PATH_BINDING_MISMATCH', 'directory path envelope is invalid', cause);
    }
  });
  return Object.freeze(snapshots);
}

function snapshotProofArray(
  input: readonly VerifiedControlEnvelopeIssuerSignatureV1[],
  label: string,
  expectedLength: number,
): readonly VerifiedControlEnvelopeIssuerSignatureV1[] {
  return Object.freeze(snapshotDenseOrdinaryArray(
    input,
    label,
    'AUTHORSHIP_PATH_BINDING_MISMATCH',
    expectedLength,
  ) as VerifiedControlEnvelopeIssuerSignatureV1[]);
}

function snapshotTargetKaId(input: KaIdV1): KaIdV1 {
  try {
    assertCanonicalKaId(input, 'targetKaId');
    return input;
  } catch (cause) {
    fail('AUTHORSHIP_INPUT_INVALID', 'targetKaId is not canonical', cause);
  }
}

function snapshotCatalogRow(row: AuthorCatalogRowV1): Readonly<AuthorCatalogRowV1> {
  try {
    return deepFreezeJson(
      parseCanonicalAuthorCatalogRowV1(canonicalizeAuthorCatalogRowV1(row)),
    ) as Readonly<AuthorCatalogRowV1>;
  } catch (cause) {
    fail('AUTHORSHIP_ROW_BINDING_MISMATCH', 'target row is invalid', cause);
  }
}

function snapshotAuthorCatalogAgentScope(
  input: AuthorCatalogAgentScopeV1,
): Readonly<AuthorCatalogAgentScopeV1> {
  if (!isPlainRecord(input)) {
    fail('AUTHORSHIP_INPUT_INVALID', 'author catalog agent scope must be a plain object');
  }
  const values = exactPrimitiveDataSnapshot(input, [
    'authorAddress',
    'contextGraphId',
    'governanceChainId',
    'governanceContractAddress',
    'networkId',
    'ownershipTransitionDigest',
    'subGraphName',
  ], 'author catalog agent scope', 'AUTHORSHIP_INPUT_INVALID');
  try {
    assertEvmAddress(values.authorAddress, 'authorAddress');
    assertNetworkIdV1(values.networkId, 'networkId');
    assertContextGraphIdV1(values.contextGraphId, 'contextGraphId');
    const chainIsNull = values.governanceChainId === null;
    const contractIsNull = values.governanceContractAddress === null;
    if (chainIsNull !== contractIsNull) throw new Error('governance tuple must be jointly null');
    if (!contractIsNull) {
      assertCanonicalChainId(values.governanceChainId, 'governanceChainId');
      assertEvmAddress(values.governanceContractAddress, 'governanceContractAddress');
    }
    if (values.ownershipTransitionDigest !== null) {
      assertCanonicalDigest(values.ownershipTransitionDigest, 'ownershipTransitionDigest');
    }
    if (values.subGraphName !== null) assertSubGraphNameV1(values.subGraphName, 'subGraphName');
  } catch (cause) {
    fail('AUTHORSHIP_INPUT_INVALID', 'author catalog agent scope is invalid', cause);
  }
  return Object.freeze(values) as unknown as Readonly<AuthorCatalogAgentScopeV1>;
}

function snapshotParentEvidence(
  input: AuthorAgentDelegationEvidenceV1,
): Readonly<AuthorAgentDelegationEvidenceV1> {
  if (!isPlainRecord(input)) {
    fail('AUTHORSHIP_PARENT_EVIDENCE_INVALID', 'parent evidence must be a plain object');
  }
  const values = exactPrimitiveDataSnapshot(input, [
    'authorAddress',
    'delegateeOpKey',
    'delegateePeerId',
    'expiresAt',
    'issuedAt',
    'scope',
    'signature',
  ], 'parent author-agent evidence', 'AUTHORSHIP_PARENT_EVIDENCE_INVALID');
  try {
    assertEvmAddress(values.authorAddress, 'authorAddress');
    assertEvmAddress(values.delegateeOpKey, 'delegateeOpKey');
    if (values.delegateePeerId !== null) {
      assertPeerId(values.delegateePeerId);
    }
    if (typeof values.scope !== 'string' || values.scope.length === 0) {
      throw new Error('scope must be a non-empty string');
    }
    if (values.scope.length > MAX_AUTHOR_AGENT_DELEGATION_EVIDENCE_BYTES_V1) {
      throw new Error('scope exceeds the parent evidence byte ceiling');
    }
    assertWellFormedUnicode(values.scope, 'scope');
    if (typeof values.signature !== 'string' || !/^0x[0-9a-f]{130}$/.test(values.signature)) {
      throw new Error('signature must be a canonical lowercase 65-byte hex string');
    }
    const issuedAt = assertFinitePositiveTimestamp(values.issuedAt, 'issuedAt');
    const expiresAt = assertFinitePositiveTimestamp(values.expiresAt, 'expiresAt');
    if (issuedAt >= expiresAt) throw new Error('issuedAt must be strictly earlier than expiresAt');
  } catch (cause) {
    fail('AUTHORSHIP_PARENT_EVIDENCE_INVALID', 'parent evidence is invalid', cause);
  }
  const snapshot = Object.freeze(values) as unknown as Readonly<AuthorAgentDelegationEvidenceV1>;
  if (UTF8.encode(canonicalizeStringRecord(snapshot)).byteLength > MAX_AUTHOR_AGENT_DELEGATION_EVIDENCE_BYTES_V1) {
    fail(
      'AUTHORSHIP_PARENT_EVIDENCE_INVALID',
      `parent evidence exceeds ${MAX_AUTHOR_AGENT_DELEGATION_EVIDENCE_BYTES_V1} canonical bytes`,
    );
  }
  return snapshot;
}

function computeParentEvidenceDigestAfterSnapshot(
  evidence: Readonly<AuthorAgentDelegationEvidenceV1>,
): Digest32V1 {
  return digestWithDomain(
    AUTHOR_AGENT_EVIDENCE_DOMAIN_BYTES_V1,
    UTF8.encode(canonicalizeStringRecord(evidence)),
  );
}

function verifyParentEvidenceSignature(
  evidence: Readonly<AuthorAgentDelegationEvidenceV1>,
): void {
  try {
    const r = BigInt(`0x${evidence.signature.slice(2, 66)}`);
    const s = BigInt(`0x${evidence.signature.slice(66, 130)}`);
    const v = evidence.signature.slice(130, 132);
    if (
      (v !== '1b' && v !== '1c')
      || r < 1n
      || r >= SECP256K1_N
      || s < 1n
      || s > SECP256K1_HALF_N
    ) {
      throw new Error('parent signature must use canonical r, low-s, and v=27/28');
    }
    const digest = computeDelegationDigest({
      agentAddress: evidence.authorAddress,
      scope: evidence.scope,
      issuedAtMs: Number(evidence.issuedAt),
      expiresAtMs: Number(evidence.expiresAt),
      delegateePeerId: evidence.delegateePeerId ?? undefined,
      delegateeOpKey: evidence.delegateeOpKey,
    });
    const recovered = ethers.verifyMessage(digest, evidence.signature).toLowerCase();
    if (recovered !== evidence.authorAddress) {
      throw new Error('parent signature does not recover the canonical author');
    }
  } catch (cause) {
    fail(
      'AUTHORSHIP_PARENT_EVIDENCE_INVALID',
      'parent author-agent evidence signature is invalid',
      cause,
    );
  }
}

function bindExactSignatureProof(
  proof: VerifiedControlEnvelopeIssuerSignatureV1,
  envelope: {
    readonly objectDigest: string;
    readonly issuer: string;
    readonly signatureSuite: string;
    readonly signature: string;
  },
): VerifiedControlEnvelopeIssuerSignatureSnapshotV1 {
  let snapshot: VerifiedControlEnvelopeIssuerSignatureSnapshotV1;
  try {
    snapshot = readVerifiedControlEnvelopeIssuerSignatureV1(proof);
  } catch (cause) {
    fail(
      'AUTHORSHIP_SIGNATURE_PROOF_INVALID',
      'signature proof was not minted by the generic verifier',
      cause,
    );
  }
  if (
    snapshot.objectDigest !== envelope.objectDigest
    || snapshot.issuer !== envelope.issuer
    || snapshot.signatureSuite !== envelope.signatureSuite
    || snapshot.signatureVariantDigest
      !== computeControlSignatureVariantDigestHex(envelope.objectDigest, envelope.signature)
  ) {
    fail(
      'AUTHORSHIP_SIGNATURE_PROOF_INVALID',
      'signature proof is bound to another control envelope',
    );
  }
  return snapshot;
}

function assertHeadBinding(
  delegation: SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  head: SignedAuthorCatalogHeadEnvelopeV1,
): void {
  const left = delegation.payload;
  const right = head.payload;
  if (
    right.networkId !== left.networkId
    || right.contextGraphId !== left.contextGraphId
    || right.governanceChainId !== left.governanceChainId
    || right.governanceContractAddress !== left.governanceContractAddress
    || right.ownershipTransitionDigest !== left.ownershipTransitionDigest
    || right.subGraphName !== left.subGraphName
    || right.authorAddress !== left.authorAddress
    || right.era !== left.catalogEra
    || right.catalogIssuerDelegationDigest !== delegation.objectDigest
  ) {
    fail(
      'AUTHORSHIP_HEAD_BINDING_MISMATCH',
      'catalog head does not bind the exact issuer delegation scope, era, and digest',
    );
  }
}

function readBoundPathDescriptor(
  proof: VerifiedAuthorCatalogDirectoryPathV1,
  head: SignedAuthorCatalogHeadEnvelopeV1,
  path: readonly SignedAuthorCatalogDirectoryNodeEnvelopeV1[],
  selectedBucketId: SignedAuthorCatalogBucketEnvelopeV1['payload']['bucketId'],
) {
  try {
    const supplied = readVerifiedAuthorCatalogBucketDescriptorV1(proof, head);
    const recomputedProof = verifyAuthorCatalogDirectoryPathV1(head, path, selectedBucketId);
    const recomputed = readVerifiedAuthorCatalogBucketDescriptorV1(recomputedProof, head);
    if (
      supplied.bucketDigest !== recomputed.bucketDigest
      || supplied.bucketId !== recomputed.bucketId
      || supplied.byteLength !== recomputed.byteLength
      || supplied.rowCount !== recomputed.rowCount
      || supplied.bucketId !== selectedBucketId
    ) {
      fail(
        'AUTHORSHIP_PATH_BINDING_MISMATCH',
        'structural path proof is not bound to the supplied head, path, and selected bucket',
      );
    }
    return supplied;
  } catch (cause) {
    if (cause instanceof AuthorCatalogRowAuthorshipErrorV1) throw cause;
    fail(
      'AUTHORSHIP_PATH_BINDING_MISMATCH',
      'directory path proof or root-to-leaf closure is invalid',
      cause,
    );
  }
}

function mintVerifiedAuthorship(
  snapshot: VerifiedAuthorCatalogRowAuthorshipSnapshotV1,
): VerifiedAuthorCatalogRowAuthorshipV1 {
  const immutable = deepFreezeJson({ ...snapshot }) as VerifiedAuthorCatalogRowAuthorshipSnapshotV1;
  const capability = Object.freeze(
    Object.create(null),
  ) as VerifiedAuthorCatalogRowAuthorshipV1;
  VERIFIED_AUTHOR_CATALOG_ROW_AUTHORSHIPS_V1.set(capability as object, immutable);
  return capability;
}

function exactPrimitiveDataSnapshot(
  input: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
  code: AuthorCatalogRowAuthorshipErrorCodeV1,
): Readonly<Record<string, unknown>> {
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== 'string')
    || keys.length !== expectedKeys.length
    || (keys as string[]).sort().some((key, index) => key !== [...expectedKeys].sort()[index])
  ) {
    fail(code, `${label} has unknown or missing fields`);
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(code, `${label} fields must be enumerable data properties`);
    }
    const value = descriptor.value;
    if (value !== null && typeof value !== 'string') {
      fail(code, `${label}.${key} must be a string or null`);
    }
    snapshot[key] = value;
  }
  return Object.freeze(snapshot);
}

function canonicalizeStringRecord(value: Readonly<Record<string, unknown>>): string {
  const ordered: Record<string, string | null> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item !== null && typeof item !== 'string') {
      throw new TypeError('canonical authorship records contain only strings and null');
    }
    ordered[key] = item;
  }
  return JSON.stringify(ordered);
}

function snapshotDenseOrdinaryArray(
  value: unknown,
  label: string,
  code: AuthorCatalogRowAuthorshipErrorCodeV1,
  expectedLength?: number,
): unknown[] {
  assertOrdinaryArrayExactLength(value, label, code, expectedLength);
  const length = (Object.getOwnPropertyDescriptor(value, 'length')!.value as number);
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== 'string')
    || keys.length !== length + 1
  ) {
    fail(code, `${label} must be dense and contain no custom fields`);
  }
  const snapshot: unknown[] = new Array(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(code, `${label}[${index}] must be an enumerable data field`);
    }
    snapshot[index] = descriptor.value;
  }
  return snapshot;
}

function assertOrdinaryArrayExactLength(
  value: unknown,
  label: string,
  code: AuthorCatalogRowAuthorshipErrorCodeV1,
  expectedLength?: number,
): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail(code, `${label} must be an ordinary dense array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    !lengthDescriptor
    || lengthDescriptor.enumerable
    || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
    || typeof lengthDescriptor.value !== 'number'
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    fail(code, `${label}.length must be an ordinary array data field`);
  }
  const length = lengthDescriptor.value;
  if (expectedLength !== undefined && length !== expectedLength) {
    fail(
      code,
      `${label} must contain exactly ${expectedLength} values for the signed directory height`,
    );
  }
}

function assertFinitePositiveTimestamp(value: unknown, label: string): bigint {
  const parsed = parseCanonicalDecimalU64(value, label);
  if (parsed < 1n || parsed > MAX_AUTHOR_AGENT_DELEGATION_TIMESTAMP_V1) {
    throw new Error(`${label} must be in 1..${MAX_AUTHOR_AGENT_DELEGATION_TIMESTAMP_V1}`);
  }
  return parsed;
}

function assertPeerId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('delegateePeerId must be null or a non-empty string');
  }
  assertWellFormedUnicode(value, 'delegateePeerId');
  const bytes = UTF8.encode(value).byteLength;
  if (bytes < 1 || bytes > MAX_AUTHOR_AGENT_DELEGATEE_PEER_ID_BYTES_V1) {
    throw new Error('delegateePeerId exceeds its UTF-8 byte limit');
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      throw new Error('delegateePeerId contains C0/DEL control data');
    }
  }
}

function assertEvmAddress(value: unknown, label: string): asserts value is EvmAddressV1 {
  if (
    typeof value !== 'string'
    || !/^0x[0-9a-f]{40}$/.test(value)
    || value === '0x0000000000000000000000000000000000000000'
  ) {
    throw new Error(`${label} is not a canonical nonzero EVM address`);
  }
}

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) throw new Error(`${label} contains an unpaired surrogate`);
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        throw new Error(`${label} contains an unpaired surrogate`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error(`${label} contains an unpaired surrogate`);
    }
  }
}

function digestWithDomain(domain: Uint8Array, payload: Uint8Array): Digest32V1 {
  const hasher = sha256.create();
  hasher.update(domain);
  hasher.update(payload);
  const digest = `0x${Array.from(hasher.digest(), (byte) =>
    byte.toString(16).padStart(2, '0')).join('')}`;
  assertCanonicalDigest(digest, 'authorship digest');
  return digest;
}

function deepFreezeJson<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
  } else {
    for (const item of Object.values(value)) deepFreezeJson(item);
  }
  return Object.freeze(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPackedAuthorFailure(cause: unknown): boolean {
  return (
    cause !== null
    && typeof cause === 'object'
    && 'code' in cause
    && cause.code === 'catalog-packed-author-mismatch'
  );
}

function fail(
  code: AuthorCatalogRowAuthorshipErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new AuthorCatalogRowAuthorshipErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
