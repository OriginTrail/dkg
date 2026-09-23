// SPDX-License-Identifier: Apache-2.0

/**
 * Keep this node's on-chain Profile `nodeId` equal to its libp2p peer id.
 *
 * The daemon used to create profiles with a random 32-byte nodeId, so the
 * chain has no identity -> peer mapping. The canonical nodeId is the UTF-8
 * bytes of the base58btc peer id (`encodeProfileNodeId` in dkg-core); Profile
 * >= 10.1.0 lets the identity re-point it (`Profile.updateNodeId`).
 *
 * Two entry points share this module:
 *   - `dkg identity sync-node-id` (mode `manual`): points the nodeId at this
 *     node's peer id whatever it currently is.
 *   - the daemon's startup reconcile (mode `startup`): only replaces a value
 *     that is NOT a peer id (the legacy random bytes). If the chain already
 *     names a different valid peer id it only warns, so two daemons that share
 *     an identity cannot overwrite each other on every restart.
 */
import {
  decodeProfileNodeId,
  encodeProfileNodeId,
  encodeProfileNodeIdHex,
} from '@origintrail-official/dkg-core';
import {
  isProfileNodeIdTakenError,
  isProfileNodeIdUpdateUnsupportedError,
  type ChainAdapter,
  type ProfileNodeIdUpdateSupport,
  type TxResult,
} from '@origintrail-official/dkg-chain';

export type ProfileNodeIdState =
  /** No on-chain profile for this node yet. */
  | 'no-profile'
  /** The on-chain nodeId is this node's peer id. */
  | 'in-sync'
  /** The on-chain nodeId is not a peer id (legacy random bytes). */
  | 'legacy'
  /** The on-chain nodeId names a different peer id. */
  | 'other-peer';

export interface ProfileNodeIdStatus {
  identityId: bigint;
  /** This node's libp2p peer id. */
  peerId: string;
  /** The canonical nodeId for `peerId` (0x hex). */
  expectedNodeId: string;
  /** The on-chain nodeId (0x hex); `'0x'` without a profile. */
  onChainNodeId: string;
  /** The peer id the on-chain nodeId names, or null when it names none. */
  onChainPeerId: string | null;
  state: ProfileNodeIdState;
  /** Whether another identity holds `expectedNodeId`; null when not checked (in sync / no profile). */
  expectedNodeIdTaken: boolean | null;
  /** The sharding-table member holding `expectedNodeId`, when one does. */
  expectedNodeIdHolder: bigint | null;
  support: ProfileNodeIdUpdateSupport;
}

export type ProfileNodeIdSyncOutcome =
  /** The update transaction was sent and mined. */
  | 'updated'
  | 'in-sync'
  | 'no-profile'
  /** The deployed Profile predates `updateNodeId`. */
  | 'unsupported'
  /** Another identity already holds this node's peer id. */
  | 'taken'
  /** Startup mode does not overwrite a different valid peer id. */
  | 'skipped-other-peer';

export interface ProfileNodeIdSyncResult {
  outcome: ProfileNodeIdSyncOutcome;
  /** The status after the sync (after the update when one was sent). */
  status: ProfileNodeIdStatus;
  tx?: TxResult;
  /** The wallet that signed the update. */
  signer?: string;
}

export type ProfileNodeIdSyncMode = 'manual' | 'startup';

export interface ProfileNodeIdSyncDeps {
  chain: ChainAdapter;
  /** This node's libp2p peer id (canonical base58btc string). */
  peerId: string;
}

type ProfileNodeIdChain = ChainAdapter & Required<Pick<
  ChainAdapter,
  'getProfileNodeId' | 'isProfileNodeIdTaken' | 'getProfileNodeIdUpdateSupport' | 'updateProfileNodeId'
>>;

/**
 * The nodeId a new profile should carry: this node's peer id bytes. Undefined
 * (the adapter then writes legacy random bytes) only if the peer id cannot be
 * encoded, which a libp2p-generated peer id always can.
 */
export function profileNodeIdForNewProfile(peerId: string): Uint8Array | undefined {
  try {
    return encodeProfileNodeId(peerId);
  } catch {
    return undefined;
  }
}

function hasProfileNodeIdSurface(chain: ChainAdapter): chain is ProfileNodeIdChain {
  return typeof chain.getProfileNodeId === 'function'
    && typeof chain.isProfileNodeIdTaken === 'function'
    && typeof chain.getProfileNodeIdUpdateSupport === 'function'
    && typeof chain.updateProfileNodeId === 'function';
}

async function ringHolderOf(chain: ChainAdapter, nodeId: string): Promise<bigint | null> {
  if (typeof chain.listDesignatableNodes !== 'function') return null;
  try {
    const ring = await chain.listDesignatableNodes({ fresh: true });
    return ring.find((node) => node.nodeId.toLowerCase() === nodeId)?.identityId ?? null;
  } catch {
    return null; // diagnostic only
  }
}

