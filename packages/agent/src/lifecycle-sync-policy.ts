// SPDX-License-Identifier: Apache-2.0

import { resolveBooleanSwitch, resolveSyncReconcilerEnabled } from './sync/backpressure.js';
import { type DKGAgentConfig } from './dkg-agent-types.js';

export function syncReconcilerEnabled(config: DKGAgentConfig): boolean {
  return resolveSyncReconcilerEnabled(config.syncReconcilerEnabled);
}

export function syncOnConnectEnabled(config: DKGAgentConfig): boolean {
  return resolveBooleanSwitch(config.syncOnConnectEnabled, 'DKG_SYNC_ON_CONNECT_ENABLED', true);
}

export function durableSyncEnabled(config: DKGAgentConfig): boolean {
  return resolveBooleanSwitch(config.durableSyncEnabled, 'DKG_DURABLE_SYNC_ENABLED', true);
}
