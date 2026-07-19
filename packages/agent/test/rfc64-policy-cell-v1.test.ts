// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import type { ContextGraphPolicyV1 } from '@origintrail-official/dkg-core';

import {
  RFC64_POLICY_CELLS_V1,
  classifyRfc64PolicyCellV1,
} from '../src/rfc64/policy-cell-v1.js';

const OWNER = '0x1111111111111111111111111111111111111111' as const;
const CURATOR = '0x2222222222222222222222222222222222222222' as const;
const GOVERNANCE = '0x3333333333333333333333333333333333333333' as const;

function policy(
  accessPolicy: 0 | 1,
  publishPolicy: 0 | 1,
  options: { registered?: boolean; pca?: boolean } = {},
): ContextGraphPolicyV1 {
  const registered = options.registered ?? true;
  return {
    networkId: 'otp:20430',
    contextGraphId: '0x1111111111111111111111111111111111111111/policy-cell',
    governanceChainId: registered ? '20430' : null,
    governanceContractAddress: registered ? GOVERNANCE : null,
    ownershipTransitionDigest: null,
    era: '0',
    version: '0',
    previousPolicyDigest: null,
    accessPolicy,
    publishPolicy,
    publishAuthority: publishPolicy === 0 ? CURATOR : null,
    publishAuthorityAccountId: publishPolicy === 0 && options.pca ? '7' : '0',
    projectionId: 'cg-shared-v1',
    administrativeDelegationDigest: null,
    source: registered
      ? {
          kind: 'finalized-chain',
          chainId: '20430',
          contractAddress: GOVERNANCE,
          blockNumber: '42',
          blockHash: `0x${'44'.repeat(32)}`,
        }
      : {
          kind: 'owner-signed-unregistered',
          ownerAddress: OWNER,
          ownerAuthorityEra: '0',
        },
    effectiveAt: '1700000000000',
    issuedAt: '1700000000000',
  };
}

describe('RFC-64 D26 policy cell classification', () => {
  it('keeps the four sharing/contribution cells closed and orthogonal', () => {
    expect(RFC64_POLICY_CELLS_V1).toEqual([
      'public-open',
      'public-curated',
      'private-open',
      'private-curated',
    ]);
    const cells = [
      classifyRfc64PolicyCellV1(policy(0, 1)),
      classifyRfc64PolicyCellV1(policy(0, 0)),
      classifyRfc64PolicyCellV1(policy(1, 1)),
      classifyRfc64PolicyCellV1(policy(1, 0)),
    ];
    expect(cells).toEqual([
      {
        cell: 'public-open',
        sharing: 'open',
        contribution: 'open',
        rosterMode: 'forbidden',
        catalogDisclosure: 'open-authenticated',
        swmSubmission: 'open-authenticated',
        ordinaryPayloadFetch: 'open-authenticated',
        providerEligibility: 'authenticated-exact-bundle-holder',
        vmPublisherAuthorization: 'any-wallet',
        publishAuthority: null,
        publishAuthorityAccountId: '0',
        vmExpectedSet: 'finalized-chain-ordinals',
        writeOnlyVmIngress: 'not-applicable-open-sharing',
      },
      {
        cell: 'public-curated',
        sharing: 'open',
        contribution: 'curated',
        rosterMode: 'forbidden',
        catalogDisclosure: 'open-authenticated',
        swmSubmission: 'open-authenticated',
        ordinaryPayloadFetch: 'open-authenticated',
        providerEligibility: 'authenticated-exact-bundle-holder',
        vmPublisherAuthorization: 'direct-eoa-or-safe',
        publishAuthority: CURATOR,
        publishAuthorityAccountId: '0',
        vmExpectedSet: 'finalized-chain-ordinals',
        writeOnlyVmIngress: 'not-applicable-open-sharing',
      },
      {
        cell: 'private-open',
        sharing: 'invite-only',
        contribution: 'open',
        rosterMode: 'required',
        catalogDisclosure: 'current-member-only',
        swmSubmission: 'current-member-only',
        ordinaryPayloadFetch: 'current-member-only',
        providerEligibility: 'current-member-with-provider-role',
        vmPublisherAuthorization: 'any-wallet',
        publishAuthority: null,
        publishAuthorityAccountId: '0',
        vmExpectedSet: 'finalized-chain-ordinals',
        writeOnlyVmIngress: 'finalized-open-inclusion-only',
      },
      {
        cell: 'private-curated',
        sharing: 'invite-only',
        contribution: 'curated',
        rosterMode: 'required',
        catalogDisclosure: 'current-member-only',
        swmSubmission: 'current-member-only',
        ordinaryPayloadFetch: 'current-member-only',
        providerEligibility: 'current-member-with-provider-role',
        vmPublisherAuthorization: 'direct-eoa-or-safe',
        publishAuthority: CURATOR,
        publishAuthorityAccountId: '0',
        vmExpectedSet: 'finalized-chain-ordinals',
        writeOnlyVmIngress: 'historical-open-inclusion-only',
      },
    ]);
    expect(Object.isFrozen(RFC64_POLICY_CELLS_V1)).toBe(true);
    expect(cells.every(Object.isFrozen)).toBe(true);
  });

  it('classifies direct and PCA curator domains without granting authority', () => {
    expect(classifyRfc64PolicyCellV1(policy(1, 0, { pca: true }))).toEqual({
      cell: 'private-curated',
      sharing: 'invite-only',
      contribution: 'curated',
      rosterMode: 'required',
      catalogDisclosure: 'current-member-only',
      swmSubmission: 'current-member-only',
      ordinaryPayloadFetch: 'current-member-only',
      providerEligibility: 'current-member-with-provider-role',
      vmPublisherAuthorization: 'pca-owner-or-registered-agent',
      publishAuthority: CURATOR,
      publishAuthorityAccountId: '7',
      vmExpectedSet: 'finalized-chain-ordinals',
      writeOnlyVmIngress: 'historical-open-inclusion-only',
    });
  });

  it('makes write-only ingress inclusion-time and registration aware', () => {
    expect(classifyRfc64PolicyCellV1(policy(1, 0, {
      registered: false,
      pca: true,
    }))).toEqual({
      cell: 'private-curated',
      sharing: 'invite-only',
      contribution: 'curated',
      rosterMode: 'required',
      catalogDisclosure: 'current-member-only',
      swmSubmission: 'current-member-only',
      ordinaryPayloadFetch: 'current-member-only',
      providerEligibility: 'current-member-with-provider-role',
      vmPublisherAuthorization: 'pca-owner-or-registered-agent',
      publishAuthority: CURATOR,
      publishAuthorityAccountId: '7',
      vmExpectedSet: 'none-unregistered',
      writeOnlyVmIngress: 'not-applicable-unregistered',
    });
    expect(classifyRfc64PolicyCellV1(policy(0, 1, { registered: false })))
      .toMatchObject({
        vmExpectedSet: 'none-unregistered',
        writeOnlyVmIngress: 'not-applicable-open-sharing',
      });
  });

  it('returns a detached immutable descriptor', () => {
    const source = policy(1, 0, { pca: true });
    const descriptor = classifyRfc64PolicyCellV1(source);
    (source as { accessPolicy: 0 | 1 }).accessPolicy = 0;
    expect(descriptor.cell).toBe('private-curated');
    expect(Object.isFrozen(descriptor)).toBe(true);
  });

  it('rejects malformed policy input instead of inferring a permissive cell', () => {
    expect(() => classifyRfc64PolicyCellV1({
      ...policy(1, 0),
      publishAuthority: null,
    })).toThrow(/cg-policy-publish-domain/);
  });
});
