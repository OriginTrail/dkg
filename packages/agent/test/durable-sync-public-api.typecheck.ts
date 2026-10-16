import type { DKGAgent } from '../src/index.js';
import type { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';

declare const agent: DKGAgent;
declare const lifecycle: LifecycleSyncMethods;
// @ts-expect-error The admitted executor is not a public SDK entry point.
agent.runAdmittedLegacyDurableContextGraph;
// @ts-expect-error Internal lifecycle policy is protected on the mixin as well.
lifecycle.runAdmittedLegacyDurableContextGraph;
