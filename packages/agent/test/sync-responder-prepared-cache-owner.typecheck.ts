import type { DKGAgent } from '../src/index.js';

declare const agent: DKGAgent;

// Internal shutdown ownership must not be readable or replaceable through the SDK.
// @ts-expect-error The prepared cache lifecycle owner belongs to the protected agent boundary.
void agent.syncResponderPreparedCacheOwner;
// @ts-expect-error SDK callers cannot replace internal shutdown ownership.
agent.syncResponderPreparedCacheOwner = undefined;
