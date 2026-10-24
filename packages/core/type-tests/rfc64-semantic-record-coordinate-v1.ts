import type {
  Rfc64SemanticRecordCoordinateV1,
  Rfc64SemanticScopeV1,
  Rfc64SubgraphSemanticScopeV1,
} from '@origintrail-official/dkg-core';

export function subgraphCoordinateFromUnion(
  recordType: 'AppliedSubgraphSealV1' | 'SubgraphMutationGuardV1',
  scope: Rfc64SubgraphSemanticScopeV1,
): Rfc64SemanticRecordCoordinateV1 {
  return { recordType, ...scope };
}

export function contextGraphCoordinateFromUnion(
  recordType: 'ContextGraphMutationGuardV1' | 'AppliedSubgraphSetRefV1',
  scope: Rfc64SemanticScopeV1,
): Rfc64SemanticRecordCoordinateV1 {
  return { recordType, ...scope };
}
