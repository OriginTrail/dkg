/**
 * Stack D config controls for the system-record lane (plan `:1436`).
 *
 * Four INDEPENDENT, DEFAULT-OFF switches: producer tracking, provider
 * advertisement, requester lane, and legacy capable-peer selection. Independent
 * means exactly that — no flag gates another, and none is nested under a parent
 * whose own value could silently disable its children.
 *
 * POLARITY, because the neighbours read the other way: `syncReconcilerEnabled`
 * and its siblings are EMERGENCY OFF switches for behaviour that is on by
 * default, so they resolve with `true`. These four are the opposite — enable
 * switches for a lane that does not run yet — so they resolve with `false`.
 * Copying the neighbouring default would silently activate an unactivated lane.
 *
 * FORWARDING, and why this file owns a pick helper rather than open-coding the
 * hop: `DkgConfig` → `DKGAgentConfig` is a hand-written per-field mapping in
 * `cli/src/daemon/lifecycle.ts`, so a flag that is declared and documented but
 * missing from that list typechecks, is settable by an operator, and does
 * nothing. `pickSystemRecordConfigControlsV1` is the single chokepoint the hop
 * travels through, and its pinned return type makes a typo at any caller a
 * compile error. Same construction, and same reason, as core's
 * `pickNetworkTunables` (`core/src/node.ts:290`).
 *
 * These flags gate no production behaviour yet — the lanes they will govern are
 * default-unused, and each consumer arrives in a later slice. See the PR body
 * for the per-flag consumer mapping.
 */

import { resolveBooleanSwitch } from '../sync/backpressure.js';

/**
 * The exact field set forwarded across the `DkgConfig` → `DKGAgentConfig` hop.
 * Centralising it as one named type is what makes the forwarding hop
 * drift-proof; see `pickSystemRecordConfigControlsV1` below.
 */
export interface SystemRecordConfigControlsV1 {
  /** Track locally published agent profiles as signed system records. */
  systemRecordProducerTrackingEnabled?: boolean;
  /** Advertise the system-record provider protocol to peers. */
  systemRecordProviderAdvertisementEnabled?: boolean;
  /** Run the system-record requester lane. */
  systemRecordRequesterLaneEnabled?: boolean;
  /** Let legacy sync prefer system-record-capable peers. */
  systemRecordLegacyCapablePeerSelectionEnabled?: boolean;
}

/**
 * Forward exactly the four controls, field by field.
 *
 * The explicit assignment is deliberate rather than a spread: the pinned
 * `SystemRecordConfigControlsV1` return type turns a typo at any caller into a
 * compile error, and the one-hot forwarding test catches the failure a type
 * cannot — a copy-paste-cross that wires one flag's slot from another flag's
 * source. Four booleans share only two values, so a fixture that sets them all
 * true would pass while cross-wired; the test rotates a single `true` instead.
 */
export function pickSystemRecordConfigControlsV1(
  source: Partial<SystemRecordConfigControlsV1>,
): SystemRecordConfigControlsV1 {
  return {
    systemRecordProducerTrackingEnabled: source.systemRecordProducerTrackingEnabled,
    systemRecordProviderAdvertisementEnabled: source.systemRecordProviderAdvertisementEnabled,
    systemRecordRequesterLaneEnabled: source.systemRecordRequesterLaneEnabled,
    systemRecordLegacyCapablePeerSelectionEnabled:
      source.systemRecordLegacyCapablePeerSelectionEnabled,
  };
}

/** Resolved value of the producer-tracking control. Default OFF. */
export function systemRecordProducerTrackingEnabledV1(
  config: Partial<SystemRecordConfigControlsV1>,
): boolean {
  return resolveBooleanSwitch(
    config.systemRecordProducerTrackingEnabled,
    'DKG_SYSTEM_RECORD_PRODUCER_TRACKING_ENABLED',
    false,
  );
}

/** Resolved value of the provider-advertisement control. Default OFF. */
export function systemRecordProviderAdvertisementEnabledV1(
  config: Partial<SystemRecordConfigControlsV1>,
): boolean {
  return resolveBooleanSwitch(
    config.systemRecordProviderAdvertisementEnabled,
    'DKG_SYSTEM_RECORD_PROVIDER_ADVERTISEMENT_ENABLED',
    false,
  );
}

/** Resolved value of the requester-lane control. Default OFF. */
export function systemRecordRequesterLaneEnabledV1(
  config: Partial<SystemRecordConfigControlsV1>,
): boolean {
  return resolveBooleanSwitch(
    config.systemRecordRequesterLaneEnabled,
    'DKG_SYSTEM_RECORD_REQUESTER_LANE_ENABLED',
    false,
  );
}

/** Resolved value of the legacy capable-peer-selection control. Default OFF. */
export function systemRecordLegacyCapablePeerSelectionEnabledV1(
  config: Partial<SystemRecordConfigControlsV1>,
): boolean {
  return resolveBooleanSwitch(
    config.systemRecordLegacyCapablePeerSelectionEnabled,
    'DKG_SYSTEM_RECORD_LEGACY_CAPABLE_PEER_SELECTION_ENABLED',
    false,
  );
}
