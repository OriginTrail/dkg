// SPDX-License-Identifier: Apache-2.0

import { resolveRfc64PrivateReadRoster } from '../src/rfc64/private-read-roster-v1.js';
import { assertNetworkIdV1, assertContextGraphIdV1 } from '@origintrail-official/dkg-core';

// Neither complete agent configuration nor concrete catalog service is required.
const minimalLookup = { acceptedPolicySnapshot: () => null };
const networkId = 'otp:20430';
const contextGraphId = 'private-read';
assertNetworkIdV1(networkId);
assertContextGraphIdV1(contextGraphId);
const result: readonly string[] | null | undefined = resolveRfc64PrivateReadRoster({
  activeNetworkId: 'otp:20430',
  acceptedPolicies: [{ policyEnvelope: { payload: {
    networkId, contextGraphId, accessPolicy: 1,
  } } }],
  service: minimalLookup,
  isJoinDerived: () => false,
}, 'private-read');
void result;
