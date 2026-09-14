import type { DKGAgent } from '../src/index.js';

declare const agent: DKGAgent;

// Existing source consumers retain the synchronous compatibility contract.
const legacyResult: void = agent.setSharedMemoryTtlMs(60_000);
void legacyResult;

// Callers that need cleanup-policy activation and rollback use the explicit
// asynchronous operation.
const activation: Promise<void> = agent.updateSharedMemoryTtlMs(60_000);
void activation;
