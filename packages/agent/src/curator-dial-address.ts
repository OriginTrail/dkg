// SPDX-License-Identifier: Apache-2.0

import {
  canonicalPeerIdString,
  isIpLoopbackAddress,
  isLoopbackAddress,
  isPublicLikeAddress,
  isUnspecifiedAddress,
  parseLibp2pConnectCandidate,
} from '@origintrail-official/dkg-core';

/** Validate a persisted or received curator address against its expected peer. */
export function verifiedCuratorDialAddress(value: unknown, peerId: string): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try {
    const candidate = parseLibp2pConnectCandidate(value, {
      requireTerminalTargetPeerId: true,
    });
    return candidate.targetPeerId === canonicalPeerIdString(peerId)
      ? candidate.address
      : undefined;
  } catch {
    return undefined;
  }
}

/** Prefer a remotely usable listener unless the authenticated requester is local. */
export function selectCuratorJoinDialAddress(
  addresses: readonly string[],
  peerId: string,
  options: { preferLoopback?: boolean } = {},
): string | undefined {
  let directLoopback: string | undefined;
  let loopbackCircuit: string | undefined;
  let publicAddress: string | undefined;
  let privateRemote: string | undefined;
  for (const address of addresses) {
    const verified = verifiedCuratorDialAddress(address, peerId);
    if (!verified || isUnspecifiedAddress(verified)) continue;
    if (isLoopbackAddress(verified)) {
      if (verified.includes('/p2p-circuit')) loopbackCircuit ??= verified;
      else directLoopback ??= verified;
      continue;
    }
    if (isPublicLikeAddress(verified)) publicAddress ??= verified;
    else privateRemote ??= verified;
  }
  return options.preferLoopback
    ? directLoopback ?? loopbackCircuit ?? publicAddress ?? privateRemote
    : publicAddress ?? privateRemote ?? directLoopback ?? loopbackCircuit;
}

/** A direct loopback connection proves the exact requester can use a local listener. */
export function requesterHasDirectLoopbackConnection(
  connections: readonly { remotePeer: { toString(): string }; remoteAddr?: { toString(): string } }[],
  requesterPeerId: string | undefined,
): boolean {
  if (!requesterPeerId) return false;
  return connections.some((connection) => {
    if (connection.remotePeer.toString() !== requesterPeerId) return false;
    const address = connection.remoteAddr?.toString();
    return address !== undefined
      && !address.includes('/p2p-circuit')
      && isIpLoopbackAddress(address);
  });
}
