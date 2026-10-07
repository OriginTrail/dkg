// SPDX-License-Identifier: Apache-2.0

/**
 * The VM exact-recovery holder tier's on/off switch, in its own module so that
 * the agent's option type and the CLI's config type (both already at their
 * file-size budget) can take it without growing.
 */

import { resolveBooleanSwitch } from './sync/backpressure.js';

/**
 * The switch as a configuration option: `DKGAgentConfig` extends it, and the
 * CLI's `DkgConfig` picks it from there, so what it means is stated once.
 */
export interface VmHolderTierSwitchConfig {
  /**
   * Switch for the VM exact-recovery holder tier: ShardingTable Cores the node
   * is not connected to, named by an unsigned phonebook profile and bound to a
   * ShardingTable identity on chain, that recovery may dial behind the curator
   * and connected-peer tiers. Env DKG_VM_RECONCILE_HOLDER_TIER wins (`0` is the
   * kill switch); default on. Per instance: two agents in one process can differ.
   */
  vmReconcileHolderTierEnabled?: boolean;
}

/**
 * Effective activation of the holder tier, with the precedence of every other
 * switch in `sync/backpressure.ts`: the environment
 * (`DKG_VM_RECONCILE_HOLDER_TIER`, the operator kill switch), then the config,
 * then the default (on).
 */
export function resolveVmReconcileHolderTierEnabled(configValue?: boolean): boolean {
  return resolveBooleanSwitch(
    configValue,
    'DKG_VM_RECONCILE_HOLDER_TIER',
    true,
  );
}
