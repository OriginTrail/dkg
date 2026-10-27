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
interface RecoverySelection {
  readonly uals: readonly string[];
  readonly transport: ExactTransport;
  readonly answered: Set<string>;
}
type SelectionPass = { kind: 'complete' | 'answered' }
  | { kind: 'wait'; reason: 'admission' | 'peer' };

/**
 * Ten-asset batches from the configured peers in turn. A refusal that says
 * nothing about a peer's data (local sync capacity in use, a busy responder)
 * is waited out inside the job's limit; only peers' answers and the limit end
 * the job. Assets already stored as the snapshot pins them are not fetched.
 */
export async function recoverPublicSnapshotExact(host: DurableRecoveryHost, options: PublicSnapshotExactRecoveryOptions): Promise<PublicSnapshotRecoveryResult> {
  const { contextGraphId, uals, evidence, signal, assertCurrent, deadline } = options;
  const committed = new Set<string>();
  let lastCompletePeer: string | undefined;
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
    // A completed, verified batch is a scheduling hint within this job only.
    // It grants no authority or coverage for any later asset; all other
    // admitted providers remain available, with unchanged retry/hold rules.
    if (result.streamOutcome === 'complete' && result.disposition === 'found'
      && selection.every(ual => result.committedExactAssetUals?.includes(ual))) lastCompletePeer = peer;
    return pacing.settle(peer, result, committed.size - before);
  };
  // One pass reports what happened. Only the scheduler below advances
  // discovery or waits; answer history belongs to the asset selection.
  const pass = async (selection: RecoverySelection, peers: readonly string[]): Promise<SelectionPass> => {
    let wait: 'admission' | 'peer' | undefined;
    const ordered = lastCompletePeer && peers.includes(lastCompletePeer)
      ? [lastCompletePeer, ...peers.filter(peer => peer !== lastCompletePeer)] : peers;
    for (const peer of ordered) {
      const remaining = selection.uals.filter(ual => !committed.has(ual));
      if (!remaining.length) return { kind: 'complete' };
      if (selection.answered.has(peer)) continue;
      if (pacing.heldOff(peer)) { wait ??= 'peer'; continue; }
      assertActive();
      const verdict = await attempt(peer, remaining, selection.transport);
      if (verdict === 'answered') selection.answered.add(peer);
      else if (verdict === 'retry-peer') wait ??= 'peer';
      // Capacity is node-local: the other peers would meet the same refusal.
      else { wait = 'admission'; break; }
    }
    if (selection.uals.every(ual => committed.has(ual))) return { kind: 'complete' };
    return wait ? { kind: 'wait', reason: wait } : { kind: 'answered' };
  };
  for (let offset = 0; offset < uals.length; offset += 10) {
    const batch = uals.slice(offset, offset + 10);
    await skipHeld(batch);
    const selections: RecoverySelection[] = [
      { uals: batch, transport: 'stream-preferred', answered: new Set() },
      // The stream profile excludes private commitments. Only missing assets
      // use the bounded singleton transport, with identical authentication.
      ...batch.map(ual => ({ uals: [ual], transport: 'legacy' as const, answered: new Set<string>() })),
    ];
    const admitted = new Set<string>();
    const discovery = options.peerBatches()[Symbol.asyncIterator]();
    let discoveryDone = false, index = selections.length;
    let peers: readonly string[] = [];
    try {
      while (batch.some(ual => !committed.has(ual))) {
        assertActive();
        if (index === selections.length) {
          if (discoveryDone) throw incomplete();
          const next = await discovery.next();
          discoveryDone = next.done === true;
          peers = discoveryDone ? [...admitted] : next.value;
          if (!discoveryDone) peers.forEach(peer => admitted.add(peer));
          index = 0;
        }
        const selection = selections[index]!;
        const result = await pass(selection, peers);
        // Busy suppliers never hide later undiscovered healthy suppliers.
        if (result.kind !== 'wait' || (result.reason === 'peer' && !discoveryDone)) { index++; continue; }
        host.log.info(ctx, `Snapshot recovery for "${contextGraphId}" is waiting for `
          + `${result.reason === 'admission' ? 'local sync capacity' : 'a busy core'}: ${committed.size}/${uals.length} committed`);
        const waited = result.reason === 'admission' ? await pacing.waitForAdmission()
          : await pacing.waitForPeer(peers.filter(peer => !selection.answered.has(peer)));
        if (!waited) throw incomplete(result.reason === 'admission'
          ? 'local sync capacity stayed in use' : 'the configured cores stayed busy');
        // Another sync may have stored some of these while the job waited.
        await skipHeld(selection.uals);
      }
    } finally {
      if (!discoveryDone) await discovery.return?.();
    }
  }
  return { committed, alreadyPresent };
}
