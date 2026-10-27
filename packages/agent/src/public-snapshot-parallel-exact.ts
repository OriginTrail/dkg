// SPDX-License-Identifier: Apache-2.0
import type { DurableRecoveryHost } from './durable-recovery-host.js';
import { recoverPublicSnapshotExact, type PublicSnapshotExactRecoveryOptions } from './public-snapshot-exact.js';

/** Allow two disjoint lanes when at least two admitted suppliers are available.
 * The exact recovery entry point owns progress, pacing, cancellation and drain. */
export function recoverPublicSnapshotParallelExact(host: DurableRecoveryHost, options: PublicSnapshotExactRecoveryOptions) {
  return recoverPublicSnapshotExact(host, options, 2);
}
