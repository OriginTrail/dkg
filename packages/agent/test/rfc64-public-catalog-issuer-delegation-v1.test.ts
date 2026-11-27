import {
  AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
  computeAuthorCatalogIssuerDelegationObjectDigestV1,
  type AuthorCatalogScopeV1,
  type ContextGraphIdV1,
  type EvmAddressV1,
  type NetworkIdV1,
  type UnsignedAuthorCatalogIssuerDelegationEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { readVerifiedControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';

import {
  produceDirectAuthorCatalogIssuerDelegationV1,
} from '../src/rfc64/public-catalog-issuer-delegation-v1.js';

const AUTHOR_WALLET = new ethers.Wallet(`0x${'64'.repeat(32)}`);
const OTHER_WALLET = new ethers.Wallet(`0x${'65'.repeat(32)}`);
const AUTHOR = AUTHOR_WALLET.address.toLowerCase() as EvmAddressV1;
const NETWORK_ID = 'otp:20430' as NetworkIdV1;
const CONTEXT_GRAPH_ID =
  '0x1111111111111111111111111111111111111111/direct-delegation' as ContextGraphIdV1;
const EFFECTIVE_AT = '1773899999000' as const;
const HEAD_ISSUED_AT = '1773900000000' as const;
const EXPIRES_AT = '1774000000000' as const;

const SCOPE = Object.freeze({
  networkId: NETWORK_ID,
  contextGraphId: CONTEXT_GRAPH_ID,
  governanceChainId: null,
  governanceContractAddress: null,
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  era: '0',
  bucketCount: '1',
}) as AuthorCatalogScopeV1;

describe('RFC-64 direct-author catalog issuer delegation producer', () => {
  it('builds one canonical signed direct-author authorization bound to exact scope and time', async () => {
    const produced = await produceDirectAuthorCatalogIssuerDelegationV1({
      scope: SCOPE,
      signer: signer(AUTHOR_WALLET, AUTHOR),
      effectiveAt: EFFECTIVE_AT,
      expiresAt: EXPIRES_AT,
      catalogHeadIssuedAt: HEAD_ISSUED_AT,
    });
    const delegation = produced.authorization.catalogIssuerDelegation;

    expect(delegation).toMatchObject({
      issuer: AUTHOR,
      objectType: AUTHOR_CATALOG_ISSUER_DELEGATION_OBJECT_TYPE_V1,
      signatureSuite: 'eip191-personal-sign-digest-v1',
      signatureEvidence: { kind: 'none' },
      payload: {
        networkId: NETWORK_ID,
        contextGraphId: CONTEXT_GRAPH_ID,
        governanceChainId: null,
        governanceContractAddress: null,
        ownershipTransitionDigest: null,
        subGraphName: null,
        authorAddress: AUTHOR,
        catalogEra: '0',
        previousDelegationDigest: null,
        catalogIssuerKey: AUTHOR,
        authorAuthorityEvidenceDigest: null,
        effectiveAt: EFFECTIVE_AT,
        expiresAt: EXPIRES_AT,
      },
    });
    const { objectDigest: _objectDigest, signature: _signature, ...unsigned } = delegation;
    expect(delegation.objectDigest).toBe(
      computeAuthorCatalogIssuerDelegationObjectDigestV1(
        unsigned as UnsignedAuthorCatalogIssuerDelegationEnvelopeV1,
      ),
    );
    expect(produced.authorization.parentAuthorAgentEvidence).toBeNull();
    expect(readVerifiedControlEnvelopeIssuerSignatureV1(produced.issuerSignature)).toMatchObject({
      objectDigest: delegation.objectDigest,
      issuer: AUTHOR,
      signatureSuite: 'eip191-personal-sign-digest-v1',
      verificationEvidence: { kind: 'eip191' },
    });
    expect(Object.isFrozen(delegation)).toBe(true);
    expect(Object.isFrozen(delegation.payload)).toBe(true);
  });

  it('rejects a signer that is not the exact scoped author', async () => {
    await expect(produceDirectAuthorCatalogIssuerDelegationV1({
      scope: SCOPE,
      signer: signer(OTHER_WALLET, OTHER_WALLET.address.toLowerCase() as EvmAddressV1),
      effectiveAt: EFFECTIVE_AT,
      expiresAt: EXPIRES_AT,
      catalogHeadIssuedAt: HEAD_ISSUED_AT,
    })).rejects.toThrow(/direct delegation signer must equal the exact catalog author/);
  });

  it.each([
    { effectiveAt: HEAD_ISSUED_AT, expiresAt: HEAD_ISSUED_AT, label: 'empty interval' },
    { effectiveAt: '1773900000001', expiresAt: EXPIRES_AT, label: 'not yet effective' },
    { effectiveAt: EFFECTIVE_AT, expiresAt: HEAD_ISSUED_AT, label: 'expired' },
  ] as const)('rejects $label timing before signing', async ({ effectiveAt, expiresAt }) => {
    let signCalls = 0;
    await expect(produceDirectAuthorCatalogIssuerDelegationV1({
      scope: SCOPE,
      signer: {
        issuer: AUTHOR,
        signDigest: async (digest) => {
          signCalls += 1;
          return AUTHOR_WALLET.signMessage(digest);
        },
      },
      effectiveAt,
      expiresAt,
      catalogHeadIssuedAt: HEAD_ISSUED_AT,
    })).rejects.toThrow(/half-open interval/);
    expect(signCalls).toBe(0);
  });

  it('rejects a signature produced by another EOA despite the claimed author issuer', async () => {
    await expect(produceDirectAuthorCatalogIssuerDelegationV1({
      scope: SCOPE,
      signer: signer(OTHER_WALLET, AUTHOR),
      effectiveAt: EFFECTIVE_AT,
      expiresAt: EXPIRES_AT,
      catalogHeadIssuedAt: HEAD_ISSUED_AT,
    })).rejects.toThrow(/canonical direct-author delegation/);
  });
});

function signer(wallet: ethers.Wallet, issuer: EvmAddressV1) {
  return {
    issuer,
    signDigest: (digest: Uint8Array) => wallet.signMessage(digest),
  };
}
