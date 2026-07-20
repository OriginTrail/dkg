import type { ProtocolTuple } from '../protocol/schema.js';

export const RDF_ADAPTER_VERSION_V1 = 1n;
export const RDF_POLICY_MEDIA_TYPE_V1 = 'application/vnd.origintrail.rdf-policy-v1+cbor';
export const DKG_MUTATION_MEDIA_TYPE_V1 = 'application/vnd.origintrail.dkg-mutation-v1+cbor';

export interface RdfQuadV1 {
  readonly subject: string;
  readonly predicate: string;
  /** Canonical N-Quads object term, including delimiters and suffix. */
  readonly object: string;
  readonly graph: string;
  readonly canonicalLine: string;
}

export interface CanonicalRdfDatasetV1 {
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly quads: readonly RdfQuadV1[];
  readonly quadCount: number;
  readonly stateDigest: Uint8Array;
}

export interface RdfCanonicalizationLimits {
  readonly maximumSourceBytes?: number;
  readonly maximumCanonicalBytes?: number;
  readonly maximumQuads?: number;
}

export interface RdfLogicalKeyCoordinatesV1 {
  readonly contextGraphId: string;
  readonly subGraphName: string | null;
  readonly authorAddress: Uint8Array;
  readonly knowledgeAssetUalOrRootEntity: string;
}

export interface RdfPolicyInputV1 {
  readonly adapterVersion?: bigint;
  readonly allowedGraphPrefixes: readonly string[];
  readonly maxQuadsPerMutation: bigint;
  readonly maxWalObjectBytes: bigint;
  readonly singleValuedPredicates?: readonly string[];
  readonly multiValuedPredicates?: readonly string[];
  readonly sharedWriteLogicalKeys?: readonly Uint8Array[];
  readonly resolverAddresses?: readonly Uint8Array[];
  readonly expiryAuthorityAddresses?: readonly Uint8Array[];
  readonly allowedPayloadKinds: readonly bigint[];
}

export interface RdfPolicyAdmissionV1 {
  readonly policyObjectId: Uint8Array;
  readonly policy: ProtocolTuple<'RdfPolicyV1'>;
  readonly membershipCheckpointId: Uint8Array;
  /** Exact active view in which the admitted mutation will be authored. */
  readonly namespaceId: Uint8Array;
  /** Namespace carrying the ordinary WalObjectV1 that defines the policy. */
  readonly policyNamespaceId: Uint8Array;
  readonly writerId: Uint8Array;
  readonly canonicalWalObjectBytes: Uint8Array;
}

export interface RdfGraphReplacementInputV1 {
  readonly graphIri: string;
  readonly nquads: string | Uint8Array;
}

export interface RdfSubjectReplacementInputV1 {
  readonly graphIri: string;
  readonly subjectIri: string;
  readonly nquads: string | Uint8Array;
}

export type RdfCompileSourceV1 =
  | {
      readonly kind: 'replace';
      readonly graphs?: readonly RdfGraphReplacementInputV1[];
      readonly subjects?: readonly RdfSubjectReplacementInputV1[];
    }
  | {
      /** Exact delta returned by the existing DKG semantic implementation. */
      readonly kind: 'accepted-patch';
      readonly deletesNQuads: string | Uint8Array;
      readonly insertsNQuads: string | Uint8Array;
      /** Optional non-consensus audit bytes. WAL never parses or executes them. */
      readonly sourceAuditBytes?: Uint8Array | null;
    }
  | { readonly kind: 'delete-logical-key' };

export interface EncodeAcceptedRdfMutationInputV1 {
  readonly operation: 'PUT' | 'PATCH' | 'DELETE';
  readonly logicalKey: RdfLogicalKeyCoordinatesV1;
  readonly writerId: Uint8Array;
  readonly memberWriterIds: readonly Uint8Array[];
  readonly parents?: readonly Uint8Array[];
  readonly baseHeads: readonly Uint8Array[];
  readonly baseNQuads: string | Uint8Array;
  readonly allowedGraphIris: readonly string[];
  readonly policyObjectId: Uint8Array;
  readonly policy: ProtocolTuple<'RdfPolicyV1'>;
  readonly source: RdfCompileSourceV1;
  readonly chainBinding?: ProtocolTuple<'ChainBindingV1'> | null;
  readonly nonConsensusTimestampMs?: bigint | null;
}

export interface EncodedAcceptedRdfMutationV1 {
  readonly logicalKey: Uint8Array;
  readonly dkgMutation: ProtocolTuple<'DkgMutationV1'>;
  readonly rdfMutation: ProtocolTuple<'RdfMutationV1'>;
  /** Deterministic CBOR bytes placed inside the DKG payload envelope. */
  readonly contentBytes: Uint8Array;
  readonly base: CanonicalRdfDatasetV1;
  readonly result: CanonicalRdfDatasetV1;
}
