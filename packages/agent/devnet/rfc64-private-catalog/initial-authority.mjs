// SPDX-License-Identifier: Apache-2.0

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
    || canonicalJsonV1(left.policy.source) !== canonicalJsonV1(right.policy.source)
    || canonicalJsonV1(left.roster) !== canonicalJsonV1(right.roster)
  ) {
    throw new Error(`RFC-64 private gate ${message}`);
  }
}

function canonicalJsonV1(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonV1).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJsonV1(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}
