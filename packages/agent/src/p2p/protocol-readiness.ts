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
