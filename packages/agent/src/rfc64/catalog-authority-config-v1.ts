// SPDX-License-Identifier: Apache-2.0

import {
  assertCanonicalChainId,
  assertCanonicalEvmAddress,
  assertNetworkIdV1,
  canonicalizeUnsignedMemberRosterEnvelopeBytesV1,
  canonicalizeUnsignedContextGraphPolicyEnvelopeBytesV1,
  computeContextGraphPolicyObjectDigestV1,
  parseCanonicalUnsignedMemberRosterEnvelopeV1,
  parseCanonicalUnsignedContextGraphPolicyEnvelopeV1,
  type CatalogSealDeploymentProfileV1,
  type EvmAddressV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import type {
  Rfc64CatalogBootstrapConfigV1,
  Rfc64CatalogBootstrapPolicyV1,
  Rfc64CatalogAccessPolicyAuthorityConfigV1,
  Rfc64PublicCatalogAutoPublishConfigV1,
  Rfc64PublicCatalogBootstrapConfigV1,
  Rfc64PublicCatalogBootstrapTargetV1,
} from '../dkg-agent-types.js';
import { snapshotRfc64PublicCatalogAnnouncementPeersV1 } from './catalog-peers-v1.js';

const MAX_RFC64_BOOTSTRAP_POLICIES_V1 = 64;
const MAX_RFC64_BOOTSTRAP_TARGETS_V1 = 256;
const MAX_RFC64_BOOTSTRAP_PROVIDERS_V1 = 8;
const DEFAULT_RFC64_BOOTSTRAP_RETRY_INTERVAL_MS_V1 = 30_000;
const MAX_RFC64_BOOTSTRAP_RETRY_INTERVAL_MS_V1 = 3_600_000;

/**
 * Detach and validate the additive policy-neutral cold-start manifest.
 *
 * Like the selected-public V1 manifest, these envelopes are pinned outputs of
 * an independent operator authority check. This boundary still parses their
 * canonical object types and binds a private roster to the exact policy
 * digest. It never treats a roster payload without its control-envelope
 * issuer/objectType boundary as authority.
 */
export function snapshotRfc64CatalogBootstrapConfigV1(
  input: Rfc64CatalogBootstrapConfigV1 | undefined,
): Readonly<Rfc64CatalogBootstrapConfigV1> | undefined {
  if (input === undefined) return undefined;
  assertPlainExactObject(
    input,
    'rfc64Catalog.bootstrap',
    ['acceptedPolicies', 'retryIntervalMs'],
    ['acceptedPolicies'],
  );
  if (
    !Array.isArray(input.acceptedPolicies)
    || input.acceptedPolicies.length > MAX_RFC64_BOOTSTRAP_POLICIES_V1
  ) {
    throw new TypeError(
      `rfc64Catalog.bootstrap.acceptedPolicies must contain at most `
      + `${MAX_RFC64_BOOTSTRAP_POLICIES_V1} policies`,
    );
  }

  const policyKeys = new Set<string>();
  const targetKeys = new Set<string>();
  let totalTargets = 0;
  const acceptedPolicies = input.acceptedPolicies.map((entry, index) => {
    const label = `rfc64Catalog.bootstrap.acceptedPolicies[${index}]`;
    assertPlainExactObject(
      entry,
      label,
      ['completeSwmProviders', 'policyEnvelope', 'rosterEnvelope', 'targets'],
      ['policyEnvelope', 'targets'],
    );
    const candidate = entry as unknown as Rfc64CatalogBootstrapPolicyV1;
    const policyEnvelope = parseCanonicalUnsignedContextGraphPolicyEnvelopeV1(
      canonicalizeUnsignedContextGraphPolicyEnvelopeBytesV1(candidate.policyEnvelope),
    );
    const policy = policyEnvelope.payload;
    const policyDigest = computeContextGraphPolicyObjectDigestV1(policyEnvelope);
    if (
      policy.accessPolicy === 1
      && policy.source.kind !== 'owner-signed-unregistered'
    ) {
      throw new TypeError(
        'rfc64Catalog private Release 1 supports only owner-signed unregistered policies',
      );
    }
    const key = `${policy.networkId}\n${policy.contextGraphId}`;
    if (policyKeys.has(key)) {
      throw new TypeError('rfc64Catalog.bootstrap policies must be unique by graph');
    }
    policyKeys.add(key);

    let rosterEnvelope: Rfc64CatalogBootstrapPolicyV1['rosterEnvelope'];
    if (policy.accessPolicy === 0) {
      if (candidate.rosterEnvelope !== undefined) {
        throw new TypeError('rfc64Catalog public policies forbid rosterEnvelope');
      }
    } else {
      if (candidate.rosterEnvelope === undefined) {
        throw new TypeError('rfc64Catalog private policies require rosterEnvelope');
      }
      rosterEnvelope = parseCanonicalUnsignedMemberRosterEnvelopeV1(
        canonicalizeUnsignedMemberRosterEnvelopeBytesV1(candidate.rosterEnvelope),
      );
      const roster = rosterEnvelope.payload;
      if (
        roster.networkId !== policy.networkId
        || roster.contextGraphId !== policy.contextGraphId
        || roster.ownershipTransitionDigest !== policy.ownershipTransitionDigest
        || roster.era !== policy.era
        || roster.policyDigest !== policyDigest
        || roster.administrativeDelegationDigest !== policy.administrativeDelegationDigest
      ) {
        throw new TypeError(
          'rfc64Catalog rosterEnvelope is not bound to the exact accepted policy',
        );
      }
    }

    if (!Array.isArray(candidate.targets)) {
      throw new TypeError(`${label}.targets must be an array`);
    }
    totalTargets += candidate.targets.length;
    if (totalTargets > MAX_RFC64_BOOTSTRAP_TARGETS_V1) {
      throw new TypeError(
        `rfc64Catalog.bootstrap targets must contain at most `
        + `${MAX_RFC64_BOOTSTRAP_TARGETS_V1} catalogs`,
      );
    }
    const targets = candidate.targets.map((target, targetIndex) => {
      assertPlainExactObject(
        target,
        `${label}.targets[${targetIndex}]`,
        ['authorAddress', 'providers'],
        ['authorAddress', 'providers'],
      );
      const targetCandidate = target as unknown as Rfc64PublicCatalogBootstrapTargetV1;
      assertCanonicalEvmAddress(targetCandidate.authorAddress, 'bootstrap target authorAddress');
      if (targetCandidate.authorAddress === `0x${'0'.repeat(40)}`) {
        throw new TypeError('rfc64Catalog.bootstrap authorAddress must be nonzero');
      }
      const providers = snapshotBootstrapProviders(
        targetCandidate.providers,
        `acceptedPolicies[${index}].targets[${targetIndex}].providers`,
        'rfc64Catalog.bootstrap',
      );
      const targetKey = `${key}\n${targetCandidate.authorAddress}\n${policy.era}`;
      if (targetKeys.has(targetKey)) {
        throw new TypeError('rfc64Catalog.bootstrap targets must be unique by author scope');
      }
      targetKeys.add(targetKey);
      return Object.freeze({ authorAddress: targetCandidate.authorAddress, providers });
    });
    const completeSwmProviders = candidate.completeSwmProviders === undefined
      ? undefined
      : snapshotBootstrapProviders(
        candidate.completeSwmProviders,
        `acceptedPolicies[${index}].completeSwmProviders`,
        'rfc64Catalog.bootstrap',
      );
    if (policy.accessPolicy === 1 && completeSwmProviders?.length !== 1) {
      throw new TypeError(
        'rfc64Catalog private Release 1 policies require exactly one completeSwmProvider',
      );
    }
    if (policy.accessPolicy === 1) {
      const completeProvider = completeSwmProviders![0]!;
      const rosterMembers = new Set(
        rosterEnvelope!.payload.members.map(({ agentAddress }) => agentAddress),
      );
      for (const target of targets) {
        if (!rosterMembers.has(target.authorAddress)) {
          throw new TypeError(
            'rfc64Catalog private catalog target author is not a current roster member',
          );
        }
        if (target.providers.length !== 1 || target.providers[0] !== completeProvider) {
          throw new TypeError(
            'rfc64Catalog private Release 1 targets must use the one completeSwmProvider',
          );
        }
      }
    }
    return Object.freeze({
      policyEnvelope: deepFreezePlain(policyEnvelope),
      ...(rosterEnvelope === undefined
        ? {}
        : { rosterEnvelope: deepFreezePlain(rosterEnvelope) }),
      targets: Object.freeze(targets),
      ...(completeSwmProviders === undefined ? {} : { completeSwmProviders }),
    });
  });

  const retryIntervalMs = snapshotBootstrapRetryIntervalMs(
    input.retryIntervalMs,
    'rfc64Catalog.bootstrap',
  );
  return Object.freeze({
    acceptedPolicies: Object.freeze(acceptedPolicies),
    retryIntervalMs,
  });
}

/** Detach a locally configured deployment tuple from caller-owned state. */
export function snapshotRfc64CatalogDeploymentProfileV1(
  input: CatalogSealDeploymentProfileV1 | undefined,
): Readonly<CatalogSealDeploymentProfileV1> | undefined {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('rfc64CatalogDeploymentProfile must be a plain object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('rfc64CatalogDeploymentProfile must be a plain object');
  }
  const keys = Object.keys(input).sort();
  const expectedKeys = [
    'assertedAtChainId',
    'assertedAtKav10Address',
    'networkId',
  ];
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(
      'rfc64CatalogDeploymentProfile must contain exactly networkId, '
      + 'assertedAtChainId, and assertedAtKav10Address',
    );
  }
  assertNetworkIdV1(input.networkId);
  assertCanonicalChainId(input.assertedAtChainId, 'assertedAtChainId');
  if (!ethers.isAddress(input.assertedAtKav10Address)) {
    throw new TypeError('assertedAtKav10Address must be a non-zero EVM address');
  }
  const assertedAtKav10Address = input.assertedAtKav10Address.toLowerCase() as EvmAddressV1;
  if (assertedAtKav10Address === `0x${'00'.repeat(20)}`) {
    throw new TypeError('assertedAtKav10Address must be a non-zero EVM address');
  }
  return Object.freeze({
    networkId: input.networkId,
    assertedAtChainId: input.assertedAtChainId,
    assertedAtKav10Address,
  });
}

