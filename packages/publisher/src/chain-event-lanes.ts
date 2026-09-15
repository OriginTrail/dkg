// SPDX-License-Identifier: Apache-2.0

/** Every cursor lane configured by the production chain-event poller. */
export const CHAIN_EVENT_POLLER_LANES = Object.freeze([
  'publish',
  'allocatorReconcile',
  'contextGraphDiscovery',
  'vmReconcile',
  'collectionUpdates',
  'allowListUpdates',
  'profileEvents',
] as const);

export type ChainEventPollerLane = (typeof CHAIN_EVENT_POLLER_LANES)[number];
