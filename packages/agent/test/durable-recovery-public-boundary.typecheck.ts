import { DKGAgent } from '../src/index.js';
import type { DurableRecoveryHost } from '../src/durable-recovery-host.js';

declare const agent: DKGAgent;
declare const host: DurableRecoveryHost;

// Internal storage/admission capabilities must not become public SDK methods.
// @ts-expect-error Recovery capability assembly belongs to the protected agent boundary.
agent.createDurableRecoveryCapabilities();

// The executor cannot bypass its transport or authenticated materialization operations.
// @ts-expect-error Raw networking internals are not a recovery capability.
void host.node;
// @ts-expect-error Mutable subscription state belongs to the materialization owner.
void host.subscribedContextGraphs;
// @ts-expect-error Direct store access would bypass the authentication and lifecycle fences.
void host.store;

// @ts-expect-error The static assembler also remains inside the protected agent boundary.
DKGAgent.createDurableRecoveryCapabilities(agent);

declare const execution: import('../src/durable-recovery-execution.js').DurableRecoveryRequest;
declare const graph: import('../src/durable-recovery-graph.js').DurableGraphRequest;
declare const exact: import('../src/exact-recovery-execution.js').ExactRecoveryRequest;
// @ts-expect-error Compatibility selection aliases are normalized before internal execution.
void execution.options?.exactAssetSelection;
// @ts-expect-error Internal graph execution consumes only the selection-bound policy.
void graph.options.forceFreshExactSession;
// @ts-expect-error Exact execution receives a policy, not another compatibility input.
void exact.selectionInput;
// @ts-expect-error Refresh purpose is bound into the canonical policy at entry.
void exact.options.exactFetchPurpose;
