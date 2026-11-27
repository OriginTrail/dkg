import {
  createPromoteOperationIntent,
  type PromoteOperationIntent,
} from '../../src/promote-operation-intent.js';

const intent: PromoteOperationIntent = createPromoteOperationIntent({
  operationId: 'operation-1',
  timestampMs: 1_700_000_000_000,
  confirmationRequired: false,
  accessPolicy: 'public',
});

// @ts-expect-error Durable envelope fields are immutable after codec validation.
intent.timestampMs += 1;
// @ts-expect-error The peer collection is immutable after codec validation.
intent.allowedPeers.push('peer-b');

export type ImmutablePromoteOperationIntent = typeof intent;
