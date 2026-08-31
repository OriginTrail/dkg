import type {
  Rfc64AuthorSemanticScopeV1,
  Rfc64SemanticAddressV1,
  Rfc64SemanticScopeV1,
  Rfc64SubgraphSemanticScopeV1,
} from './rfc64-semantic-addresses-v1.js';
import type {
  ChainIdV1,
  DecimalU64V1,
  Digest32V1,
  EvmAddressV1,
} from './sync-wire-scalars.js';
import type {
  RenderedRdfStoreRowV1,
  TypedRdfStoreObjectV1,
  TypedRdfStoreRowV1,
} from './typed-rdf-store-row-v1.js';
import type { CanonicalIsoUtcMillisV1 } from './xsd-date-time.js';

const DKG_ONTOLOGY = 'http://dkg.io/ontology/';

export const RFC64_SEMANTIC_NULL_IRI_V1 = 'urn:dkg:sync:null' as const;
export const RFC64_DIGEST_LIST_DATATYPE_IRI_V1 = `${DKG_ONTOLOGY}digestListV1` as const;
export const MAX_RFC64_PENDING_TARGET_DIGESTS_V1 = 64;
export const MAX_RFC64_SEMANTIC_RECORD_RESPONSE_BYTES_V1 = 64 * 1024;

export const RFC64_SEMANTIC_PREDICATES_V1 = Object.freeze({
  NETWORK_ID: `${DKG_ONTOLOGY}networkId`,
  CONTEXT_GRAPH_ID: `${DKG_ONTOLOGY}contextGraphId`,
  GOVERNANCE_CHAIN_ID: `${DKG_ONTOLOGY}governanceChainId`,
  GOVERNANCE_CONTRACT_ADDRESS: `${DKG_ONTOLOGY}governanceContractAddress`,
  OWNERSHIP_TRANSITION_DIGEST: `${DKG_ONTOLOGY}ownershipTransitionDigest`,
  SUBGRAPH_NAME: `${DKG_ONTOLOGY}subGraphName`,
  AUTHOR_ADDRESS: `${DKG_ONTOLOGY}authorAddress`,
  CATALOG_ERA: `${DKG_ONTOLOGY}catalogEra`,
  CATALOG_VERSION: `${DKG_ONTOLOGY}catalogVersion`,
  CATALOG_HEAD_DIGEST: `${DKG_ONTOLOGY}catalogHeadDigest`,
  CHECKPOINT_ERA: `${DKG_ONTOLOGY}checkpointEra`,
  CHECKPOINT_VERSION: `${DKG_ONTOLOGY}checkpointVersion`,
  CHECKPOINT_DIGEST: `${DKG_ONTOLOGY}checkpointDigest`,
  MUTATION_GENERATION: `${DKG_ONTOLOGY}mutationGeneration`,
  APPLIED_AT: `${DKG_ONTOLOGY}appliedAt`,
  GENERATION: `${DKG_ONTOLOGY}generation`,
  BASELINE_SUBGRAPH_CHECKPOINT_DIGEST: `${DKG_ONTOLOGY}baselineSubgraphCheckpointDigest`,
  ACTIVE_TARGET_SUBGRAPH_CHECKPOINT_DIGEST: `${DKG_ONTOLOGY}activeTargetSubgraphCheckpointDigest`,
  PENDING_TARGET_CHECKPOINT_DIGESTS: `${DKG_ONTOLOGY}pendingTargetCheckpointDigests`,
  SUBGRAPH_INDEX_ERA: `${DKG_ONTOLOGY}subgraphIndexEra`,
  SUBGRAPH_INDEX_VERSION: `${DKG_ONTOLOGY}subgraphIndexVersion`,
  SUBGRAPH_COUNT: `${DKG_ONTOLOGY}subgraphCount`,
  APPLIED_DIRECTORY_ROOT_DIGEST: `${DKG_ONTOLOGY}appliedDirectoryRootDigest`,
  POLICY_DIGEST: `${DKG_ONTOLOGY}policyDigest`,
  CHAIN_COVERAGE_DIGEST: `${DKG_ONTOLOGY}chainCoverageDigest`,
} as const);

export interface CurrentAuthorCatalogRefV1 extends Rfc64AuthorSemanticScopeV1 {
  readonly governanceChainId: ChainIdV1 | null;
  readonly governanceContractAddress: EvmAddressV1 | null;
  readonly ownershipTransitionDigest: Digest32V1 | null;
  readonly catalogEra: DecimalU64V1;
  readonly catalogVersion: DecimalU64V1;
  readonly catalogHeadDigest: Digest32V1;
}

export interface AppliedSubgraphSealV1 extends Rfc64SubgraphSemanticScopeV1 {
  readonly checkpointEra: DecimalU64V1;
  readonly checkpointVersion: DecimalU64V1;
  readonly checkpointDigest: Digest32V1;
  readonly mutationGeneration: DecimalU64V1;
  readonly appliedAt: CanonicalIsoUtcMillisV1;
}

