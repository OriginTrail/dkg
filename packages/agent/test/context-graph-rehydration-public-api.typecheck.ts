import type { DKGAgent } from '../src/index.js';

declare const agent: DKGAgent;

// Public callers from earlier releases may still invoke the original
// zero-argument subscription rehydration API.
void agent.rehydrateContextGraphSubscriptions();
