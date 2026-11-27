import { toLibp2pPeerId } from './peer-id.js';

function protocolReadinessAbortError(): DOMException {
  return new DOMException('Protocol readiness wait aborted', 'AbortError');
}

function throwIfProtocolReadinessAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw protocolReadinessAbortError();
}

/**
 * Poll the libp2p peer store until `peer` advertises `protocol` (for a list,
 * any one of them), reading it up to `attempts` times, `delayMs` apart.
 *
 * The peer store answers only for a real libp2p `PeerId`, so `peer` is
 * canonicalized first and a string-backed `{ toString }` wrapper is looked
 * up by the PeerId it names. A value that is not a peer ID can never
 * advertise the protocol and resolves `false` without a store read.
 *
 * An aborted `signal` rejects with an AbortError on every path: before the
 * parse, before each read and during the delay between reads.
 */
export async function waitForPeerProtocol(
  peerStore: { get(peer: unknown): Promise<{ protocols: string[] }> },
  peer: { toString(): string },
  protocol: string | readonly string[],
  attempts: number,
  delayMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfProtocolReadinessAborted(signal);
  const peerId = toLibp2pPeerId(peer);
  if (peerId === undefined) return false;
  const wanted = typeof protocol === 'string' ? [protocol] : protocol;

  for (let attempt = 0; attempt < attempts; attempt++) {
    throwIfProtocolReadinessAborted(signal);
    try {
      const peerInfo = await peerStore.get(peerId);
      if (wanted.some((id) => peerInfo.protocols.includes(id))) {
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
          reject(protocolReadinessAbortError());
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

/** A stale Identify record is not proof that a connected peer lacks a late-registered handler. */
export async function waitForAdvertisedOrLiveProtocol(options: {
  peerStore: { get(peer: unknown): Promise<{ protocols: string[] }> };
  peer: { toString(): string };
  protocols: readonly string[];
  attempts: number;
  delayMs: number;
  signal?: AbortSignal;
  isConnected(peerId: string): boolean;
  probe(peerId: string, protocol: string, signal?: AbortSignal): Promise<'supported' | 'unsupported' | 'unavailable'>;
}): Promise<boolean> {
  const { peerStore, peer, protocols, attempts, delayMs, signal } = options;
  if (await waitForPeerProtocol(peerStore, peer, protocols, attempts, delayMs, signal)) return true;
  throwIfProtocolReadinessAborted(signal);
  const peerId = toLibp2pPeerId(peer)?.toString();
  if (peerId === undefined || !options.isConnected(peerId)) return false;
  for (const protocol of protocols) {
    const outcome = await options.probe(peerId, protocol, signal);
    throwIfProtocolReadinessAborted(signal);
    if (outcome === 'supported') return true;
  }
  return false;
}
