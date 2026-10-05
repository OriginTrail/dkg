// SPDX-License-Identifier: Apache-2.0

import { canonicalPeerIdString, parseLibp2pConnectCandidate } from '@origintrail-official/dkg-core';

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
  let remote: string | undefined;
  for (const address of addresses) {
    const verified = verifiedCuratorDialAddress(address, peerId);
    if (!verified || verified.startsWith('/ip4/0.0.0.0/') || verified.startsWith('/ip6/::/')) continue;
    if (
      /^\/ip4\/127(?:\.\d{1,3}){3}\//.test(verified)
      || /^\/ip6\/(?:::1|0:0:0:0:0:0:0:1)\//i.test(verified)
      || /^\/dns(?:4|6|addr)?\/(?:localhost|[^/]+\.localhost)\//i.test(verified)
    ) {
      if (verified.includes('/p2p-circuit')) loopbackCircuit ??= verified;
      else directLoopback ??= verified;
      continue;
    }
    remote ??= verified;
  }
  return options.preferLoopback
    ? directLoopback ?? loopbackCircuit ?? remote
    : remote ?? directLoopback ?? loopbackCircuit;
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
      && (/^\/ip4\/127(?:\.\d{1,3}){3}\//.test(address)
        || /^\/ip6\/(?:::1|0:0:0:0:0:0:0:1)\//i.test(address));
  });
}
