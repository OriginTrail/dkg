// SPDX-License-Identifier: Apache-2.0
import { PublicSnapshotUnavailableError } from './public-snapshot-reader.js';
import { PUBLIC_SNAPSHOT_ADMISSION_WINDOW_MS } from './public-snapshot-admission.js';
import { waitForPublicSnapshotRetry } from './public-snapshot-exact-pacing.js';
import type { PublicSnapshotObservation } from './public-snapshot-evidence.js';

/** Pace opaque serving refusals without renewing the caller's lifetime or authority. */
export async function readPublicSnapshotWithAdmission(options: {
  read(): Promise<PublicSnapshotObservation>;
  signal: AbortSignal; deadline: number; assertCurrent(): void;
}): Promise<PublicSnapshotObservation> {
  const active = () => {
    options.signal.throwIfAborted(); options.assertCurrent();
    if (Date.now() >= options.deadline) throw new Error('Snapshot read exceeded the original job deadline');
  };
  for (;;) {
    active();
    try { const observation = await options.read(); active(); return observation; }
    catch (error) {
      active();
      if (!(error instanceof PublicSnapshotUnavailableError)) throw error;
      // Unavailable deliberately hides private/missing/busy. Re-observe after
      // one full admission window; short waits retain the ownership fence.
      await waitForPublicSnapshotRetry(Math.min(Date.now() + PUBLIC_SNAPSHOT_ADMISSION_WINDOW_MS, options.deadline),
        options.signal, active);
    }
  }
}
