import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  computeContextGraphPolicyObjectDigestV1,
  type AuthorCatalogScopeV1,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
  type CountV1,
  type DecimalU256V1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type TimestampMsV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';

export type Cp1PublicCellName = 'public-open' | 'public-curated';

export interface Cp1PublicCellSpec {
  readonly cell: Cp1PublicCellName;
  readonly contextGraphId: ContextGraphIdV1;
  readonly publishPolicy: 0 | 1;
}

export const CP1_NETWORK_ID = 'otp:20430' as NetworkIdV1;
export const CP1_OWNER_ADDRESS =
  '0x1c5e6f6f6c7866ef146b0c0220d857d12a9058f0' as EvmAddressV1;
const ZERO_U64 = '0' as DecimalU64V1;
const ZERO_U256 = '0' as DecimalU256V1;
const ZERO_TIMESTAMP = '0' as TimestampMsV1;
const ONE_COUNT = '1' as CountV1;

export const CP1_PUBLIC_CELL_SPECS: readonly Cp1PublicCellSpec[] = Object.freeze([
  Object.freeze({
    cell: 'public-open',
    contextGraphId:
      '0x1111111111111111111111111111111111111111/cp1-public-open' as ContextGraphIdV1,
    publishPolicy: 1,
  }),
  Object.freeze({
    cell: 'public-curated',
    contextGraphId:
      '0x1111111111111111111111111111111111111111/cp1-public-curated' as ContextGraphIdV1,
    publishPolicy: 0,
  }),
]);

export function cp1PublicPolicy(spec: Cp1PublicCellSpec): ContextGraphPolicyV1 {
  const policy = {
    networkId: CP1_NETWORK_ID,
    contextGraphId: spec.contextGraphId,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    era: ZERO_U64,
    version: ZERO_U64,
    previousPolicyDigest: null,
    accessPolicy: 0,
    publishPolicy: spec.publishPolicy,
    publishAuthority: spec.publishPolicy === 0 ? CP1_OWNER_ADDRESS : null,
    publishAuthorityAccountId: ZERO_U256,
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: {
      kind: 'owner-signed-unregistered',
      ownerAddress: CP1_OWNER_ADDRESS,
      ownerAuthorityEra: ZERO_U64,
    },
    effectiveAt: ZERO_TIMESTAMP,
    issuedAt: ZERO_TIMESTAMP,
  } satisfies ContextGraphPolicyV1;
  return Object.freeze(policy);
}

export function cp1PolicyDigest(spec: Cp1PublicCellSpec): Digest32V1 {
  return computeContextGraphPolicyObjectDigestV1({
    issuer: CP1_OWNER_ADDRESS,
    objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
    payload: cp1PublicPolicy(spec),
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as unknown as UnsignedControlEnvelopeV1);
}

export function cp1CatalogScope(spec: Cp1PublicCellSpec): AuthorCatalogScopeV1 {
  const scope = {
    networkId: CP1_NETWORK_ID,
    contextGraphId: spec.contextGraphId,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: CP1_OWNER_ADDRESS,
    era: ZERO_U64,
    bucketCount: ONE_COUNT,
  } satisfies AuthorCatalogScopeV1;
  return Object.freeze(scope);
}
