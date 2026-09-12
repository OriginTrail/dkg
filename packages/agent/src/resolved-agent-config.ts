import type { DKGAgentConfig } from './dkg-agent-types.js';
import { RESOLUTION_INPUT_KEYS, type AgentConfigResolutionInputKey } from './agent-config-resolution-schema.js';
export { RAW_RESOURCE_CONFIG_KEYS } from './agent-config-resolution-schema.js';

const resolutionInputKeys: ReadonlySet<string> = new Set(RESOLUTION_INPUT_KEYS);

/** Preserve already-normalized fields (such as ACK timing) without mutating input. */
export function omitAgentConfigResolutionInputs<T extends DKGAgentConfig>(
  config: T,
): Omit<T, AgentConfigResolutionInputKey> {
  // Object.entries loses key/value correlation; the fixed key set defines both
  // this projection and the runtime config's declared omission boundary.
  return Object.fromEntries(Object.entries(config).filter(([key]) => !resolutionInputKeys.has(key))) as Omit<T, AgentConfigResolutionInputKey>;
}
