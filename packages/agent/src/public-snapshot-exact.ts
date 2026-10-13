// SPDX-License-Identifier: Apache-2.0
import type { DKGAgent } from './dkg-agent.js';
import type { PublicSnapshotRecoveryOptions, PublicSnapshotRecoveryResult } from './public-snapshot-recovery.js';

export async function recoverPublicSnapshotExact(agent: DKGAgent, options: PublicSnapshotRecoveryOptions): Promise<PublicSnapshotRecoveryResult> {
  const { contextGraphId, peers, uals, evidence, signal, assertCurrent } = options;
  const committed = new Set<string>();
  const isCurrent = () => { try { assertCurrent(); return true; } catch { return false; } };
  const recover = async (batch: string[], transport: "stream-preferred" | "legacy") => {
    for (const peer of peers) {
      assertCurrent();
      const remaining = batch.filter(ual => !committed.has(ual));
      if (!remaining.length) break;
      const result = await agent.syncExactKnowledgeAssetsFromPeerDetailed(peer, contextGraphId, remaining, {
        signal, isCurrent, forceFreshExactSession: true,
        exactRecoveryTransportMode: transport,
        recoveryAuthority: evidence,
        totalTimeoutMs: 120_000,
      });
      for (const ual of result.committedExactAssetUals ?? []) committed.add(ual);
    }
    return batch.filter(ual => !committed.has(ual));
  };
  for (let offset = 0; offset < uals.length; offset += 10) {
    const batch = uals.slice(offset, offset + 10);
    const remaining = await recover(batch, "stream-preferred");
    // The stream profile excludes private commitments. Only missing assets
    // use the bounded singleton transport, with identical authentication.
    for (const ual of remaining) await recover([ual], "legacy");
    if (batch.some(ual => !committed.has(ual)))
      throw new Error(`Snapshot recovery incomplete: ${committed.size}/${uals.length} committed`);
  }
  return { committed };
}
