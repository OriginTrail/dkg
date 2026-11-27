// SPDX-License-Identifier: Apache-2.0
import { EndpointStickiness } from '../src/endpoint-stickiness.js';
import { EndpointReadRefusals } from '../src/endpoint-read-refusals.js';

const owner = new EndpointStickiness({ now: () => 0, ttlMs: 30_000, isEnabled: () => true });
const endpoints = [{ rpcUrl: 'https://rpc.example' }];
const read = { label: 'view', memory: new EndpointReadRefusals({ now: () => 0 }) };
owner.attempts(endpoints, 'nonceWrite');
owner.attempts(endpoints, 'write');
for (const intent of ['stickyRead', 'transparentRead', 'receiptRead'] as const) {
  owner.readAttempts(endpoints, intent, read)[0]?.recordStart();
}
// @ts-expect-error Sticky reads require the read lifecycle and its start hook.
owner.attempts(endpoints, 'stickyRead');
// @ts-expect-error Transparent reads use the read builder.
owner.attempts(endpoints, 'transparentRead');
// @ts-expect-error Receipt reads use the read builder.
owner.attempts(endpoints, 'receiptRead');
// @ts-expect-error Nonce-critical writes cannot apply read-refusal policy.
owner.readAttempts(endpoints, 'nonceWrite', read);
// @ts-expect-error Broadcast writes cannot apply read-refusal policy.
owner.readAttempts(endpoints, 'write', read);
