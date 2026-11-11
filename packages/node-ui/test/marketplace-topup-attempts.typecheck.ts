// A confirmed top-up names exactly one service: none, two, or the route's
// list of services, are type errors; the list is made where the request is
// sent.
import type { ServiceRequest } from '../src/ui/marketplace/api/types.js';
import { topUpAttempts } from '../src/ui/marketplace/purchase/topUpAttempts.js';

const service: ServiceRequest = { serviceId: `0x${'14'.repeat(32)}`, serviceClass: 'inference', value: '1', maxPricePerUnit: '1' };
const closed = new AbortController().signal;
const terms = { subscriptionId: `0x${'98'.repeat(32)}`, epoch: 664, before: '0' };

export const one = topUpAttempts.confirm({ ...terms, service }, closed);

// @ts-expect-error No service is not a top-up.
export const none = topUpAttempts.confirm({ ...terms, service: [] }, closed);

// @ts-expect-error Nor are two.
export const two = topUpAttempts.confirm({ ...terms, service: [service, service] }, closed);

// @ts-expect-error The route's list of services stays where the request is sent.
export const listed = topUpAttempts.confirm({ ...terms, services: [service] }, closed);
