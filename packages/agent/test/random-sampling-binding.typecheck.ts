import type { RandomSamplingAvailability } from '@origintrail-official/dkg-chain';
import type { RandomSamplingBindingResult, RandomSamplingHandle } from '../src/random-sampling-bind.js';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { RandomSamplingAvailabilityResolver, LegacyRandomSamplingAvailabilityReader, RandomSamplingAvailabilityReader } from '@origintrail-official/dkg-chain';

const legacyProbes: LegacyRandomSamplingAvailabilityReader = { isShardingTableMember: async () => false };
const unsupportedLegacy: RandomSamplingAvailabilityReader = {};
const authoritative: RandomSamplingAvailabilityResolver = { resolveRandomSamplingAvailability: async () => ({ kind: 'available', member: true }) };
// @ts-expect-error an authoritative resolver capability must provide its resolver
const missingResolver: RandomSamplingAvailabilityResolver = {};
void [legacyProbes, unsupportedLegacy, authoritative, missingResolver];

declare const publicAgent: DKGAgent;
declare const publicOptions: Parameters<DKGAgent['createRandomSamplingHandle']>[0];
const publicHandle: Promise<RandomSamplingHandle> = publicAgent.createRandomSamplingHandle(publicOptions);
void publicHandle;
const noPublicBindingResolver: 'resolveRandomSamplingBinding' extends keyof DKGAgent ? false : true = true;
void noPublicBindingResolver;

declare const handle: RandomSamplingHandle;

const ready = { kind: 'ready', handle } satisfies RandomSamplingBindingResult;
const unavailable = {
  kind: 'unavailable',
  reason: 'contracts_not_deployed',
  handleToClose: handle,
} satisfies RandomSamplingBindingResult;

// Disabled binding outcomes are control-flow inputs and must state their reason.
// @ts-expect-error unavailable bindings without a reason are invalid
const missingReason: RandomSamplingBindingResult = { kind: 'unavailable' };

// Retry policy is runtime-owned; binding facts cannot encode contradictory policy.
// @ts-expect-error unsupported-chain bindings cannot carry an ad-hoc retry policy
const pollingUnsupported: RandomSamplingBindingResult = { kind: 'unavailable', reason: 'unsupported_chain', retry: 'poll' };

// Availability mocks share the canonical chain fact shape.
const availability = { kind: 'available', member: true } satisfies RandomSamplingAvailability;

void ready;
void unavailable;
void missingReason;
void pollingUnsupported;
void availability;
