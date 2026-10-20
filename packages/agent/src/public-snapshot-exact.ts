import * as exactRecovery from './exact-recovery-execution.js';
import type { DurableRecoveryHost } from './durable-recovery-host.js';
import { createUalOnlyExactAssetSelection } from './sync/exact-assets.js';
import { exactAssetFetchSessionPolicy } from './sync/requester/exact-durable-fetch.js';
import { createOperationContext } from '@origintrail-official/dkg-core';
// SPDX-License-Identifier: Apache-2.0
import type { PublicSnapshotRecoveryOptions, PublicSnapshotRecoveryResult } from './public-snapshot-recovery.js';
import { PublicSnapshotRecoveryPacing } from './public-snapshot-exact-pacing.js';

export interface PublicSnapshotExactRecoveryOptions extends PublicSnapshotRecoveryOptions {
  /** Epoch milliseconds at which the job ends. */
  readonly deadline: number;
  /** Whether this node's sync admission would take the graph's exact fetch now. */
  readonly canAdmit?: () => boolean;
  /** Whether the asset is already stored as the snapshot pins it. */
  readonly holds?: (ual: string) => Promise<boolean>;
}

type ExactTransport = 'stream-preferred' | 'legacy';

/**
 * Ten-asset batches from the configured peers in turn. A refusal that says
 * nothing about a peer's data (local sync capacity in use, a busy responder)
 * is waited out inside the job's limit; only peers' answers and the limit end
 * the job. Assets already stored as the snapshot pins them are not fetched.
 */
export async function recoverPublicSnapshotExact(host: DurableRecoveryHost, options: PublicSnapshotExactRecoveryOptions): Promise<PublicSnapshotRecoveryResult> {
  const { contextGraphId, uals, evidence, signal, assertCurrent, deadline } = options;
  const committed = new Set<string>();
  let alreadyPresent = 0;
  const ctx = createOperationContext('sync');
  const isCurrent = () => { try { assertCurrent(); return true; } catch { return false; } };
  const pacing = new PublicSnapshotRecoveryPacing({ contextGraphId, deadline, signal, assertCurrent, canAdmit: options.canAdmit });
  const incomplete = (reason?: string) => new Error(
    `Snapshot recovery incomplete: ${committed.size}/${uals.length} committed${reason ? ` (${reason})` : ''}`);
  const assertActive = () => {
    if (Date.now() >= deadline) throw incomplete('job time limit reached');
    assertCurrent();
  };
  const skipHeld = async (batch: readonly string[]) => {
    for (const ual of batch) {
      if (committed.has(ual) || !options.holds) continue;
      assertActive();
      if (await options.holds(ual)) { committed.add(ual); alreadyPresent += 1; }
    }
  };
  const attempt = async (peer: string, selection: string[], transport: ExactTransport) => {
    const result = await exactRecovery.runExactRecovery({
      host, ctx,
      remotePeerId: peer, contextGraphId, policy: exactAssetFetchSessionPolicy(createUalOnlyExactAssetSelection(selection), 'vm-update-refresh'), authority: evidence,
      options: {
        signal, isCurrent,
        exactRecoveryTransportMode: transport,
        totalTimeoutMs: pacing.attemptTimeoutMs(),
      },
    });
    const before = committed.size;
    for (const ual of result.committedExactAssetUals ?? []) committed.add(ual);
    return pacing.settle(peer, result, committed.size - before);
  };
  // Ask the peers for one selection until it is stored, every peer has
  // answered for it, or the job ends.
  const recover = async (batch: readonly string[], transport: ExactTransport, peers: readonly string[]) => {
    const answered = new Set<string>();
    for (;;) {
      let wait: 'admission' | 'peer' | undefined;
      for (const peer of peers) {
        const remaining = batch.filter(ual => !committed.has(ual));
        if (!remaining.length) return;
        if (answered.has(peer)) continue;
        if (pacing.heldOff(peer)) { wait ??= 'peer'; continue; }
        assertActive();
        const verdict = await attempt(peer, remaining, transport);
        if (verdict === 'answered') answered.add(peer);
        else if (verdict === 'retry-peer') wait ??= 'peer';
        // Capacity is node-local: the other peers would meet the same refusal.
        else { wait = 'admission'; break; }
      }
      if (wait === undefined || batch.every(ual => committed.has(ual))) return;
      host.log.info(ctx, `Snapshot recovery for "${contextGraphId}" is waiting for `
        + `${wait === 'admission' ? 'local sync capacity' : 'a busy core'}: ${committed.size}/${uals.length} committed`);
      const waited = wait === 'admission'
        ? await pacing.waitForAdmission()
        : await pacing.waitForPeer(peers.filter(peer => !answered.has(peer)));
      if (!waited) throw incomplete(wait === 'admission' ? 'local sync capacity stayed in use' : 'the configured cores stayed busy');
      // Another sync may have stored some of these while the job waited.
      await skipHeld(batch);
    }
  };
  for (let offset = 0; offset < uals.length; offset += 10) {
    const batch = uals.slice(offset, offset + 10);
    await skipHeld(batch);
    for await (const peers of options.peerBatches()) {
      await recover(batch, "stream-preferred", peers);
      // The stream profile excludes private commitments. Only missing assets
      // use the bounded singleton transport, with identical authentication.
      for (const ual of batch) if (!committed.has(ual)) await recover([ual], "legacy", peers);
      if (batch.every(ual => committed.has(ual))) break;
    }
    if (batch.some(ual => !committed.has(ual))) throw incomplete();
  }
  return { committed, alreadyPresent };
}
