// SPDX-License-Identifier: Apache-2.0

import { assertCanonicalDigest, canonicalizeContextGraphPolicyPayloadV1, canonicalizeMemberRosterPayloadV1, parseCanonicalContextGraphPolicyPayloadV1, parseCanonicalMemberRosterPayloadV1, type ContextGraphPolicyV1, type MemberRosterV1, type Digest32V1 } from '@origintrail-official/dkg-core';
import type { AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';

export function publicSnapshot(
  held: AcceptedRfc64CatalogAccessSnapshotV1,
): AcceptedRfc64CatalogAccessSnapshotV1 {
  return Object.freeze({
    policy: held.policy,
    policyDigest: held.policyDigest,
    roster: held.roster,
    provenance: held.provenance,
  });
}

export function snapshotPolicy(input: ContextGraphPolicyV1): Readonly<ContextGraphPolicyV1> {
  return deepFreeze(parseCanonicalContextGraphPolicyPayloadV1(
    canonicalizeContextGraphPolicyPayloadV1(input),
  ));
}

export function snapshotRoster(input: MemberRosterV1): Readonly<MemberRosterV1> {
  return deepFreeze(parseCanonicalMemberRosterPayloadV1(
    canonicalizeMemberRosterPayloadV1(input),
  ));
}

export function snapshotDigest(input: Digest32V1, label: string): Digest32V1 {
  assertCanonicalDigest(input, label);
  return input;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value as Readonly<T>;
}
