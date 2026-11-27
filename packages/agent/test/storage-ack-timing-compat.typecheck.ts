import type { DKGAgentConfig } from '../src/index.js';
import type { ResolvedDKGAgentConfig } from '../src/dkg-agent-types.js';

// Public callers can keep the two-field input that was valid before the
// concurrency limit was added. The resolved internal shape is still complete.
const legacyInput: DKGAgentConfig = {
  name: 'storage-ack-timing-compat',
  storageAckTiming: {
    handlerDeadlineMs: 15_000,
    sendTimeoutMs: 20_000,
  },
};

declare const resolved: ResolvedDKGAgentConfig;
const concurrency: number = resolved.storageAckTiming.maxConcurrentCollections;

void legacyInput;
void concurrency;
