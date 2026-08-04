import {
  buildOpenOwnerContextGraphPolicyV1,
  unsignedOpenContextGraphPolicyEnvelopeV1,
} from '@origintrail-official/dkg-agent';
import type {
  ContextGraphIdV1,
  EvmAddressV1,
  NetworkIdV1,
} from '@origintrail-official/dkg-core';

const TEST_NETWORK_ID = 'otp:20430' as NetworkIdV1;
const TEST_OWNER = `0x${'11'.repeat(20)}` as EvmAddressV1;

/** Canonical public policy fixture accepted by the production RFC-64 snapshotter. */
export function rfc64PublicCatalogPolicy(contextGraphId: string) {
  const policy = buildOpenOwnerContextGraphPolicyV1({
    networkId: TEST_NETWORK_ID,
    contextGraphId: contextGraphId as ContextGraphIdV1,
    ownerAddress: TEST_OWNER,
  });
  return {
    policyEnvelope: unsignedOpenContextGraphPolicyEnvelopeV1(policy),
    targets: [],
  };
}