/** Snapshot the function-bearing private-policy authority at create time. */
export function snapshotRfc64CatalogAccessPolicyAuthorityV1(
  input: Rfc64CatalogAccessPolicyAuthorityConfigV1 | undefined,
): Readonly<Rfc64CatalogAccessPolicyAuthorityConfigV1> | undefined {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('rfc64CatalogAccessPolicyAuthority must be a plain object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('rfc64CatalogAccessPolicyAuthority must be a plain object');
  }
  const keys = Object.keys(input).sort();
  if (
    keys.length !== 2
    || keys[0] !== 'localAgentAddress'
    || keys[1] !== 'resolveRemoteAgentAddress'
  ) {
    throw new TypeError('rfc64CatalogAccessPolicyAuthority has unknown or missing fields');
  }
  if (
    typeof input.localAgentAddress !== 'string'
    || !ethers.isAddress(input.localAgentAddress)
    || input.localAgentAddress === ethers.ZeroAddress
  ) {
    throw new TypeError('rfc64CatalogAccessPolicyAuthority.localAgentAddress is invalid');
  }
  if (typeof input.resolveRemoteAgentAddress !== 'function') {
    throw new TypeError(
      'rfc64CatalogAccessPolicyAuthority.resolveRemoteAgentAddress must be a function',
    );
  }
  return Object.freeze({
    localAgentAddress: input.localAgentAddress.toLowerCase() as EvmAddressV1,
    resolveRemoteAgentAddress: input.resolveRemoteAgentAddress,
  });
}

