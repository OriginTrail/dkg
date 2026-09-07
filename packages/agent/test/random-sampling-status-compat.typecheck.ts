import type { RandomSamplingStatus } from '../src/random-sampling-bind.js';

// Compile-time compatibility fixture: this is the public status shape from
// before disabledReason was added. The package build must continue accepting it.
const legacyStatus: RandomSamplingStatus = {
  enabled: false,
  role: 'edge',
  identityId: '0',
  loop: null,
};

void legacyStatus;

import type { DKGAgent } from '../src/index.js';

const noPublicRuntimeFactory: 'createRandomSamplingRuntime' extends keyof DKGAgent ? false : true = true;
void noPublicRuntimeFactory;

import type { RandomSamplingEligibility } from '../src/random-sampling-eligibility.js';
// @ts-expect-error Membership absence is retryable, never a terminal network capability.
const terminalMembership: RandomSamplingEligibility = { kind: 'unavailable', retry: 'never', reason: 'awaiting_sharding_table', identityId: 1n };
// @ts-expect-error Unsupported chains cannot advertise polling eligibility.
const pollingUnsupported: RandomSamplingEligibility = { kind: 'unavailable', retry: 'poll', reason: 'unsupported_chain', identityId: 1n };
// @ts-expect-error An ambiguous lookup must remain retryable.
const terminalUnknown: RandomSamplingEligibility = { kind: 'indeterminate', retry: 'never', reason: 'identity_lookup_failed' };
void [terminalMembership, pollingUnsupported, terminalUnknown];
