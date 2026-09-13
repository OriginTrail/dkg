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

  assertAuthorityEvidenceParityV1({
    actual: acceptedAuthority,
    expected: finalizedAuthority,
    message: 'accepted authority differs from the finalized chain snapshot',
  });
  assertAuthorityEvidenceParityV1({
    actual: finalizedAuthority,
    expected: expectedAuthority,
    message: 'finalized chain authority differs from the declared gate topology',
  });
  return acceptedAuthority;
}

/**
 * A revoked runtime has no active catalog service on which to install an
 * accepted authority. It must still prove that its raw finalized-chain view
 * exactly matches the gate's declared revoked topology before inspecting its
 * persisted memory.
 */
export function assertFinalizedAuthorityMatchesExpectedV1({
  finalizedAuthority,
  expectedAuthority,
}) {
  for (const [label, authority] of [
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
  assertAuthorityEvidenceParityV1({
    actual: finalizedAuthority,
    expected: expectedAuthority,
    message: 'finalized chain authority differs from the declared gate topology',
  });
  return finalizedAuthority;
}

/** Canonical policy/roster parity with one explicit expected-version override. */
export function assertAuthorityEvidenceParityV1({
  actual,
  expected,
  expectedRosterVersion = expected?.roster?.version,
  message,
}) {
  const normalizedExpected = expected?.roster === null
    ? expected
    : {
      ...expected,
      roster: { ...expected?.roster, version: expectedRosterVersion },
    };
  if (
    actual?.policyDigest !== normalizedExpected?.policyDigest
    || canonicalizeContextGraphPolicyPayloadV1(actual?.policy)
      !== canonicalizeContextGraphPolicyPayloadV1(normalizedExpected?.policy)
    || canonicalizeMemberRosterPayloadV1(actual?.roster)
      !== canonicalizeMemberRosterPayloadV1(normalizedExpected?.roster)
  ) {
    throw new Error(`RFC-64 private gate ${message}`);
  }
}
