// SPDX-License-Identifier: Apache-2.0

import { multiaddr } from '@multiformats/multiaddr';

/** Validate a persisted or received curator address against its expected peer. */
export function verifiedCuratorDialAddress(value: unknown, peerId: string): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try {
    const address = multiaddr(value).toString();
    return address.endsWith(`/p2p/${peerId}`) ? address : undefined;
  } catch {
    return undefined;
  }
}
