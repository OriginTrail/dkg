import { peerIdFromMultihash } from '@libp2p/peer-id';
import type { Network, PeerResolver } from '@origintrail-official/dkg-core';
import type {
  WalProviderPath,
  WalProviderResolutionAdapter,
} from '@origintrail-official/dkg-wal/discovery';
import { parseMultiaddrConnectTarget } from '../p2p/multiaddr-peer-target.js';

export interface DkgWalProviderResolutionAdapterOptions {
  readonly network: Pick<Network, 'addKnownAddresses' | 'getConnections'>;
  readonly peerResolver: Pick<PeerResolver, 'resolve'>;
  readonly perStepTimeoutMs?: number;
}

function readUnsignedVarint(bytes: Uint8Array, initialOffset: number): { value: number; offset: number } {
  let value = 0n;
  let shift = 0n;
  for (let offset = initialOffset; offset < bytes.length && offset - initialOffset < 10; offset += 1) {
    const byte = bytes[offset];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (offset > initialOffset && byte === 0) throw new TypeError('WAL provider peerId uses a non-canonical multihash varint');
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new TypeError('WAL provider peerId multihash varint is too large');
      return { value: Number(value), offset: offset + 1 };
    }
    shift += 7n;
  }
  throw new TypeError('WAL provider peerId contains a truncated multihash varint');
}

function peerIdString(canonicalMultihashBytes: Uint8Array): string {
  if (!(canonicalMultihashBytes instanceof Uint8Array) || canonicalMultihashBytes.length === 0) {
    throw new TypeError('WAL provider peerId must contain canonical multihash bytes');
  }
  const code = readUnsignedVarint(canonicalMultihashBytes, 0);
  const size = readUnsignedVarint(canonicalMultihashBytes, code.offset);
  if (size.offset + size.value !== canonicalMultihashBytes.length) {
    throw new TypeError('WAL provider peerId contains trailing multihash bytes');
  }
  const digest = canonicalMultihashBytes.slice(size.offset);
  return peerIdFromMultihash({
    code: code.value,
    size: size.value,
    digest,
    bytes: new Uint8Array(canonicalMultihashBytes),
  }).toString();
}

function pathKind(address: string, live: ReadonlySet<string>): WalProviderPath['kind'] {
  if (live.has(address)) return 'live';
  if (address.includes('/p2p-circuit/')) return 'relay';
  return 'direct';
}

function pathPriority(kind: WalProviderPath['kind']): number {
  switch (kind) {
    case 'live': return 7;
    case 'direct': return 6;
    case 'dht': return 5;
    case 'directory': return 4;
    case 'relay': return 3;
    case 'signed': return 2;
    case 'persisted': return 1;
  }
}

/**
 * Adapts signed WAL provider entries to the existing DKG PeerResolver.
 *
 * Signed and persisted endpoints are untrusted hints. Each one is parsed,
 * checked against the target peer when it carries a `/p2p` component, and
 * successfully merged into the real network address book before it is
 * returned as usable. The normal resolver then adds live, DHT, registry,
 * agent-directory, and relay paths without making any one source authoritative.
 */
export function createDkgWalProviderResolutionAdapter(
  options: DkgWalProviderResolutionAdapterOptions,
): WalProviderResolutionAdapter {
  if (!options?.network || !options.peerResolver) {
    throw new TypeError('WAL provider resolution requires the existing DKG network and PeerResolver');
  }
  if (
    options.perStepTimeoutMs !== undefined
    && (!Number.isSafeInteger(options.perStepTimeoutMs) || options.perStepTimeoutMs <= 0)
  ) {
    throw new TypeError('WAL provider perStepTimeoutMs must be a positive safe integer');
  }

  return {
    async resolve(peerIdBytes, signedEndpoints, persistedEndpoints, resolveOptions) {
      if (resolveOptions?.signal?.aborted) return [];
      const peerId = peerIdString(peerIdBytes);
      const paths: WalProviderPath[] = [];
      const indices = new Map<string, number>();
      const append = (address: string, kind: WalProviderPath['kind']): void => {
        const index = indices.get(address);
        if (index === undefined) {
          indices.set(address, paths.length);
          paths.push({ address, kind });
        } else if (pathPriority(kind) > pathPriority(paths[index].kind)) {
          paths[index] = { address, kind };
        }
      };

      let live = new Set<string>();
      try {
        live = new Set(options.network.getConnections(peerId).map(connection => connection.remoteAddr.toString()));
      } catch {
        // A malformed/stale connection cache must not block the remaining paths.
      }

      const prime = async (endpoints: readonly string[], kind: 'signed' | 'persisted'): Promise<void> => {
        for (const endpoint of endpoints) {
          if (resolveOptions?.signal?.aborted) return;
          try {
            const parsed = parseMultiaddrConnectTarget(endpoint);
            if (parsed.targetPeerId !== undefined && parsed.targetPeerId !== peerId) continue;
            await options.network.addKnownAddresses(peerId, [parsed.multiaddress]);
            append(parsed.multiaddress, live.has(parsed.multiaddress) ? 'live' : kind);
          } catch {
            // Malformed or unmergeable hints are ignored independently.
          }
        }
      };

      await prime(signedEndpoints, 'signed');
      await prime(persistedEndpoints, 'persisted');
      if (resolveOptions?.signal?.aborted) return paths;

      const resolved = await options.peerResolver.resolve(peerId, {
        signal: resolveOptions?.signal,
        perStepTimeoutMs: options.perStepTimeoutMs,
      });
      for (const address of resolved) append(address, pathKind(address, live));
      return paths;
    },
  };
}