export interface SubgraphMutationGuardV1 extends Rfc64SubgraphSemanticScopeV1 {
  readonly generation: DecimalU64V1;
}

export interface ContextGraphMutationGuardV1 extends Rfc64SemanticScopeV1 {
  readonly generation: DecimalU64V1;
}

export interface SubgraphReconcileTargetGuardV1 extends Rfc64SubgraphSemanticScopeV1 {
  readonly generation: DecimalU64V1;
  readonly baselineSubgraphCheckpointDigest: Digest32V1 | null;
  readonly activeTargetSubgraphCheckpointDigest: Digest32V1;
  readonly pendingTargetCheckpointDigests: readonly Digest32V1[];
}

export interface AppliedSubgraphSetRefV1 extends Rfc64SemanticScopeV1 {
  readonly generation: DecimalU64V1;
  readonly subgraphIndexEra: DecimalU64V1;
  readonly subgraphIndexVersion: DecimalU64V1;
  readonly subgraphCount: DecimalU64V1;
  readonly appliedDirectoryRootDigest: Digest32V1;
}

export interface AppliedContextGraphSealV1 extends Rfc64SemanticScopeV1 {
  readonly checkpointEra: DecimalU64V1;
  readonly checkpointVersion: DecimalU64V1;
  readonly checkpointDigest: Digest32V1;
  readonly policyDigest: Digest32V1;
  readonly chainCoverageDigest: Digest32V1;
  readonly mutationGeneration: DecimalU64V1;
  readonly appliedAt: CanonicalIsoUtcMillisV1;
}

export interface Rfc64SemanticRecordValuesV1 {
  readonly CurrentAuthorCatalogRefV1: CurrentAuthorCatalogRefV1;
  readonly AppliedSubgraphSealV1: AppliedSubgraphSealV1;
  readonly SubgraphMutationGuardV1: SubgraphMutationGuardV1;
  readonly ContextGraphMutationGuardV1: ContextGraphMutationGuardV1;
  readonly SubgraphReconcileTargetGuardV1: SubgraphReconcileTargetGuardV1;
  readonly AppliedSubgraphSetRefV1: AppliedSubgraphSetRefV1;
  readonly AppliedContextGraphSealV1: AppliedContextGraphSealV1;
}

export type Rfc64SemanticRecordTypeV1 = keyof Rfc64SemanticRecordValuesV1;
export type Rfc64SemanticRecordV1 = {
  readonly [K in Rfc64SemanticRecordTypeV1]: {
    readonly recordType: K;
    readonly value: Rfc64SemanticRecordValuesV1[K];
  }
}[Rfc64SemanticRecordTypeV1];
export type Rfc64SemanticRecordFieldKeyV1<
  K extends Rfc64SemanticRecordTypeV1,
> = Extract<keyof Rfc64SemanticRecordValuesV1[K], string>;

export type Rfc64SemanticRecordCoordinateV1 =
  | ({ readonly recordType: 'CurrentAuthorCatalogRefV1'; readonly authorAddress: EvmAddressV1 }
    & Rfc64SubgraphSemanticScopeV1)
  | ({ readonly recordType:
      | 'AppliedSubgraphSealV1'
      | 'SubgraphMutationGuardV1'
      | 'SubgraphReconcileTargetGuardV1' }
    & Rfc64SubgraphSemanticScopeV1)
  | ({ readonly recordType:
      | 'ContextGraphMutationGuardV1'
      | 'AppliedSubgraphSetRefV1'
      | 'AppliedContextGraphSealV1' }
    & Rfc64SemanticScopeV1);

export type Rfc64SemanticStoreObjectV1 = TypedRdfStoreObjectV1;
export type Rfc64SemanticStoreRowV1 = TypedRdfStoreRowV1;

export type Rfc64SemanticRenderedRowV1 = RenderedRdfStoreRowV1;

export interface DecodedRfc64SemanticRecordV1 {
  readonly record: Rfc64SemanticRecordV1;
  readonly address: Rfc64SemanticAddressV1;
  readonly rows: readonly Rfc64SemanticStoreRowV1[];
}

export type Rfc64SemanticRecordErrorCodeV1 =
  | 'rfc64-semantic-schema'
  | 'rfc64-semantic-coordinate'
  | 'rfc64-semantic-scalar'
  | 'rfc64-semantic-row-schema'
  | 'rfc64-semantic-row-cardinality'
  | 'rfc64-semantic-row-term'
  | 'rfc64-semantic-too-large';

export class Rfc64SemanticRecordErrorV1 extends Error {
  constructor(
    readonly code: Rfc64SemanticRecordErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64SemanticRecordErrorV1';
  }
}
