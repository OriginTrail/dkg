// SPDX-License-Identifier: Apache-2.0
import type { ProtocolRouter } from '@origintrail-official/dkg-core';

export interface PublicSnapshotSupplierHost {
  readonly router: Pick<ProtocolRouter, 'probeProtocol'>;
  ensurePeerConnected(peer: string, options: { signal: AbortSignal }): Promise<void>;
}

/** Ordered discovery only. Each caller owns transfer, retry and commit policy. */
export async function* publicSnapshotSuppliers(host: PublicSnapshotSupplierHost, options: {
  protocol: string; peerBatches(): AsyncIterable<readonly string[]>;
  signal: AbortSignal; deadline: number; assertCurrent(): void; deadlineMessage: string;
}): AsyncGenerator<string> {
  const { signal, assertCurrent, deadline } = options;
  const assertLive = () => {
    signal.throwIfAborted(); assertCurrent();
    if (Date.now() >= deadline) throw new Error(options.deadlineMessage);
  };
  for await (const peers of options.peerBatches()) for (const peer of peers) {
    assertLive();
    try {
      await host.ensurePeerConnected(peer, { signal });
      assertLive();
      const supported = await host.router.probeProtocol(peer, options.protocol,
        Math.min(3_000, deadline - Date.now()), signal);
      assertLive();
      if (supported === 'supported') yield peer;
    } catch {
      // A peer refusal permits discovery to continue; a retired job does not.
      assertLive();
    }
  }
}