/** Detach and validate the preview authoring configuration at create time. */
export function snapshotRfc64PublicCatalogAutoPublishConfigV1(
  input: Rfc64PublicCatalogAutoPublishConfigV1 | undefined,
): Readonly<Rfc64PublicCatalogAutoPublishConfigV1> | undefined {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('rfc64PublicCatalogAutoPublish must be a plain object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('rfc64PublicCatalogAutoPublish must be a plain object');
  }
  const keys = Object.keys(input).sort();
  const allowed = new Set([
    'catalogIssuerDelegationEffectiveAt',
    'catalogIssuerDelegationExpiresAt',
    'peers',
  ]);
  if (
    keys.some((key) => !allowed.has(key))
    || !keys.includes('peers')
    || !keys.includes('catalogIssuerDelegationExpiresAt')
  ) {
    throw new TypeError('rfc64PublicCatalogAutoPublish has unknown or missing fields');
  }
  const peers = snapshotRfc64PublicCatalogAnnouncementPeersV1(input.peers);
  const effectiveAt = snapshotTimestamp(
    input.catalogIssuerDelegationEffectiveAt ?? ('0' as TimestampMsV1),
    'catalogIssuerDelegationEffectiveAt',
  );
  const expiresAt = snapshotTimestamp(
    input.catalogIssuerDelegationExpiresAt,
    'catalogIssuerDelegationExpiresAt',
  );
  if (BigInt(expiresAt) <= BigInt(effectiveAt)) {
    throw new TypeError(
      'rfc64PublicCatalogAutoPublish delegation expiry must be after its effective time',
    );
  }
  return Object.freeze({
    peers,
    catalogIssuerDelegationEffectiveAt: effectiveAt,
    catalogIssuerDelegationExpiresAt: expiresAt,
  });
}

