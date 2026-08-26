// SPDX-License-Identifier: Apache-2.0

/**
 * Accepted-current D26 access decisions for the RFC-64 catalog data plane.
 *
 * This registry is deliberately an authorization consumer, not an authority
 * verifier. Callers may insert only a policy/roster snapshot that has already
 * passed the RFC-64 administrative/finality boundary. The registry snapshots
 * those values once, binds a private roster to the exact policy digest, and
 * refuses in-place policy replacement so a stale caller cannot roll current
 * authorization backwards.
 *
 * SWM read, submission, discovery, and payload transfer follow accessPolicy.
 * publishPolicy is retained in the accepted policy snapshot but never consulted
 * here: it governs VM transaction admission, not SWM synchronization.
 */

import {
  assertCanonicalDigest,
  assertContextGraphIdV1,
  assertNetworkIdV1,
  canonicalizeContextGraphPolicyPayloadV1,
  canonicalizeMemberRosterPayloadV1,
  parseCanonicalContextGraphPolicyPayloadV1,
  parseCanonicalMemberRosterPayloadV1,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
  type Digest32V1,
  type EvmAddressV1,
  type MemberRosterEntryV1,
  type MemberRosterV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';

import { classifyRfc64PolicyCellV1 } from './policy-cell-v1.js';

export type Rfc64CatalogAccessOperationV1 =
  | 'announce-outbound'
  | 'announce-inbound'
  | 'fetch-outbound'
  | 'fetch-inbound'
  | 'catalog-object-fetch-outbound'
  | 'catalog-object-fetch-inbound'
  | 'ka-bundle-fetch-outbound'
  | 'ka-bundle-fetch-inbound';

export interface Rfc64CatalogAccessAuthorizationInputV1 {
  readonly operation: Rfc64CatalogAccessOperationV1;
  readonly remotePeerId: string;
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly policyDigest: Digest32V1;
}

export interface Rfc64CatalogAccessAuthorizationV1 {
  readonly accessPolicy: ContextGraphPolicyV1['accessPolicy'];
  readonly policyDigest: Digest32V1;
}

export interface AcceptRfc64CatalogAccessSnapshotInputV1 {
  readonly policy: ContextGraphPolicyV1;
  readonly policyDigest: Digest32V1;
  readonly roster?: MemberRosterV1 | null;
}

export interface AcceptedRfc64CatalogAccessSnapshotV1 {
  readonly policy: Readonly<ContextGraphPolicyV1>;
  readonly policyDigest: Digest32V1;
  readonly roster: Readonly<MemberRosterV1> | null;
}

/** Canonical policy/roster invariant shared by every accepted-snapshot consumer. */
export function assertAcceptedRfc64CatalogPolicyRosterV1(
  policy: Readonly<ContextGraphPolicyV1>,
  policyDigest: Digest32V1,
  roster: Readonly<MemberRosterV1> | null,
  requiredMemberAddress?: EvmAddressV1,
): void {
  if (policy.accessPolicy === 0) {
    if (roster !== null) {
      throw new Error('public RFC-64 policy forbids an exhaustive member roster');
    }
    return;
  }
  if (
    roster === null
    || roster.networkId !== policy.networkId
    || roster.contextGraphId !== policy.contextGraphId
    || roster.ownershipTransitionDigest !== policy.ownershipTransitionDigest
    || roster.era !== policy.era
    || roster.policyDigest !== policyDigest
    || roster.administrativeDelegationDigest !== policy.administrativeDelegationDigest
  ) {
    throw new Error(
      'private RFC-64 member roster is not bound to the exact accepted policy; '
      + 'private recovery requires the exact current policy-bound roster',
    );
  }
  if (
    requiredMemberAddress !== undefined
    && !roster.members.some((member) => member.agentAddress === requiredMemberAddress)
  ) {
    throw new Error(
      'private RFC-64 policy requires the exact current policy-bound roster and author membership',
    );
  }
}

export interface Rfc64CatalogAccessPolicyRegistryOptionsV1 {
  readonly localAgentAddress: EvmAddressV1;
  /** Exact authenticated libp2p-peer to agent-wallet binding. */
  readonly resolveRemoteAgentAddress: (
    remotePeerId: string,
  ) => Promise<EvmAddressV1 | null>;
}

interface HeldCatalogAccessSnapshotV1 extends AcceptedRfc64CatalogAccessSnapshotV1 {
  readonly members: ReadonlyMap<EvmAddressV1, Readonly<MemberRosterEntryV1>> | null;
}

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/u;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const MAX_PEER_ID_BYTES = 256;
const UTF8 = new TextEncoder();

/**
 * Fail-closed current-policy registry shared by announcement, catalog-object,
 * and opaque-bundle transports.
 */
export class Rfc64CatalogAccessPolicyRegistryV1 {
  readonly #localAgentAddress: EvmAddressV1 | null;
  readonly #resolveRemoteAgentAddress: ((
    remotePeerId: string,
  ) => Promise<EvmAddressV1 | null>) | null;
  readonly #byKey = new Map<string, HeldCatalogAccessSnapshotV1>();

  constructor(options?: Rfc64CatalogAccessPolicyRegistryOptionsV1) {
    if (options === undefined) {
      this.#localAgentAddress = null;
      this.#resolveRemoteAgentAddress = null;
      return;
    }
    this.#localAgentAddress = snapshotAgentAddress(
      options.localAgentAddress,
      'localAgentAddress',
    );
    if (typeof options.resolveRemoteAgentAddress !== 'function') {
      throw new TypeError('resolveRemoteAgentAddress must be a function');
    }
    this.#resolveRemoteAgentAddress = options.resolveRemoteAgentAddress;
  }

  /** Accept one already-authoritative current snapshot. Exact replay is idempotent. */
  accept(
    input: AcceptRfc64CatalogAccessSnapshotInputV1,
  ): AcceptedRfc64CatalogAccessSnapshotV1 {
    return this.#accept(input, false);
  }

  /**
   * Advance accepted-current state across one already-verified direct policy
   * transition. The predecessor digest and monotonic era/version high-water are
   * rechecked locally before the old authorization snapshot is replaced.
   */
  acceptCurrent(
    input: AcceptRfc64CatalogAccessSnapshotInputV1,
  ): AcceptedRfc64CatalogAccessSnapshotV1 {
    return this.#accept(input, true);
  }

  #accept(
    input: AcceptRfc64CatalogAccessSnapshotInputV1,
    allowVerifiedTransition: boolean,
  ): AcceptedRfc64CatalogAccessSnapshotV1 {
    const policy = snapshotPolicy(input?.policy);
    const policyDigest = snapshotDigest(input?.policyDigest, 'policyDigest');
    const descriptor = classifyRfc64PolicyCellV1(policy);
    const rosterInput = input?.roster ?? null;
    let roster: Readonly<MemberRosterV1> | null = null;
    let members: ReadonlyMap<EvmAddressV1, Readonly<MemberRosterEntryV1>> | null = null;

    if (descriptor.rosterMode === 'forbidden') {
      if (rosterInput !== null) {
        throw new Error('open RFC-64 catalog policy forbids an exhaustive member roster');
      }
    } else {
      if (!this.privatePolicyAuthorityConfigured) {
        throw new Error(
          'RFC-64 private catalog policy requires explicit access-policy authority configuration',
        );
      }
      if (rosterInput === null) {
        throw new Error('invite-only RFC-64 catalog policy requires a current member roster');
      }
      roster = snapshotRoster(rosterInput);
      assertAcceptedRfc64CatalogPolicyRosterV1(policy, policyDigest, roster);
      members = new Map(roster.members.map((entry) => [entry.agentAddress, entry]));
    }

    const key = policyKey(policy.networkId, policy.contextGraphId);
    const held = Object.freeze({ policy, policyDigest, roster, members });
    const current = this.#byKey.get(key);
    if (current !== undefined) {
      if (!sameSnapshot(current, held)) {
        if (!allowVerifiedTransition) {
          throw new Error(
            'RFC-64 current policy replacement requires the verified transition/high-water path',
          );
        }
        assertDirectMonotonicPolicyTransition(current, held);
        this.#byKey.set(key, held);
        return publicSnapshot(held);
      }
      return publicSnapshot(current);
    }

    this.#byKey.set(key, held);
    return publicSnapshot(held);
  }

  get privatePolicyAuthorityConfigured(): boolean {
    return this.#localAgentAddress !== null && this.#resolveRemoteAgentAddress !== null;
  }

  lookup(
    networkId: NetworkIdV1,
    contextGraphId: ContextGraphIdV1,
  ): AcceptedRfc64CatalogAccessSnapshotV1 | null {
    const held = this.#byKey.get(policyKey(networkId, contextGraphId));
    return held === undefined ? null : publicSnapshot(held);
  }

  get size(): number {
    return this.#byKey.size;
  }

  /**
   * Authorize one live transport operation from accepted local state only.
   * Returning null is the sole denial shape; transports still compare the
   * returned digest with the untrusted wire digest independently.
   */
  readonly authorize = async (
    input: Rfc64CatalogAccessAuthorizationInputV1,
  ): Promise<Rfc64CatalogAccessAuthorizationV1 | null> => {
    let boundary: Readonly<Rfc64CatalogAccessAuthorizationInputV1>;
    try {
      boundary = snapshotAuthorizationInput(input);
    } catch {
      return null;
    }

    const key = policyKey(boundary.networkId, boundary.contextGraphId);
    const held = this.#byKey.get(key);
    if (held === undefined || held.policyDigest !== boundary.policyDigest) return null;
    const descriptor = classifyRfc64PolicyCellV1(held.policy);
    if (descriptor.catalogDisclosure === 'open-authenticated') {
      return authorization(held);
    }
    if (
      held.members === null
      || this.#localAgentAddress === null
      || this.#resolveRemoteAgentAddress === null
    ) return null;

    const remoteAgentAddress = await this.#resolveRemoteMemberAddress(boundary.remotePeerId);
    if (remoteAgentAddress === null) return null;
    // A future verified transition path may replace the held snapshot while the
    // authenticated peer binding is being resolved. Never authorize against a
    // snapshot that stopped being current during that await.
    if (this.#byKey.get(key) !== held) return null;
    const localMember = held.members.get(this.#localAgentAddress);
    const remoteMember = held.members.get(remoteAgentAddress);
    if (localMember === undefined || remoteMember === undefined) return null;

    const servingMember = servingSide(boundary.operation) === 'local'
      ? localMember
      : remoteMember;
    if (!servingMember.roles.includes('provider')) return null;
    return authorization(held);
  };

  /** SWM authorship follows accessPolicy and is intentionally publishPolicy-neutral. */
  isSwmAuthorAuthorized(input: {
    readonly networkId: NetworkIdV1;
    readonly contextGraphId: ContextGraphIdV1;
    readonly policyDigest: Digest32V1;
    readonly authorAddress: EvmAddressV1;
  }): boolean {
    try {
      const networkId = input.networkId;
      const contextGraphId = input.contextGraphId;
      const policyDigest = snapshotDigest(input.policyDigest, 'policyDigest');
      const authorAddress = snapshotAgentAddress(input.authorAddress, 'authorAddress');
      assertNetworkIdV1(networkId);
      assertContextGraphIdV1(contextGraphId);
      const held = this.#byKey.get(policyKey(networkId, contextGraphId));
      if (held === undefined || held.policyDigest !== policyDigest) return false;
      return held.policy.accessPolicy === 0
        || (
          this.privatePolicyAuthorityConfigured
          && held.members?.has(authorAddress) === true
        );
    } catch {
      return false;
    }
  }

  async #resolveRemoteMemberAddress(remotePeerId: string): Promise<EvmAddressV1 | null> {
    if (this.#resolveRemoteAgentAddress === null) return null;
    try {
      const resolved = await this.#resolveRemoteAgentAddress(remotePeerId);
      return resolved === null
        ? null
        : snapshotAgentAddress(resolved, 'resolved remote agent address');
    } catch {
      return null;
    }
  }
}

function authorization(
  held: HeldCatalogAccessSnapshotV1,
): Rfc64CatalogAccessAuthorizationV1 {
  return Object.freeze({
    accessPolicy: held.policy.accessPolicy,
    policyDigest: held.policyDigest,
  });
}

function servingSide(operation: Rfc64CatalogAccessOperationV1): 'local' | 'remote' {
  switch (operation) {
    case 'announce-outbound':
    case 'fetch-inbound':
    case 'catalog-object-fetch-inbound':
    case 'ka-bundle-fetch-inbound':
      return 'local';
    case 'announce-inbound':
    case 'fetch-outbound':
    case 'catalog-object-fetch-outbound':
    case 'ka-bundle-fetch-outbound':
      return 'remote';
  }
}

function snapshotAuthorizationInput(
  input: Rfc64CatalogAccessAuthorizationInputV1,
): Readonly<Rfc64CatalogAccessAuthorizationInputV1> {
  if (input === null || typeof input !== 'object') {
    throw new TypeError('catalog access authorization input must be an object');
  }
  const operation = snapshotOperation(input.operation);
  const remotePeerId = snapshotPeerId(input.remotePeerId);
  const networkId = input.networkId;
  const contextGraphId = input.contextGraphId;
  assertNetworkIdV1(networkId);
  assertContextGraphIdV1(contextGraphId);
  const policyDigest = snapshotDigest(input.policyDigest, 'policyDigest');
  return Object.freeze({
    operation,
    remotePeerId,
    networkId,
    contextGraphId,
    policyDigest,
  });
}

function snapshotOperation(input: unknown): Rfc64CatalogAccessOperationV1 {
  switch (input) {
    case 'announce-outbound':
    case 'announce-inbound':
    case 'fetch-outbound':
    case 'fetch-inbound':
    case 'catalog-object-fetch-outbound':
    case 'catalog-object-fetch-inbound':
    case 'ka-bundle-fetch-outbound':
    case 'ka-bundle-fetch-inbound':
      return input;
    default:
      throw new TypeError('operation must be a supported RFC-64 catalog access operation');
  }
}

function publicSnapshot(
  held: HeldCatalogAccessSnapshotV1,
): AcceptedRfc64CatalogAccessSnapshotV1 {
  return Object.freeze({
    policy: held.policy,
    policyDigest: held.policyDigest,
    roster: held.roster,
  });
}

function snapshotPolicy(input: ContextGraphPolicyV1): Readonly<ContextGraphPolicyV1> {
  return deepFreeze(parseCanonicalContextGraphPolicyPayloadV1(
    canonicalizeContextGraphPolicyPayloadV1(input),
  ));
}

function snapshotRoster(input: MemberRosterV1): Readonly<MemberRosterV1> {
  return deepFreeze(parseCanonicalMemberRosterPayloadV1(
    canonicalizeMemberRosterPayloadV1(input),
  ));
}

function snapshotDigest(input: Digest32V1, label: string): Digest32V1 {
  assertCanonicalDigest(input, label);
  return input;
}

function snapshotAgentAddress(input: EvmAddressV1, label: string): EvmAddressV1 {
  if (typeof input !== 'string' || !EVM_ADDRESS.test(input) || input === ZERO_ADDRESS) {
    throw new TypeError(`${label} must be a canonical nonzero EVM address`);
  }
  return input;
}

function snapshotPeerId(input: string): string {
  if (
    typeof input !== 'string'
    || input.length === 0
    || input.trim() !== input
    || UTF8.encode(input).byteLength > MAX_PEER_ID_BYTES
  ) {
    throw new TypeError('remotePeerId must be a bounded canonical peer identifier');
  }
  return input;
}

function canonicalRoster(roster: Readonly<MemberRosterV1> | null): string | null {
  return roster === null ? null : canonicalizeMemberRosterPayloadV1(roster);
}

function sameSnapshot(
  left: HeldCatalogAccessSnapshotV1,
  right: HeldCatalogAccessSnapshotV1,
): boolean {
  return left.policyDigest === right.policyDigest
    && canonicalizeContextGraphPolicyPayloadV1(left.policy)
      === canonicalizeContextGraphPolicyPayloadV1(right.policy)
    && canonicalRoster(left.roster) === canonicalRoster(right.roster);
}

function assertDirectMonotonicPolicyTransition(
  current: HeldCatalogAccessSnapshotV1,
  successor: HeldCatalogAccessSnapshotV1,
): void {
  if (successor.policy.previousPolicyDigest !== current.policyDigest) {
    throw new Error(
      'RFC-64 accepted-current policy transition is not linked to the exact predecessor digest',
    );
  }
  const currentEra = BigInt(current.policy.era);
  const successorEra = BigInt(successor.policy.era);
  const currentVersion = BigInt(current.policy.version);
  const successorVersion = BigInt(successor.policy.version);
  if (
    successorEra < currentEra
    || (successorEra === currentEra && successorVersion <= currentVersion)
  ) {
    throw new Error(
      'RFC-64 accepted-current policy transition does not advance the era/version high-water',
    );
  }
}

function policyKey(networkId: NetworkIdV1, contextGraphId: ContextGraphIdV1): string {
  return `${networkId}\n${contextGraphId}`;
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
