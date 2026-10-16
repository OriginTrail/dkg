import type { DKGAgent } from '../src/index.js';
import type { DurableRecoveryHost } from '../src/durable-recovery-host.js';

declare const agent: DKGAgent;
declare const host: DurableRecoveryHost;

// Internal storage/admission capabilities must not become public SDK methods.
// @ts-expect-error Recovery capability assembly belongs to the protected agent boundary.
agent.createDurableRecoveryCapabilities();

// The executor cannot bypass its transport or authenticated materialization operations.
// @ts-expect-error Raw networking internals are not a recovery capability.
host.node;
// @ts-expect-error Mutable subscription state belongs to the materialization owner.
host.subscribedContextGraphs;
// @ts-expect-error Direct store access would bypass the authentication and lifecycle fences.
host.store;
