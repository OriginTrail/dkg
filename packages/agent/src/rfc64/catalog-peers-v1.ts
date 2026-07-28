// SPDX-License-Identifier: Apache-2.0

/** Canonical bounded peer-list snapshot shared by catalog config and fan-out. */

export const RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 = 64;
const RFC64_PUBLIC_CATALOG_PEER_ID_MAX_BYTES_V1 = 256;
const UTF8 = new TextEncoder();

export function snapshotRfc64PublicCatalogAnnouncementPeersV1(
  input: readonly string[],
): readonly string[] {
  if (!Array.isArray(input)) {
    throw new TypeError('RFC-64 catalog announcement peers must be an array');
  }
  if (input.length > RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1) {
    throw new RangeError(
      `RFC-64 catalog announcement accepts at most `
      + `${RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1} peers`,
    );
  }
  const seen = new Set<string>();
  const peers: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const peerId = input[index];
    const byteLength = typeof peerId === 'string' ? UTF8.encode(peerId).byteLength : 0;
    if (
      typeof peerId !== 'string'
      || byteLength === 0
      || byteLength > RFC64_PUBLIC_CATALOG_PEER_ID_MAX_BYTES_V1
      || peerId.trim() !== peerId
    ) {
      throw new TypeError(`RFC-64 catalog announcement peer ${index} is invalid`);
    }
    if (seen.has(peerId)) {
      throw new TypeError(`RFC-64 catalog announcement peer ${index} is duplicated`);
    }
    seen.add(peerId);
    peers.push(peerId);
  }
  return Object.freeze(peers);
}
