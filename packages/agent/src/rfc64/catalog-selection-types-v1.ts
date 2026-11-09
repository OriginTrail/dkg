// SPDX-License-Identifier: Apache-2.0
/** Authority facts used for selection; independent of operational telemetry. */
export interface Rfc64CatalogSelectionV1 {
  readonly subscriptionDriven: boolean;
  readonly eligibleContextGraphs: readonly string[];
  readonly selectedContextGraphs: readonly string[];
}
/** Stable operator-facing connection replay diagnostics. */
export interface Rfc64CatalogConnectionReplayStatusV1 {
  readonly activePeers: number;
  readonly pendingScopes: number;
  readonly suppressed: number;
  readonly peers: readonly Readonly<{ peerIdSuffix: string; started: number; failed: number;
    startedLastMinute: number; nextEligibleAt: number }>[];
}
export interface Rfc64CatalogRuntimeSelectionStatusV1 extends Rfc64CatalogSelectionV1 {
  readonly connectionReplay?: Rfc64CatalogConnectionReplayStatusV1;
}