/** Detach and validate the explicit public cold-start manifest. */
export function snapshotRfc64PublicCatalogBootstrapConfigV1(
  input: Rfc64PublicCatalogBootstrapConfigV1 | undefined,
): Readonly<Rfc64PublicCatalogBootstrapConfigV1> | undefined {
  if (input === undefined) return undefined;
  assertPlainExactObject(
    input,
    'rfc64PublicCatalogBootstrap',
    ['acceptedPublicPolicies', 'retryIntervalMs'],
    ['acceptedPublicPolicies'],
  );
  if (
    !Array.isArray(input.acceptedPublicPolicies)
    || input.acceptedPublicPolicies.length > MAX_RFC64_BOOTSTRAP_POLICIES_V1
  ) {
    throw new TypeError(
      `rfc64PublicCatalogBootstrap.acceptedPublicPolicies must contain at most `
      + `${MAX_RFC64_BOOTSTRAP_POLICIES_V1} policies`,
    );
  }
  const policyKeys = new Set<string>();
  const targetKeys = new Set<string>();
  let totalTargets = 0;
  const policies = input.acceptedPublicPolicies.map((entry, index) => {
    assertPlainExactObject(
      entry,
      `rfc64PublicCatalogBootstrap.acceptedPublicPolicies[${index}]`,
      ['completeSwmProviders', 'policyEnvelope', 'targets'],
      ['policyEnvelope', 'targets'],
    );
    const candidate = entry as unknown as {
      readonly policyEnvelope: Rfc64PublicCatalogBootstrapConfigV1[
        'acceptedPublicPolicies'
      ][number]['policyEnvelope'];
      readonly targets: readonly Rfc64PublicCatalogBootstrapTargetV1[];
      readonly completeSwmProviders?: readonly string[];
    };
    const policyEnvelope = parseCanonicalUnsignedContextGraphPolicyEnvelopeV1(
      canonicalizeUnsignedContextGraphPolicyEnvelopeBytesV1(candidate.policyEnvelope),
    );
    const policy = policyEnvelope.payload;
    if (policy.accessPolicy !== 0) {
      throw new TypeError('rfc64PublicCatalogBootstrap accepts public policies only');
    }
    const key = `${policy.networkId}\n${policy.contextGraphId}`;
    if (policyKeys.has(key)) {
      throw new TypeError('rfc64PublicCatalogBootstrap policies must be unique by graph');
    }
    policyKeys.add(key);
    if (!Array.isArray(candidate.targets)) {
      throw new TypeError(
        `rfc64PublicCatalogBootstrap.acceptedPublicPolicies[${index}].targets must be an array`,
      );
    }
    totalTargets += candidate.targets.length;
    if (totalTargets > MAX_RFC64_BOOTSTRAP_TARGETS_V1) {
      throw new TypeError(
        `rfc64PublicCatalogBootstrap targets must contain at most `
        + `${MAX_RFC64_BOOTSTRAP_TARGETS_V1} catalogs`,
      );
    }
    const targets = candidate.targets.map((target, targetIndex) => {
      assertPlainExactObject(
        target,
        `rfc64PublicCatalogBootstrap.acceptedPublicPolicies[${index}].targets[${targetIndex}]`,
        ['authorAddress', 'providers'],
        ['authorAddress', 'providers'],
      );
      const targetCandidate = target as unknown as Rfc64PublicCatalogBootstrapTargetV1;
      assertCanonicalEvmAddress(targetCandidate.authorAddress, 'bootstrap target authorAddress');
      if (targetCandidate.authorAddress === `0x${'0'.repeat(40)}`) {
        throw new TypeError('rfc64PublicCatalogBootstrap authorAddress must be nonzero');
      }
      const providers = snapshotBootstrapProviders(
        targetCandidate.providers,
        `targets[${targetIndex}].providers`,
      );
      const targetKey = `${key}\n${targetCandidate.authorAddress}\n${policy.era}`;
      if (targetKeys.has(targetKey)) {
        throw new TypeError('rfc64PublicCatalogBootstrap targets must be unique by author scope');
      }
      targetKeys.add(targetKey);
      return Object.freeze({ authorAddress: targetCandidate.authorAddress, providers });
    });
    const completeSwmProviders = candidate.completeSwmProviders === undefined
      ? undefined
      : snapshotBootstrapProviders(
        candidate.completeSwmProviders,
        `acceptedPublicPolicies[${index}].completeSwmProviders`,
      );
    return Object.freeze({
      policyEnvelope: deepFreezePlain(policyEnvelope),
      targets: Object.freeze(targets),
      ...(completeSwmProviders === undefined ? {} : { completeSwmProviders }),
    });
  });

  const retryIntervalMs = snapshotBootstrapRetryIntervalMs(
    input.retryIntervalMs,
    'rfc64PublicCatalogBootstrap',
  );
  return Object.freeze({
    acceptedPublicPolicies: Object.freeze(policies),
    retryIntervalMs,
  });
}

