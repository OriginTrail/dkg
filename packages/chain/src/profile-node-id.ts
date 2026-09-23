// SPDX-License-Identifier: Apache-2.0

/**
 * Profile nodeId support shared by the EVM and mock adapters: input
 * normalization, the `updateNodeId` feature probe, and the typed errors that
 * callers map to operator messages and HTTP statuses.
 *
 * The canonical nodeId is the UTF-8 bytes of the node's base58btc libp2p peer
 * id (`encodeProfileNodeId` in dkg-core). The adapters take nodeIds as bytes
 * and do not interpret them; the contract bounds them at 64 bytes.
 */
import { ethers } from 'ethers';
import type { ProfileNodeIdUpdateSupport } from './chain-adapter.js';

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

/**
 * True iff `selector` appears as a `PUSH4 <selector>` dispatcher entry in the
 * deployed runtime bytecode `code`. Matching `63<selector>` rather than the
 * bare 4 bytes avoids false positives from the same bytes inside a constant
 * or the metadata blob. Profile is resolved straight from the Hub (not a
 * proxy), so its own dispatcher is what this sees. Same probe as the
 * DKGKnowledgeAssets high-water view detection in evm-adapter-base.ts.
 */
export function selectorInDeployedCode(code: string, selector: string): boolean {
  if (!/^0x[0-9a-fA-F]{8}$/.test(selector)) return false;
  return code.toLowerCase().includes(`63${selector.toLowerCase().slice(2)}`);
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

function hasCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === code;
}

export function isProfileNodeIdUpdateUnsupportedError(err: unknown): err is ProfileNodeIdUpdateUnsupportedError {
  return err instanceof ProfileNodeIdUpdateUnsupportedError || hasCode(err, 'PROFILE_NODE_ID_UPDATE_UNSUPPORTED');
}

export function isProfileNodeIdTakenError(err: unknown): err is ProfileNodeIdTakenError {
  return err instanceof ProfileNodeIdTakenError || hasCode(err, 'PROFILE_NODE_ID_TAKEN');
}
