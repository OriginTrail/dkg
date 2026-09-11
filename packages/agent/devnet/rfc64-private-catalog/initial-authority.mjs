// SPDX-License-Identifier: Apache-2.0

import {
  canonicalizeContextGraphPolicyPayloadV1,
  canonicalizeMemberRosterPayloadV1,
} from '@origintrail-official/dkg-core';

/**
 * Fail closed unless the authority accepted by the agent is exactly the
 * release-native finalized-chain generation and agrees with both the raw
 * finalized snapshot and the gate's declared topology.
 */
export function assertInitialFinalizedAuthorityV1({
  acceptedAuthority,
  finalizedAuthority,
  expectedAuthority,
}) {
  for (const [label, authority] of [
    ['accepted', acceptedAuthority],
    ['finalized', finalizedAuthority],
    ['expected', expectedAuthority],
  ]) {
    if (authority === null || typeof authority !== 'object') {
      throw new Error(`RFC-64 private gate ${label} authority is missing`);
    }
    if (
      authority.source !== 'finalized-chain'
      || authority.policy?.source?.kind !== 'finalized-chain'
    ) {
      throw new Error(`RFC-64 private gate ${label} authority is not finalized-chain`);
    }
    if (authority.roster === null || !Array.isArray(authority.roster.members)) {
      throw new Error(`RFC-64 private gate ${label} authority has no private roster`);
    }
  }

  assertSameAuthorityEvidenceV1(
    acceptedAuthority,
    finalizedAuthority,
    'accepted authority differs from the finalized chain snapshot',
  );
  assertSameAuthorityEvidenceV1(
    finalizedAuthority,
    expectedAuthority,
    'finalized chain authority differs from the declared gate topology',
  );
  return acceptedAuthority;
}

function assertSameAuthorityEvidenceV1(left, right, message) {
  if (
    left.policyDigest !== right.policyDigest
    || canonicalizeContextGraphPolicyPayloadV1(left.policy)
      !== canonicalizeContextGraphPolicyPayloadV1(right.policy)
    || canonicalizeMemberRosterPayloadV1(left.roster)
      !== canonicalizeMemberRosterPayloadV1(right.roster)
  ) {
    throw new Error(`RFC-64 private gate ${message}`);
  }
}
