// SPDX-License-Identifier: Apache-2.0

export interface Rfc64CatalogReplayPeerDemandV1 {
  readonly peerId: string;
  readonly generation: number;
}

/** Stable reservation identity survives callback decoration; identifiers cannot recreate it. */
export interface Rfc64CatalogReplayPeerDemandHandleV1 extends Rfc64CatalogReplayPeerDemandV1 {
  readonly handle: object;
}

/** Opaque, idempotent ownership of one exact reconnect demand. */
export interface Rfc64CatalogReplayPeerFenceLeaseV1
  extends Rfc64CatalogReplayPeerDemandHandleV1 {
  release(): void;
}

/** Completeness custody held until the connection owner permits execution. */
export interface Rfc64CatalogReplayPeerReservationV1 extends Rfc64CatalogReplayPeerFenceLeaseV1 {
  admit(): void;
  isCurrent(): boolean;
}

export interface Rfc64CatalogReplayRecoveryResultV1 {
  readonly requested: number;
  readonly failed: number;
}
