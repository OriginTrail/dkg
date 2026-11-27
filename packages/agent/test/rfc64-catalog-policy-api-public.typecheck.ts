import {
  DKGAgent,
  type AcceptRfc64CatalogAccessSnapshotParamsV1,
  type AcceptedRfc64CatalogAccessSnapshotV1,
  type DKGAgentConfig,
  type PublishAuthorCatalogExactSetSuccessorParamsV1,
  type PublishAuthorCatalogExactSetSuccessorResultV1,
  type PublishAuthorCatalogGenesisParamsV1,
  type PublishAuthorCatalogGenesisResultV1,
  type Rfc64CatalogAccessPolicyAuthorityConfigV1,
} from '@origintrail-official/dkg-agent';

// Every params value below is built as a real object literal rather than passed through as a
// `declare const params: T`. That distinction is the whole point of this file: `T` assignable to `T`
// compiles no matter how T's fields are renamed, so it proves only that the export NAME exists.
// Real literals additionally fail to compile when a published field is renamed, removed, or newly
// required — which is what an external consumer of this surface would actually hit.
//
// Nested/leaf values are pulled through indexed access on the published types themselves, so this
// file stays free of incidental imports while keeping the field names load-bearing: renaming
// `scope` breaks both the indexed access and the literal key.

declare const agent: DKGAgent;

declare const policy: AcceptRfc64CatalogAccessSnapshotParamsV1['policy'];
declare const policyDigest: AcceptRfc64CatalogAccessSnapshotParamsV1['policyDigest'];
declare const roster: NonNullable<AcceptRfc64CatalogAccessSnapshotParamsV1['roster']>;

const snapshot: AcceptRfc64CatalogAccessSnapshotParamsV1 = {
  policy,
  policyDigest,
  roster,
};
const accepted: AcceptedRfc64CatalogAccessSnapshotV1 =
  agent.acceptRfc64CatalogAccessSnapshotV1(snapshot);

declare const genesisScope: PublishAuthorCatalogGenesisParamsV1['scope'];
declare const genesisAuthor: PublishAuthorCatalogGenesisParamsV1['author'];
declare const genesisIssuedAt: NonNullable<PublishAuthorCatalogGenesisParamsV1['issuedAt']>;
declare const delegationEffectiveAt:
  PublishAuthorCatalogGenesisParamsV1['catalogIssuerDelegationEffectiveAt'];
declare const delegationExpiresAt:
  PublishAuthorCatalogGenesisParamsV1['catalogIssuerDelegationExpiresAt'];

const genesis: PublishAuthorCatalogGenesisParamsV1 = {
  scope: genesisScope,
  author: genesisAuthor,
  peers: ['12D3KooWExamplePeer'],
  issuedAt: genesisIssuedAt,
  catalogIssuerDelegationEffectiveAt: delegationEffectiveAt,
  catalogIssuerDelegationExpiresAt: delegationExpiresAt,
};
const genesisResult: Promise<PublishAuthorCatalogGenesisResultV1> =
  agent.publishAuthorCatalogGenesisV1(genesis);

declare const previousHead: PublishAuthorCatalogExactSetSuccessorParamsV1['previousHead'];
declare const successorAuthor: PublishAuthorCatalogExactSetSuccessorParamsV1['author'];
declare const catalogIssuerAuthorization:
  PublishAuthorCatalogExactSetSuccessorParamsV1['catalogIssuerAuthorization'];
declare const assets: PublishAuthorCatalogExactSetSuccessorParamsV1['assets'];
declare const deployment: PublishAuthorCatalogExactSetSuccessorParamsV1['deployment'];
declare const successorIssuedAt:
  NonNullable<PublishAuthorCatalogExactSetSuccessorParamsV1['issuedAt']>;

const successor: PublishAuthorCatalogExactSetSuccessorParamsV1 = {
  previousHead,
  author: successorAuthor,
  catalogIssuerAuthorization,
  assets,
  deployment,
  issuedAt: successorIssuedAt,
  peers: ['12D3KooWExamplePeer'],
};
const successorResult: Promise<PublishAuthorCatalogExactSetSuccessorResultV1> =
  agent.publishAuthorCatalogExactSetSuccessorV1(successor);

declare const localAgentAddress: Rfc64CatalogAccessPolicyAuthorityConfigV1['localAgentAddress'];
declare const resolveRemoteAgentAddress:
  Rfc64CatalogAccessPolicyAuthorityConfigV1['resolveRemoteAgentAddress'];

const authority: Rfc64CatalogAccessPolicyAuthorityConfigV1 = {
  localAgentAddress,
  resolveRemoteAgentAddress,
};
// The authority is create-time configuration, so pin its config field name too.
const authorityConfig: Pick<DKGAgentConfig, 'rfc64CatalogAccessPolicyAuthority'> = {
  rfc64CatalogAccessPolicyAuthority: authority,
};

void accepted;
void genesisResult;
void successorResult;
void authorityConfig;
