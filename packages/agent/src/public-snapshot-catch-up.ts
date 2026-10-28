// SPDX-License-Identifier: Apache-2.0
import { assertPublicSnapshotScopeAndAnchor } from './public-snapshot-scope.js';
import { PublicSnapshotUnavailableError } from './public-snapshot-reader.js';
import { PUBLIC_SNAPSHOT_ADMISSION_WINDOW_MS } from './public-snapshot-admission.js';
import { waitForPublicSnapshotRetry } from './public-snapshot-exact-pacing.js';
import type { PublicSnapshotObservation } from './public-snapshot-evidence.js';
import type { PublicSnapshotRecoveryResult } from './public-snapshot-recovery.js';

/** One owned job follows validated inventories; no round renews its lifetime. */
export async function recoverPublicSnapshotToCurrent(options: {
  initial: PublicSnapshotObservation;
  deadline: number;
  signal: AbortSignal;
  assertCurrent(): void;
  readFresh(): Promise<PublicSnapshotObservation>;
  recover(observation: PublicSnapshotObservation): Promise<PublicSnapshotRecoveryResult>;
}) {
  const active = () => {
    options.signal.throwIfAborted();
    options.assertCurrent();
    if (Date.now() >= options.deadline) throw new Error('Snapshot catch-up exceeded the original job deadline');
  };
  const readFresh = async (): Promise<PublicSnapshotObservation> => {
    for (;;) {
      active();
      try { return await options.readFresh(); }
      catch (error) {
        active();
        if (!(error instanceof PublicSnapshotUnavailableError)) throw error;
        // The wire deliberately hides whether refusal means private, missing or
        // busy. Wait a full serving admission window; never relax validation or
        // extend this job. Short slices retain the ownership fence while waiting.
        await waitForPublicSnapshotRetry(Math.min(Date.now() + PUBLIC_SNAPSHOT_ADMISSION_WINDOW_MS, options.deadline),
          options.signal, active);
      }
    }
  };
  let observation = options.initial, rounds = 0;
  const bulkChunks: NonNullable<PublicSnapshotRecoveryResult['bulkChunks']> = [];
  while (true) {
    active();
    const recovered = await options.recover(observation);
    active();
    rounds++;
    if (recovered.bulkChunks) bulkChunks.push(...recovered.bulkChunks);
    const fresh = await readFresh();
    active();
    assertPublicSnapshotProgress(observation, fresh);
    const previous = observation.snapshot, next = fresh.snapshot;
    if (next.inventoryDigest === previous.inventoryDigest) {
      return { observation, fresh, recovered, rounds,
        bulkChunks: recovered.bulkChunks === undefined ? undefined : bulkChunks };
    }
    // Each round authenticates with its new pins and rechecks held assets.
    // Merely having committed a UAL in an earlier round never grants coverage.
    observation = fresh;
  }
}

/** Shared by catch-up and a checkpoint's first authority read after activation/restart. */
export function assertPublicSnapshotProgress(observation: PublicSnapshotObservation, fresh: PublicSnapshotObservation): void {
  const previous = observation.snapshot, next = fresh.snapshot;
  assertPublicSnapshotScopeAndAnchor(observation, fresh);
  const nextIds = new Set(next.assets.map(asset => asset.id));
  // Catch-up can add or replace authenticated content, but cannot silently
  // authorize old stored data after a member disappears from the inventory.
  if (previous.assets.some(asset => !nextIds.has(asset.id)))
    throw new Error('Snapshot catch-up inventory removed previously pinned assets');
}
