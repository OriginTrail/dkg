// SPDX-License-Identifier: Apache-2.0

import {
  assertCanonicalChainId,
  assertCanonicalDecimalU64,
  assertCanonicalDigest,
  assertCanonicalEvmAddress,
  assertContextGraphIdV1,
  assertNetworkIdV1,
  canonicalizeContextGraphPolicyPayloadV1,
  parseCanonicalContextGraphPolicyPayloadV1,
  type ContextGraphPolicyV1,
  type Digest32V1,
  type CatalogSealDeploymentProfileV1,
  type EvmAddressV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import type {
  Rfc64CatalogAccessPolicyAuthorityConfigV1,
  Rfc64PublicCatalogAutoPublishConfigV1,
  Rfc64PublicCatalogBootstrapConfigV1,
  Rfc64PublicCatalogBootstrapScopeV1,
  Rfc64PublicCatalogBootstrapTargetV1,
} from '../dkg-agent-types.js';

const MAX_RFC64_AUTO_PUBLISH_PEERS_V1 = 64;
const MAX_RFC64_PEER_ID_BYTES_V1 = 256;
const UTF8 = new TextEncoder();
const MAX_RFC64_BOOTSTRAP_POLICIES_V1 = 64;
const MAX_RFC64_BOOTSTRAP_TARGETS_V1 = 256;
const MAX_RFC64_BOOTSTRAP_PROVIDERS_V1 = 8;
const DEFAULT_RFC64_BOOTSTRAP_RETRY_INTERVAL_MS_V1 = 30_000;
const MAX_RFC64_BOOTSTRAP_RETRY_INTERVAL_MS_V1 = 3_600_000;

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
  if (!Array.isArray(input.peers) || input.peers.length > MAX_RFC64_AUTO_PUBLISH_PEERS_V1) {
    throw new TypeError(
      `rfc64PublicCatalogAutoPublish.peers must contain at most ${MAX_RFC64_AUTO_PUBLISH_PEERS_V1} peer IDs`,
    );
  }
  const peers: string[] = [];
  const seen = new Set<string>();
  for (const peerId of input.peers) {
    if (
      typeof peerId !== 'string'
      || peerId.length === 0
      || peerId.trim() !== peerId
      || UTF8.encode(peerId).byteLength > MAX_RFC64_PEER_ID_BYTES_V1
    ) {
      throw new TypeError('rfc64PublicCatalogAutoPublish.peers contains an invalid peer ID');
    }
    if (seen.has(peerId)) {
      throw new TypeError('rfc64PublicCatalogAutoPublish.peers must be unique');
    }
    seen.add(peerId);
    peers.push(peerId);
  }
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
    peers: Object.freeze(peers),
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
    ['acceptedPublicPolicies', 'retryIntervalMs', 'targets'],
    ['acceptedPublicPolicies', 'targets'],
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
  const policies = input.acceptedPublicPolicies.map((entry, index) => {
    assertPlainExactObject(
      entry,
      `rfc64PublicCatalogBootstrap.acceptedPublicPolicies[${index}]`,
      ['policy', 'policyDigest'],
      ['policy', 'policyDigest'],
    );
    const candidate = entry as {
      readonly policy: ContextGraphPolicyV1;
      readonly policyDigest: Digest32V1;
    };
    const policy = parseCanonicalContextGraphPolicyPayloadV1(
      canonicalizeContextGraphPolicyPayloadV1(candidate.policy),
    );
    if (policy.accessPolicy !== 0) {
      throw new TypeError('rfc64PublicCatalogBootstrap accepts public policies only');
    }
    assertCanonicalDigest(candidate.policyDigest, `acceptedPublicPolicies[${index}].policyDigest`);
    return Object.freeze({
      policy: deepFreezePlain(policy),
      policyDigest: candidate.policyDigest,
    });
  });
  const policyKeys = new Set<string>();
  for (const { policy } of policies) {
    const key = `${policy.networkId}\n${policy.contextGraphId}`;
    if (policyKeys.has(key)) {
      throw new TypeError('rfc64PublicCatalogBootstrap policies must be unique by graph');
    }
    policyKeys.add(key);
  }

  if (!Array.isArray(input.targets) || input.targets.length > MAX_RFC64_BOOTSTRAP_TARGETS_V1) {
    throw new TypeError(
      `rfc64PublicCatalogBootstrap.targets must contain at most `
      + `${MAX_RFC64_BOOTSTRAP_TARGETS_V1} catalogs`,
    );
  }
  const targetKeys = new Set<string>();
  const targets = input.targets.map((target, index) => {
    assertPlainExactObject(
      target,
      `rfc64PublicCatalogBootstrap.targets[${index}]`,
      ['providers', 'scope'],
      ['providers', 'scope'],
    );
    const candidate = target as unknown as Rfc64PublicCatalogBootstrapTargetV1;
    const scope = snapshotBootstrapScope(candidate.scope, index);
    const policy = policies.find((candidate) => (
      candidate.policy.networkId === scope.networkId
      && candidate.policy.contextGraphId === scope.contextGraphId
    ));
    if (policy === undefined || policy.policy.era !== scope.catalogEra) {
      throw new TypeError(
        'rfc64PublicCatalogBootstrap target has no matching accepted policy era',
      );
    }
    const providers = snapshotBootstrapProviders(candidate.providers, index);
    const key = `${scope.networkId}\n${scope.contextGraphId}\n${scope.authorAddress}`
      + `\n${scope.catalogEra}`;
    if (targetKeys.has(key)) {
      throw new TypeError('rfc64PublicCatalogBootstrap targets must be unique by author scope');
    }
    targetKeys.add(key);
    return Object.freeze({ scope, providers });
  });

  const retryIntervalMs = input.retryIntervalMs
    ?? DEFAULT_RFC64_BOOTSTRAP_RETRY_INTERVAL_MS_V1;
  if (
    !Number.isSafeInteger(retryIntervalMs)
    || retryIntervalMs < 0
    || retryIntervalMs > MAX_RFC64_BOOTSTRAP_RETRY_INTERVAL_MS_V1
    || (retryIntervalMs > 0 && retryIntervalMs < 1_000)
  ) {
    throw new TypeError(
      'rfc64PublicCatalogBootstrap.retryIntervalMs must be 0 or 1000..3600000',
    );
  }
  return Object.freeze({
    acceptedPublicPolicies: Object.freeze(policies),
    targets: Object.freeze(targets),
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

function snapshotBootstrapScope(
  input: Rfc64PublicCatalogBootstrapScopeV1,
  index: number,
): Readonly<Rfc64PublicCatalogBootstrapScopeV1> {
  assertPlainExactObject(
    input,
    `rfc64PublicCatalogBootstrap.targets[${index}].scope`,
    ['authorAddress', 'catalogEra', 'contextGraphId', 'networkId', 'subGraphName'],
    ['authorAddress', 'catalogEra', 'contextGraphId', 'networkId', 'subGraphName'],
  );
  assertNetworkIdV1(input.networkId, 'bootstrap scope networkId');
  assertContextGraphIdV1(input.contextGraphId, 'bootstrap scope contextGraphId');
  if (input.subGraphName !== null) {
    throw new TypeError('rfc64PublicCatalogBootstrap V1 targets public root catalogs only');
  }
  assertCanonicalEvmAddress(input.authorAddress, 'bootstrap scope authorAddress');
  if (input.authorAddress === `0x${'0'.repeat(40)}`) {
    throw new TypeError('rfc64PublicCatalogBootstrap authorAddress must be nonzero');
  }
  assertCanonicalDecimalU64(input.catalogEra, 'bootstrap scope catalogEra');
  return Object.freeze({
    networkId: input.networkId,
    contextGraphId: input.contextGraphId,
    subGraphName: null,
    authorAddress: input.authorAddress,
    catalogEra: input.catalogEra,
  });
}

function snapshotBootstrapProviders(input: readonly string[], targetIndex: number): readonly string[] {
  if (
    !Array.isArray(input)
    || input.length === 0
    || input.length > MAX_RFC64_BOOTSTRAP_PROVIDERS_V1
  ) {
    throw new TypeError(
      `rfc64PublicCatalogBootstrap.targets[${targetIndex}].providers must contain 1..`
      + `${MAX_RFC64_BOOTSTRAP_PROVIDERS_V1} peers`,
    );
  }
  const seen = new Set<string>();
  const providers = input.map((peerId) => {
    if (
      typeof peerId !== 'string'
      || peerId.length === 0
      || peerId.trim() !== peerId
      || UTF8.encode(peerId).byteLength > MAX_RFC64_PEER_ID_BYTES_V1
      || seen.has(peerId)
    ) {
      throw new TypeError('rfc64PublicCatalogBootstrap contains an invalid provider peer ID');
    }
    seen.add(peerId);
    return peerId;
  });
  return Object.freeze(providers);
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
