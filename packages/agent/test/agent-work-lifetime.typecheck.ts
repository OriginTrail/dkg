import type { AgentWorkLifetime } from '../src/agent-work-lifetime.js';
declare const owner: AgentWorkLifetime;
declare const run: Promise<void>;
// @ts-expect-error Consumers cannot retire physically pending work.
owner.physicalRuns.delete(run);
// @ts-expect-error Consumers cannot erase all shutdown ownership.
owner.physicalRuns.clear();
// @ts-expect-error Registration must use track() so retirement is automatic.
owner.physicalRuns.add(run);
// @ts-expect-error Consumers cannot replace the diagnostic view.
owner.physicalRuns = new Set();
