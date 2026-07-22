// SPDX-License-Identifier: Apache-2.0

import {
  assertCanonicalChainId,
  assertNetworkIdV1,
  type CatalogSealDeploymentProfileV1,
  type EvmAddressV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import type {
  Rfc64CatalogAccessPolicyAuthorityConfigV1,
  Rfc64PublicCatalogAutoPublishConfigV1,
} from '../dkg-agent-types.js';
import { snapshotRfc64PublicCatalogAnnouncementPeersV1 } from './catalog-peers-v1.js';


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

function snapshotTimestamp(value: unknown, label: string): TimestampMsV1 {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(`rfc64PublicCatalogAutoPublish.${label} must be a canonical timestamp`);
  }
  if (BigInt(value) > 18_446_744_073_709_551_615n) {
    throw new TypeError(`rfc64PublicCatalogAutoPublish.${label} exceeds uint64`);
  }
  return value as TimestampMsV1;
}
