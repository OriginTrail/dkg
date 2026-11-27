import type { AfterDurableSwmPromotionParamsV1, BoundDurableSwmPromotionParamsV1 } from '../src/dkg-agent-rfc64-catalog-auto-publish.js';
import { commitDurableShareInventory } from '../src/internal/promote/durable-share-inventory.js';
import type { DKGAgent } from '../src/dkg-agent.js';
declare const agent: DKGAgent;
declare const handoff: BoundDurableSwmPromotionParamsV1;
void commitDurableShareInventory(agent, handoff);
// @ts-expect-error A strict handoff cannot omit its immutable binding.
void commitDurableShareInventory(agent, { ...handoff, recoveryBinding: undefined });
// @ts-expect-error Bound operation identity comes from the binding, not a nullable parallel field.
const incompleteHandoff: BoundDurableSwmPromotionParamsV1 = { ...handoff, shareOperationId: null };
// @ts-expect-error A mode flag cannot manufacture a durable obligation.
const contradictoryHandoff: AfterDurableSwmPromotionParamsV1 = { ...handoff, recoveryBinding: undefined, durableInventory: true };
void incompleteHandoff; void contradictoryHandoff;
