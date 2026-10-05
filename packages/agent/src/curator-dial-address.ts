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
