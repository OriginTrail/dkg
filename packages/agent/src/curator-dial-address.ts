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

/** Prefer a remotely usable listener, retaining loopback for local devnets. */
export function selectCuratorJoinDialAddress(addresses: readonly string[], peerId: string): string | undefined {
  let loopback: string | undefined;
  for (const address of addresses) {
    const verified = verifiedCuratorDialAddress(address, peerId);
    if (!verified || verified.startsWith('/ip4/0.0.0.0/') || verified.startsWith('/ip6/::/')) continue;
    if (
      /^\/ip4\/127(?:\.\d{1,3}){3}\//.test(verified)
      || /^\/ip6\/(?:::1|0:0:0:0:0:0:0:1)\//i.test(verified)
      || /^\/dns(?:4|6|addr)?\/(?:localhost|[^/]+\.localhost)\//i.test(verified)
    ) {
      loopback ??= verified;
      continue;
    }
    return verified;
  }
  return loopback;
}
