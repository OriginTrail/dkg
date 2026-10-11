// SPDX-License-Identifier: Apache-2.0
import type { SwmHostModeStoreLimits } from '../swm/host-mode-store.js';

/**
 * OT-RFC-38 LU-6 — settings for the core-side host-mode SWM store.
 * Only honoured when `nodeRole === 'core'`. Omit on edges (the
 * store is never initialized there).
 *
 * Fields:
 *  - `enabled`: when `false`, cores skip host-mode entirely and behave like edges. Default `true` for cores.
 *  - `hostPublic`: when `true`, cores also host fully public + open-publish
 *    CG SWM. This is opt-in because public SWM is plaintext and hosting it
 *    consumes core disk/mesh capacity; curated/private custody remains
 *    governed by `stripCiphertext`.
 *  - `unregistered`: TTL/byte-cap for CGs the core knows about but that aren't on-chain registered yet.
 *  - `registered`: TTL/byte-cap for on-chain registered CGs (typically larger).
 *  - `pruneIntervalMs`: how often the TTL/cap sweep runs.
 *  - `reconcileIntervalMs`: how often the host-mode subscription reconciler ensures cores are subscribed to known eligible CGs.
 *  - `reconcileBatchSize`: max known CGs reconciled per tick. Default 32.
 *  - `reconcileJitterRatio`: startup interval jitter ratio in [0, 1]. Default 0.15.
 */
export interface SwmHostModeConfig {
  enabled?: boolean;
  hostPublic?: boolean;
  unregistered?: SwmHostModeStoreLimits;
  registered?: SwmHostModeStoreLimits;
  pruneIntervalMs?: number;
  reconcileIntervalMs?: number;
  reconcileBatchSize?: number;
  reconcileJitterRatio?: number;
  /**
   * OT-RFC-38 / LU-6 Phase B — discovery-beacon rate limits for
   * pre-registration (freemium-tier) ciphertext writes. All three
   * fields are optional; omit any to use the default from
   * {@link DiscoveryRateLimit}.
   *  - `perCuratorBytesPerMinute` — SPEC §1.2.4 default 1 MiB.
   *  - `perCuratorBytesPerHour`   — SPEC §1.2.4 default 50 MiB.
   *  - `coreAggregateBytes`       — across-all-wallets cap; default 4 GiB.
   */
  discoveryRateLimit?: {
    perCuratorBytesPerMinute?: number;
    perCuratorBytesPerHour?: number;
    coreAggregateBytes?: number;
  };
  /**
   * OT-RFC-49 WS-A — the irreversible private-ciphertext strip. When `true`
   * (DEFAULT — `undefined` is treated as on), a core declines ALL
   * private-ciphertext host-mode custody for CURATED context graphs:
   * "hosting follows access". Concretely, for a curated CG the core
   *
   *   - DECLINES the auto-host subscribe (reconcile/beacon/chain-event +
   *     the restart-restore path), starving both the `.meta` ingest and
   *     the LU-11 chunk ingest at the single subscribe choke point;
   *   - REFUSES the operator override (`enableSwmHostModeFor`) — unlike the
   *     narrower rung-1 `stripNonParticipants`, WS-A CLOSES the operator
   *     hatch, so there is no manual path back into private custody;
   *   - RETIRES the private serve responders (`handleSwmHostCatchup`,
   *     `handleGetCiphertextChunk`) so a stripped core serves nothing
   *     private back over the wire.
   *
   * Random sampling now proves the PUBLIC `_catalog` subgraph, so cores no
   * longer need the ciphertext; private data lives member-side and members
   * backfill from the curator (REPLACE-recovery), not from cores. PUBLIC CGs
   * are NEVER affected — the gate sits after the curated check on every path.
   * Set `false` to restore legacy host-mode custody (the rolling-upgrade
   * kill-switch / A/B baseline; backcompat is waived for V10 testnet).
   */
  stripCiphertext?: boolean;
}
