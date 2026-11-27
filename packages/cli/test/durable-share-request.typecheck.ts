import type { AsyncPromoteQueue, BoundPromoteRequest, PromoteRequest } from '@origintrail-official/dkg-publisher';
declare const queue: AsyncPromoteQueue;
declare const bound: BoundPromoteRequest;
const ordinary: PromoteRequest = { contextGraphId: 'cg', assertionName: 'asset', entities: ['urn:root'] };
void queue.enqueue(ordinary);
void queue.enqueueAndClaim?.(bound, 'worker');
// @ts-expect-error A partial ordinary request has no immutable recovery authority.
void queue.enqueueAndClaim?.(ordinary, 'worker');
// @ts-expect-error Bound replay is always the whole sealed asset.
const partial: PromoteRequest = { ...bound, entities: ['urn:root'] };
// @ts-expect-error Bound replay requires the exact storage lane.
const noLane: PromoteRequest = { ...bound, agentAddress: undefined };
void partial; void noLane;
