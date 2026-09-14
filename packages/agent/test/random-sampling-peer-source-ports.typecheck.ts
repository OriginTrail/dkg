import type { CoreMembershipPolicy } from '../src/p2p/core-peer-discovery.js';
import type { RandomSamplingPeerSourcePorts } from '../src/sync/recovery/random-sampling-peer-source.js';

// Proof-time Random Sampling discovery is chain-membership required by
// construction. The invariant is pinned here rather than in a runtime test
// because no runtime assertion can observe that the legacy fail-open
// composition below fails to compile.

type RandomSamplingPeerSourcePortName = keyof RandomSamplingPeerSourcePorts;

// @ts-expect-error the proof-time source exposes no membership-policy port, so a
// caller cannot select the warm-core fail-open mode when constructing it.
const membershipPolicyPort: RandomSamplingPeerSourcePortName = 'coreMembershipPolicy';

// The named policy itself still exists — the warm-core path is its only owner.
const warmCorePolicy: CoreMembershipPolicy = 'warm-compatible';
const proofPolicy: CoreMembershipPolicy = 'proof-required';

export type RandomSamplingPeerSourcePortsTypecheck = [
  typeof membershipPolicyPort,
  typeof warmCorePolicy,
  typeof proofPolicy,
];
