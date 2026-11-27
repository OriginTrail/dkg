// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical direct-author catalog-issuer delegation bootstrap.
 *
 * A genesis catalog head is not authoritative merely because its EIP-191
 * signature recovers an EOA.  It must name an exact, signed issuer delegation
 * whose scope and half-open validity interval authorize that same catalog key.
 * This producer closes that dependency before any durable publication occurs.
 */

import {
  AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
  assertAuthorCatalogScopeV1,
  assertCanonicalTimestampMs,
  canonicalizeSignedAuthorCatalogIssuerDelegationEnvelopeBytesV1,
  computeAuthorCatalogIssuerDelegationObjectDigestV1,
  parseCanonicalSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  type AuthorCatalogIssuerDelegationV1,
  type AuthorCatalogScopeV1,
  type SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  type TimestampMsV1,
  type UnsignedAuthorCatalogIssuerDelegationEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  readVerifiedControlEnvelopeIssuerSignatureV1,
  verifyControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';

import type { Rfc64AuthorCatalogEip191SignerV1 } from './author-catalog-producer.js';
import type { Rfc64PublicCatalogIssuerAuthorizationV1 } from './public-catalog-successor-producer-v1.js';

export type Rfc64DirectCatalogIssuerDelegationErrorCodeV1 =
  | 'catalog-delegation-input'
  | 'catalog-delegation-scope'
  | 'catalog-delegation-time'
  | 'catalog-delegation-signer';

export class Rfc64DirectCatalogIssuerDelegationErrorV1 extends Error {
  constructor(
    readonly code: Rfc64DirectCatalogIssuerDelegationErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64DirectCatalogIssuerDelegationErrorV1';
  }
}

export interface ProduceDirectAuthorCatalogIssuerDelegationInputV1 {
  /** Exact catalog lane later copied into the genesis head. */
  readonly scope: AuthorCatalogScopeV1;
  /** The direct author and selected catalog issuer are this same EOA. */
  readonly signer: Rfc64AuthorCatalogEip191SignerV1;
  readonly effectiveAt: TimestampMsV1;
  readonly expiresAt: TimestampMsV1;
  /** Genesis head timestamp that must fall in [effectiveAt, expiresAt). */
  readonly catalogHeadIssuedAt: TimestampMsV1;
}

export interface ProducedDirectAuthorCatalogIssuerDelegationV1 {
  readonly authorization: Rfc64PublicCatalogIssuerAuthorizationV1;
  /** Generic cryptographic proof bound to the exact returned envelope. */
  readonly issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
}

/**
 * Produce and re-verify an era-zero direct-author issuer delegation.  This
 * function performs no I/O; callers must durably stage the returned exact
 * envelope before making a head that references it observable.
 */
export async function produceDirectAuthorCatalogIssuerDelegationV1(
  input: ProduceDirectAuthorCatalogIssuerDelegationInputV1,
): Promise<ProducedDirectAuthorCatalogIssuerDelegationV1> {
  let scope: Readonly<AuthorCatalogScopeV1>;
  let effectiveAt: TimestampMsV1;
  let expiresAt: TimestampMsV1;
  let catalogHeadIssuedAt: TimestampMsV1;
  let signer: Rfc64AuthorCatalogEip191SignerV1;
  try {
    const suppliedScope = input.scope;
    scope = Object.freeze({
      networkId: suppliedScope.networkId,
      contextGraphId: suppliedScope.contextGraphId,
      governanceChainId: suppliedScope.governanceChainId,
      governanceContractAddress: suppliedScope.governanceContractAddress,
      ownershipTransitionDigest: suppliedScope.ownershipTransitionDigest,
      subGraphName: suppliedScope.subGraphName,
      authorAddress: suppliedScope.authorAddress,
      era: suppliedScope.era,
      bucketCount: suppliedScope.bucketCount,
    });
    assertAuthorCatalogScopeV1(scope);
    effectiveAt = input.effectiveAt;
    expiresAt = input.expiresAt;
    catalogHeadIssuedAt = input.catalogHeadIssuedAt;
    assertCanonicalTimestampMs(effectiveAt, 'effectiveAt');
    assertCanonicalTimestampMs(expiresAt, 'expiresAt');
    assertCanonicalTimestampMs(catalogHeadIssuedAt, 'catalogHeadIssuedAt');
    const suppliedSigner = input.signer;
    signer = Object.freeze({
      issuer: suppliedSigner.issuer,
      signDigest: suppliedSigner.signDigest,
    });
    if (typeof signer.signDigest !== 'function') {
      throw new TypeError('signer.signDigest must be a function');
    }
  } catch (cause) {
    fail('catalog-delegation-input', 'direct delegation input is not canonical', cause);
  }

  if (scope.era !== '0') {
    fail('catalog-delegation-scope', 'direct genesis delegation requires catalog era zero');
  }
  if (signer.issuer !== scope.authorAddress) {
    fail(
      'catalog-delegation-scope',
      'direct delegation signer must equal the exact catalog author',
    );
  }
  if (
    BigInt(effectiveAt) >= BigInt(expiresAt)
    || BigInt(catalogHeadIssuedAt) < BigInt(effectiveAt)
    || BigInt(catalogHeadIssuedAt) >= BigInt(expiresAt)
  ) {
    fail(
      'catalog-delegation-time',
      'catalog head issuedAt must be inside the delegation half-open interval',
    );
  }

  const payload: AuthorCatalogIssuerDelegationV1 = Object.freeze({
    networkId: scope.networkId,
    contextGraphId: scope.contextGraphId,
    governanceChainId: scope.governanceChainId,
    governanceContractAddress: scope.governanceContractAddress,
    ownershipTransitionDigest: scope.ownershipTransitionDigest,
    subGraphName: scope.subGraphName,
    authorAddress: scope.authorAddress,
    catalogEra: scope.era,
    previousDelegationDigest: null,
    catalogIssuerKey: scope.authorAddress,
    authorAuthorityEvidenceDigest: null,
    effectiveAt,
    expiresAt,
  });
  const unsigned = Object.freeze({
    issuer: scope.authorAddress,
    objectType: AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
    payload,
    signatureEvidence: Object.freeze({ kind: 'none' as const }),
    signatureSuite: 'eip191-personal-sign-digest-v1' as const,
  }) as unknown as UnsignedAuthorCatalogIssuerDelegationEnvelopeV1;
  const objectDigest = computeAuthorCatalogIssuerDelegationObjectDigestV1(unsigned);

  let signature: string;
  try {
    signature = await signer.signDigest(ethers.getBytes(objectDigest));
  } catch (cause) {
    fail('catalog-delegation-signer', 'direct author failed to sign the delegation', cause);
  }

  let delegation: SignedAuthorCatalogIssuerDelegationEnvelopeV1;
  let issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
  try {
    const signed = {
      ...unsigned,
      objectDigest,
      signature,
    } as SignedAuthorCatalogIssuerDelegationEnvelopeV1;
    delegation = deepFreezePlain(parseCanonicalSignedAuthorCatalogIssuerDelegationEnvelopeV1(
      canonicalizeSignedAuthorCatalogIssuerDelegationEnvelopeBytesV1(signed),
    ));
    issuerSignature = await verifyControlEnvelopeIssuerSignatureV1(delegation);
    assertExactDirectBinding(delegation, scope, effectiveAt, expiresAt);
    const proof = readVerifiedControlEnvelopeIssuerSignatureV1(issuerSignature);
    if (
      proof.objectDigest !== delegation.objectDigest
      || proof.issuer !== delegation.issuer
      || proof.signatureSuite !== delegation.signatureSuite
    ) {
      throw new Error('signature proof is not bound to the exact delegation');
    }
  } catch (cause) {
    fail(
      'catalog-delegation-signer',
      'signer did not produce one canonical direct-author delegation',
      cause,
    );
  }

  return Object.freeze({
    authorization: Object.freeze({
      catalogIssuerDelegation: delegation,
      parentAuthorAgentEvidence: null,
    }),
    issuerSignature,
  });
}

function assertExactDirectBinding(
  delegation: SignedAuthorCatalogIssuerDelegationEnvelopeV1,
  scope: Readonly<AuthorCatalogScopeV1>,
  effectiveAt: TimestampMsV1,
  expiresAt: TimestampMsV1,
): void {
  const payload = delegation.payload;
  if (
    delegation.issuer !== scope.authorAddress
    || delegation.objectType !== AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1
    || delegation.signatureSuite !== 'eip191-personal-sign-digest-v1'
    || delegation.signatureEvidence.kind !== 'none'
    || payload.networkId !== scope.networkId
    || payload.contextGraphId !== scope.contextGraphId
    || payload.governanceChainId !== scope.governanceChainId
    || payload.governanceContractAddress !== scope.governanceContractAddress
    || payload.ownershipTransitionDigest !== scope.ownershipTransitionDigest
    || payload.subGraphName !== scope.subGraphName
    || payload.authorAddress !== scope.authorAddress
    || payload.catalogEra !== scope.era
    || payload.previousDelegationDigest !== null
    || payload.catalogIssuerKey !== scope.authorAddress
    || payload.authorAuthorityEvidenceDigest !== null
    || payload.effectiveAt !== effectiveAt
    || payload.expiresAt !== expiresAt
  ) {
    fail(
      'catalog-delegation-scope',
      'signed delegation changed the exact direct-author catalog scope',
    );
  }
}

function deepFreezePlain<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const nested of Object.values(value)) deepFreezePlain(nested);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function fail(
  code: Rfc64DirectCatalogIssuerDelegationErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64DirectCatalogIssuerDelegationErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