function snapshotTimestamp(value: unknown, label: string): TimestampMsV1 {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`rfc64PublicCatalogAutoPublish.${label} must be a canonical timestamp`);
  }
  if (BigInt(value) > 18_446_744_073_709_551_615n) {
    throw new TypeError(`rfc64PublicCatalogAutoPublish.${label} exceeds uint64`);
  }
  return value as TimestampMsV1;
}

function snapshotBootstrapProviders(
  input: readonly string[],
  label: string,
  rootLabel = 'rfc64PublicCatalogBootstrap',
): readonly string[] {
  const providers = snapshotRfc64PublicCatalogAnnouncementPeersV1(input);
  if (
    providers.length === 0
    || providers.length > MAX_RFC64_BOOTSTRAP_PROVIDERS_V1
  ) {
    throw new TypeError(
      `${rootLabel}.${label} must contain 1..`
      + `${MAX_RFC64_BOOTSTRAP_PROVIDERS_V1} peers`,
    );
  }
  return providers;
}

function snapshotBootstrapRetryIntervalMs(
  input: number | undefined,
  label: string,
): number {
  const retryIntervalMs = input ?? DEFAULT_RFC64_BOOTSTRAP_RETRY_INTERVAL_MS_V1;
  if (
    !Number.isSafeInteger(retryIntervalMs)
    || retryIntervalMs < 0
    || retryIntervalMs > MAX_RFC64_BOOTSTRAP_RETRY_INTERVAL_MS_V1
    || (retryIntervalMs > 0 && retryIntervalMs < 1_000)
  ) {
    throw new TypeError(`${label}.retryIntervalMs must be 0 or 1000..3600000`);
  }
  return retryIntervalMs;
}

function assertPlainExactObject(
  input: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[],
): asserts input is Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const keys = Object.keys(input);
  if (
    keys.some((key) => !allowed.includes(key))
    || required.some((key) => !keys.includes(key))
  ) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
}

function deepFreezePlain<T>(input: T): Readonly<T> {
  if (input !== null && typeof input === 'object') {
    for (const value of Object.values(input as Record<string, unknown>)) {
      deepFreezePlain(value);
    }
    if (!Object.isFrozen(input)) Object.freeze(input);
  }
  return input;
}
