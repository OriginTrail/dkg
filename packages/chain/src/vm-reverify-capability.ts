// SPDX-License-Identifier: Apache-2.0
/**
 * The ONE typed capability probe for chain-triggered re-verification
 * (#2435, review r4).
 *
 * Activation used to reconstruct adapter coherence inside the agent through
 * structural casts and a method-name loop — which compiles unchanged when an
 * adapter operation is renamed, letting the gate drift from the real repair
 * requirements. The probe lives HERE, typed against `ChainAdapter`, so a
 * rename breaks this file at compile time; the agent consumes one
 * discriminated result. Every adapter is covered by the same function: the
 * EVM and mock adapters define the optional operations and probe supported;
 * an adapter that predates them (or `NoChainAdapter`) fails closed with the
 * operation named.
 */
import type { ChainAdapter } from './chain-adapter.js';
import { KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES } from './evm-adapter-events.js';

/**
 * The non-event operations re-verification repairs through: mapping a
 * mutation to a UAL (the storage address, the CG binding) and reading the
 * exact version snapshot. `satisfies` pins each name to a real adapter
 * member — renaming one breaks the build here, not silently in a gate.
 */
export const VM_REVERIFY_REQUIRED_OPERATIONS = [
  'getDKGKnowledgeAssetsAddress',
  'getKAContextGraphId',
  'readKnowledgeAssetVersionSnapshot',
] as const satisfies readonly (keyof ChainAdapter)[];

export type VmReverifyRequiredOperation = (typeof VM_REVERIFY_REQUIRED_OPERATIONS)[number];

export type VmReverifyCapabilityResult =
  | { supported: true }
  /** Disabled, with the same diagnostics the activation gate always reported. */
  | {
      supported: false;
      reason:
        | `abi-missing:${string}`
        | 'abi-probe-failed'
        | `adapter-missing:${VmReverifyRequiredOperation}`;
    };

/**
 * Probe whether `adapter` can serve the WHOLE re-verification capability:
 * emit all four root-mutation event kinds, and repair what they announce.
 *
 * Fail-closed rules, unchanged from the activation gate this replaces:
 *  - An adapter without `supportsEventTypes` predates the event branch and
 *    counts as missing all four kinds — subscribing to a subset would
 *    silently miss every mutation of the other kinds.
 *  - Only a present, array-shaped, EMPTY missing-list means capable. The
 *    call is awaited because contract bindings resolve lazily from the Hub:
 *    an un-awaited promise has `length === undefined`, and `undefined > 0`
 *    is false — the one failure direction a capability gate must never
 *    have, and an invisible one (a lane that yields nothing, forever).
 *  - A probe throw (the Hub unreachable at boot) is not proof of capability
 *    — off for this process, named apart from a genuinely legacy ABI.
 *  - Emitting is not the whole capability: an adapter that cannot also map
 *    and repair would have every event dropped-and-acknowledged after the
 *    lane armed, the cursor advancing forever past mutations that never
 *    became intents.
 */
export async function probeVmReverifyCapability(
  adapter: ChainAdapter,
): Promise<VmReverifyCapabilityResult> {
  const requested: string[] = [...KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES];
  if (typeof adapter.supportsEventTypes !== 'function') {
    return { supported: false, reason: `abi-missing:${requested[0]}` };
  }
  let missing: unknown;
  try {
    missing = await adapter.supportsEventTypes(requested);
  } catch {
    return { supported: false, reason: 'abi-probe-failed' };
  }
  if (!Array.isArray(missing)) return { supported: false, reason: 'abi-probe-failed' };
  if (missing.length > 0) {
    return { supported: false, reason: `abi-missing:${String(missing[0])}` };
  }
  for (const operation of VM_REVERIFY_REQUIRED_OPERATIONS) {
    if (typeof adapter[operation] !== 'function') {
      return { supported: false, reason: `adapter-missing:${operation}` };
    }
  }
  return { supported: true };
}
