// SPDX-License-Identifier: Apache-2.0

/**
 * Nominal authority boundary for activating an RFC-64 catalog access snapshot.
 *
 * The policy registry owns transition ordering. This verifier boundary owns the
 * separate question of whether the exact policy/roster objects and digests are
 * authoritative and current (signature/delegation/finality as applicable).
 * Production composition must configure that authority check; callers cannot
 * replace it with a per-call boolean or forge the capability it returns.
 */

import {
  assertCanonicalDigest,
  canonicalizeContextGraphPolicyPayloadV1,
  canonicalizeMemberRosterPayloadV1,
  parseCanonicalContextGraphPolicyPayloadV1,
  parseCanonicalMemberRosterPayloadV1,
  type ContextGraphPolicyV1,
  type Digest32V1,
  type MemberRosterV1,
} from '@origintrail-official/dkg-core';

export interface Rfc64CatalogAccessCurrentSnapshotInputV1 {
  readonly policy: ContextGraphPolicyV1;
  readonly policyDigest: Digest32V1;
  readonly roster: MemberRosterV1 | null;
  readonly rosterDigest: Digest32V1 | null;
}

export interface Rfc64CatalogAccessCurrentSnapshotV1 {
  readonly policy: Readonly<ContextGraphPolicyV1>;
  readonly policyDigest: Digest32V1;
  readonly roster: Readonly<MemberRosterV1> | null;
  readonly rosterDigest: Digest32V1 | null;
}

declare const VERIFIED_CURRENT_SNAPSHOT_V1: unique symbol;

/** Opaque token minted only after the configured authority check succeeds. */
export interface VerifiedRfc64CatalogAccessCurrentSnapshotV1 {
  readonly [VERIFIED_CURRENT_SNAPSHOT_V1]: true;
}

export interface Rfc64CatalogAccessCurrentSnapshotVerifierV1 {
  readonly verifyCurrentSnapshot: (
    input: Rfc64CatalogAccessCurrentSnapshotInputV1,
  ) => Promise<VerifiedRfc64CatalogAccessCurrentSnapshotV1>;
}

export type Rfc64CatalogAccessCurrentAuthorityCheckV1 = (
  snapshot: Rfc64CatalogAccessCurrentSnapshotV1,
) => void | Promise<void>;

const VERIFIED_CURRENT_SNAPSHOTS_V1 = new WeakMap<
object,
Rfc64CatalogAccessCurrentSnapshotV1
>();

/**
 * Bind one deployment-owned authority check to the nominal capability mint.
 * The check must throw on any signature, delegation, finalized-source, digest,
 * or currentness failure and must return no boolean-shaped decision.
 */
export function createRfc64CatalogAccessCurrentSnapshotVerifierV1(
  verifyAuthority: Rfc64CatalogAccessCurrentAuthorityCheckV1,
): Rfc64CatalogAccessCurrentSnapshotVerifierV1 {
  if (typeof verifyAuthority !== 'function') {
    throw new TypeError('verifyAuthority must be a function');
  }
  return Object.freeze({
    verifyCurrentSnapshot: async (
      input: Rfc64CatalogAccessCurrentSnapshotInputV1,
    ): Promise<VerifiedRfc64CatalogAccessCurrentSnapshotV1> => {
      const snapshot = snapshotCurrentInput(input);
      const result = await verifyAuthority(snapshot);
      if (result !== undefined) {
        throw new TypeError('verifyAuthority must resolve undefined or throw');
      }
      const capability = Object.freeze(
        Object.create(null),
      ) as VerifiedRfc64CatalogAccessCurrentSnapshotV1;
      VERIFIED_CURRENT_SNAPSHOTS_V1.set(capability as object, snapshot);
      return capability;
    },
  });
}

/** Reject casts, clones, serialized values, and tokens from no verifier. */
export function readVerifiedRfc64CatalogAccessCurrentSnapshotV1(
  value: unknown,
): Rfc64CatalogAccessCurrentSnapshotV1 {
  if (
    (typeof value !== 'object' && typeof value !== 'function')
    || value === null
    || !VERIFIED_CURRENT_SNAPSHOTS_V1.has(value as object)
  ) {
    throw new TypeError(
      'RFC-64 current catalog access snapshot was not minted by the configured verifier',
    );
  }
  return VERIFIED_CURRENT_SNAPSHOTS_V1.get(value as object)!;
}

function snapshotCurrentInput(
  input: Rfc64CatalogAccessCurrentSnapshotInputV1,
): Rfc64CatalogAccessCurrentSnapshotV1 {
  const policy = deepFreeze(parseCanonicalContextGraphPolicyPayloadV1(
    canonicalizeContextGraphPolicyPayloadV1(input?.policy),
  ));
  const policyDigest = snapshotDigest(input?.policyDigest, 'policyDigest');
  const rosterInput = input?.roster;
  const rosterDigestInput = input?.rosterDigest;
  if (rosterInput === undefined || rosterDigestInput === undefined) {
    throw new TypeError('roster and rosterDigest must be explicit');
  }
  if ((rosterInput === null) !== (rosterDigestInput === null)) {
    throw new TypeError('roster and rosterDigest must either both be null or both be present');
  }
  const roster = rosterInput === null
    ? null
    : deepFreeze(parseCanonicalMemberRosterPayloadV1(
      canonicalizeMemberRosterPayloadV1(rosterInput),
    ));
  const rosterDigest = rosterDigestInput === null
    ? null
    : snapshotDigest(rosterDigestInput, 'rosterDigest');
  return Object.freeze({ policy, policyDigest, roster, rosterDigest });
}

function snapshotDigest(input: Digest32V1, label: string): Digest32V1 {
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
