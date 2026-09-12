import type { RandomSamplingDisabledReason, RandomSamplingStatus } from '@origintrail-official/dkg-agent';

// Existing exhaustive consumers must not acquire a new required reason key.
const legacyReasons: Record<RandomSamplingDisabledReason, string> = {
  not_started: 'not started',
  edge_node: 'edge node',
  no_identity: 'no identity',
  awaiting_sharding_table: 'waiting for membership',
  identity_lookup_failed: 'identity lookup failed',
  eligibility_lookup_failed: 'eligibility lookup failed',
  unsupported_chain: 'unsupported chain',
  contracts_not_deployed: 'contracts not deployed',
  bind_failed: 'binding failed',
};
void legacyReasons;

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
