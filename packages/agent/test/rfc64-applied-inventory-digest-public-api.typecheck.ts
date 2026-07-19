import {
  computeRfc64AppliedInventoryDigestV1,
  type ComputeRfc64AppliedInventoryDigestInputV1,
  type Rfc64AppliedInventoryDigestRowV1,
} from '@origintrail-official/dkg-agent';
import type { Digest32V1, KaIdV1 } from '@origintrail-official/dkg-core';

declare const digest: Digest32V1;
declare const kaId: KaIdV1;

const row: Rfc64AppliedInventoryDigestRowV1 = {
  kaId,
  catalogRowDigest: digest,
  contentDigest: digest,
  sealDigest: digest,
  kaUal: 'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/2',
  activatedTripleCount: 1,
};
const input: ComputeRfc64AppliedInventoryDigestInputV1 = {
  catalogScopeDigest: digest,
  rows: [row],
};
const result: Digest32V1 = computeRfc64AppliedInventoryDigestV1(input);

void result;
