import { peerIdFromString } from '@libp2p/peer-id';

type Libp2pPeerId = ReturnType<typeof peerIdFromString>;

/**
 * libp2p's `isPeerId`, which lives in `@libp2p/interface` (not a direct
 * dependency of this package), is exactly a check for this global symbol.
 */
const LIBP2P_PEER_ID_SYMBOL = Symbol.for('@libp2p/peer-id');

function isLibp2pPeerId(value: unknown): value is Libp2pPeerId {
  return Boolean((value as Record<symbol, unknown> | null | undefined)?.[LIBP2P_PEER_ID_SYMBOL]);
}

/**
 * Resolve the key the libp2p peer store can answer for. `@libp2p/peer-store`
 * rejects anything that is not a real `PeerId` with
 * `InvalidParametersError('Invalid PeerId')`, so a string-backed
 * `{ toString: () => peerId }` wrapper can never be looked up as-is.
 *
 * A real PeerId passes through unchanged. Anything else is parsed from its
 * string form; a value that is not a peer ID yields `undefined`, never a throw.
 */
export function toLibp2pPeerId(peer: { toString(): string }): Libp2pPeerId | undefined {
  if (isLibp2pPeerId(peer)) return peer;
  try {
    return peerIdFromString(String(peer));
  } catch {
    return undefined;
  }
}

export async function waitForPeerProtocol(
  peerStore: { get(peer: unknown): Promise<{ protocols: string[] }> },
  peer: { toString(): string },
  protocol: string,
  attempts: number,
  delayMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Protocol readiness wait aborted', 'AbortError');
    }
    try {
      const peerInfo = await peerStore.get(peer as any);
      if (peerInfo.protocols.includes(protocol)) {
        return true;
      }
    } catch {
      // Peer metadata might not be available yet.
    }

    if (attempt < attempts - 1) {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => {
          cleanup();
          reject(new DOMException('Protocol readiness wait aborted', 'AbortError'));
        };
        timer = setTimeout(() => {
          cleanup();
          resolve();
        }, delayMs);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  return false;
}
