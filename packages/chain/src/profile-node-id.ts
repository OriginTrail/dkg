// SPDX-License-Identifier: Apache-2.0

/**
 * Profile nodeId support shared by the EVM and mock adapters: input
 * normalization, the `updateNodeId` probe signature, the checks both run
 * before an update, and the typed errors that callers map to operator
 * messages and HTTP statuses.
 *
 * The canonical nodeId is the UTF-8 bytes of the node's base58btc libp2p peer
 * id (`encodeProfileNodeId` in dkg-core). The adapters take nodeIds as bytes
 * and do not interpret them; the contract bounds them at 64 bytes.
 */
import { ethers } from 'ethers';
import type { ProfileNodeIdUpdateResult, ProfileNodeIdUpdateSupport } from './chain-adapter.js';

/** First Profile version with `updateNodeId`. */
export const PROFILE_NODE_ID_UPDATE_MIN_VERSION = '10.1.0';

/** Mirrors `Profile.MAX_NODE_ID_LENGTH` (Profile >= 10.1.0). */
export const PROFILE_NODE_ID_MAX_LENGTH = 64;

/** The Profile entry point whose selector the feature probe looks for. */
export const PROFILE_UPDATE_NODE_ID_SIGNATURE = 'updateNodeId(uint72,bytes)';

/** `nodeId` as lowercase 0x hex; throws unless it is 1..64 bytes. */
export function normalizeProfileNodeId(nodeId: Uint8Array | string, label: string): string {
  let hex: string;
  try {
    hex = ethers.hexlify(nodeId);
  } catch {
    throw new Error(`${label}: nodeId must be bytes or 0x-prefixed hex`);
  }
  const length = ethers.dataLength(hex);
  if (length === 0) throw new Error(`${label}: nodeId is empty`);
  if (length > PROFILE_NODE_ID_MAX_LENGTH) {
    throw new Error(`${label}: nodeId is ${length} bytes; the maximum is ${PROFILE_NODE_ID_MAX_LENGTH}`);
  }
  return hex.toLowerCase();
}

/** The Hub's Profile has no `updateNodeId` (older than Profile 10.1.0). */
export class ProfileNodeIdUpdateUnsupportedError extends Error {
  readonly code = 'PROFILE_NODE_ID_UPDATE_UNSUPPORTED' as const;

  constructor(readonly support: ProfileNodeIdUpdateSupport) {
    const version = support.profileVersion ? `v${support.profileVersion}` : 'unknown version';
    super(
      'Updating the profile nodeId is not supported by the deployed Profile contract ' +
      `(${version} at ${support.profileAddress}; needs Profile >= ${support.requiredVersion}, ` +
      'which adds updateNodeId). The Hub owner must deploy and register the new Profile first.',
    );
    this.name = 'ProfileNodeIdUpdateUnsupportedError';
    Object.setPrototypeOf(this, ProfileNodeIdUpdateUnsupportedError.prototype);
  }
}

/** Another identity already holds the requested nodeId. */
export class ProfileNodeIdTakenError extends Error {
  readonly code = 'PROFILE_NODE_ID_TAKEN' as const;

  /** @param nodeId The requested nodeId (0x hex). */
  constructor(readonly nodeId: string) {
    super(`nodeId ${nodeId} is already registered to another identity; a nodeId can belong to one identity only.`);
    this.name = 'ProfileNodeIdTakenError';
    Object.setPrototypeOf(this, ProfileNodeIdTakenError.prototype);
  }
}

/** The chain reads `planProfileNodeIdUpdate` makes; both adapters provide them. */
export interface ProfileNodeIdUpdateReads {
  getIdentityId(): Promise<bigint>;
  getProfileNodeIdUpdateSupport(): Promise<ProfileNodeIdUpdateSupport>;
  getProfileNodeId(identityId: bigint): Promise<string>;
  isProfileNodeIdTaken(nodeId: string): Promise<boolean>;
}

/** What `updateProfileNodeId` does after the shared checks. */
export type ProfileNodeIdUpdatePlan =
  /** The profile already has the nodeId: return `result` and send nothing. */
  | { kind: 'unchanged'; result: ProfileNodeIdUpdateResult }
  /** Write `nodeId` (normalized 0x hex) for `identityId`. */
  | { kind: 'write'; identityId: bigint; previousNodeId: string; nodeId: string };

/**
 * The checks the EVM and mock adapters run before writing a nodeId, in this
 * order: normalize the input, require an identity, require a Profile with
 * `updateNodeId`, require a profile, treat an unchanged value as a no-op, and
 * refuse a value another identity holds. The identity's own value is always
 * in `nodeIdsList`, so the unchanged check must come before the taken check.
 * Throws `ProfileNodeIdUpdateUnsupportedError`, `ProfileNodeIdTakenError`, or
 * an Error naming the missing identity or profile.
 */
export async function planProfileNodeIdUpdate(
  chain: ProfileNodeIdUpdateReads,
  nodeId: Uint8Array | string,
  options?: { identityId?: bigint },
): Promise<ProfileNodeIdUpdatePlan> {
  const requested = normalizeProfileNodeId(nodeId, 'updateProfileNodeId');
  const identityId = options?.identityId ?? (await chain.getIdentityId());
  if (identityId === 0n) {
    throw new Error('updateProfileNodeId: node has no on-chain profile (create a profile first).');
  }

  const support = await chain.getProfileNodeIdUpdateSupport();
  if (!support.supported) throw new ProfileNodeIdUpdateUnsupportedError(support);

  const previousNodeId = await chain.getProfileNodeId(identityId);
  if (previousNodeId === '0x') {
    throw new Error(`updateProfileNodeId: identity ${identityId} has no on-chain profile.`);
  }
  if (previousNodeId === requested) {
    return { kind: 'unchanged', result: { identityId, previousNodeId, nodeId: requested, changed: false } };
  }
  if (await chain.isProfileNodeIdTaken(requested)) throw new ProfileNodeIdTakenError(requested);
  return { kind: 'write', identityId, previousNodeId, nodeId: requested };
}

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

export function isProfileNodeIdUpdateUnsupportedError(err: unknown): err is ProfileNodeIdUpdateUnsupportedError {
  return err instanceof ProfileNodeIdUpdateUnsupportedError || hasCode(err, 'PROFILE_NODE_ID_UPDATE_UNSUPPORTED');
}

export function isProfileNodeIdTakenError(err: unknown): err is ProfileNodeIdTakenError {
  return err instanceof ProfileNodeIdTakenError || hasCode(err, 'PROFILE_NODE_ID_TAKEN');
}
