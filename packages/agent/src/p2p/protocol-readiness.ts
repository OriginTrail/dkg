export async function waitForPeerProtocol(
  peerStore: { get(peer: unknown): Promise<{ protocols: string[] }> },
  peer: { toString(): string },
  protocol: string,
  attempts: number,
  delayMs: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const peerInfo = await peerStore.get(peer as any);
      if (peerInfo.protocols.includes(protocol)) {
        return true;
      }
    } catch {
      // Peer metadata might not be available yet.
    }

    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return false;
}