/** Where this node's on-chain nodeId stands; null when the chain adapter has no Profile nodeId surface. */
export async function readProfileNodeIdStatus(deps: ProfileNodeIdSyncDeps): Promise<ProfileNodeIdStatus | null> {
  const { chain, peerId } = deps;
  if (!hasProfileNodeIdSurface(chain)) return null;
  const expectedNodeId = encodeProfileNodeIdHex(peerId);
  const identityId = await chain.getIdentityId();
  const support = await chain.getProfileNodeIdUpdateSupport();
  const base = { identityId, peerId, expectedNodeId, support };
  if (identityId === 0n) {
    return {
      ...base,
      onChainNodeId: '0x',
      onChainPeerId: null,
      state: 'no-profile',
      expectedNodeIdTaken: null,
      expectedNodeIdHolder: null,
    };
  }

  const onChainNodeId = (await chain.getProfileNodeId(identityId)).toLowerCase();
  const onChainPeerId = decodeProfileNodeId(onChainNodeId);
  if (onChainNodeId === '0x') {
    return {
      ...base,
      onChainNodeId,
      onChainPeerId,
      state: 'no-profile',
      expectedNodeIdTaken: null,
      expectedNodeIdHolder: null,
    };
  }
  if (onChainNodeId === expectedNodeId) {
    return { ...base, onChainNodeId, onChainPeerId, state: 'in-sync', expectedNodeIdTaken: null, expectedNodeIdHolder: null };
  }
  const expectedNodeIdTaken = await chain.isProfileNodeIdTaken(expectedNodeId);
  return {
    ...base,
    onChainNodeId,
    onChainPeerId,
    state: onChainPeerId === null ? 'legacy' : 'other-peer',
    expectedNodeIdTaken,
    expectedNodeIdHolder: expectedNodeIdTaken ? await ringHolderOf(chain, expectedNodeId) : null,
  };
}

/**
 * Point this node's on-chain nodeId at its peer id when the deployed Profile
 * supports it. Returns null when the chain adapter has no Profile nodeId
 * surface. RPC and transaction failures other than "unsupported" and "taken"
 * propagate.
 */
export async function syncProfileNodeId(
  deps: ProfileNodeIdSyncDeps,
  mode: ProfileNodeIdSyncMode,
): Promise<ProfileNodeIdSyncResult | null> {
  const status = await readProfileNodeIdStatus(deps);
  if (status === null) return null;
  if (status.state === 'no-profile') return { outcome: 'no-profile', status };
  if (status.state === 'in-sync') return { outcome: 'in-sync', status };
  if (!status.support.supported) return { outcome: 'unsupported', status };
  if (status.expectedNodeIdTaken) return { outcome: 'taken', status };
  if (mode === 'startup' && status.state === 'other-peer') return { outcome: 'skipped-other-peer', status };

  const chain = deps.chain as ProfileNodeIdChain;
  try {
    const result = await chain.updateProfileNodeId(status.expectedNodeId, { identityId: status.identityId });
    const synced: ProfileNodeIdStatus = {
      ...status,
      onChainNodeId: result.nodeId,
      onChainPeerId: status.peerId,
      state: 'in-sync',
      expectedNodeIdTaken: null,
      expectedNodeIdHolder: null,
    };
    // `changed: false` means another process set it between the read and the call.
    if (!result.changed) return { outcome: 'in-sync', status: synced };
    return { outcome: 'updated', status: synced, tx: result.tx, signer: result.signer };
  } catch (err) {
    if (isProfileNodeIdTakenError(err)) {
      return { outcome: 'taken', status: { ...status, expectedNodeIdTaken: true } };
    }
    if (isProfileNodeIdUpdateUnsupportedError(err)) {
      return { outcome: 'unsupported', status: { ...status, support: err.support } };
    }
    throw err;
  }
}

/** One operator-facing line for a sync outcome. */
export function describeProfileNodeIdSync(result: ProfileNodeIdSyncResult): string {
  const { status } = result;
  switch (result.outcome) {
    case 'updated':
      return `Profile nodeId of identity ${status.identityId} now names this node's peer id ${status.peerId}` +
        (result.tx ? ` (tx ${result.tx.hash})` : '');
    case 'in-sync':
      return `Profile nodeId of identity ${status.identityId} already names this node's peer id ${status.peerId}`;
    case 'no-profile':
      return 'This node has no on-chain profile yet; there is no nodeId to sync';
    case 'unsupported': {
      const version = status.support.profileVersion ? `v${status.support.profileVersion}` : 'an unknown version';
      return `The deployed Profile contract (${version} at ${status.support.profileAddress}) cannot update ` +
        `nodeIds; it needs Profile >= ${status.support.requiredVersion}. The on-chain nodeId stays as it is`;
    }
    case 'taken': {
      const holder = status.expectedNodeIdHolder === null
        ? 'another identity'
        : `identity ${status.expectedNodeIdHolder}`;
      return `This node's peer id ${status.peerId} is already registered as the nodeId of ${holder}, so ` +
        `identity ${status.identityId} cannot claim it. If that identity is not yours, report it to the ` +
        'network operators (the Hub owner can release a squatted nodeId)';
    }
    case 'skipped-other-peer':
      return `The on-chain nodeId of identity ${status.identityId} names a different peer id ` +
        `(${status.onChainPeerId}); it is not overwritten automatically. If this node replaced that one, ` +
        'run "dkg identity sync-node-id"';
  }
}
