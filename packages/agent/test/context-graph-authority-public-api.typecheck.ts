type AgentApi = typeof import('../src/index.js');
type AssertFalse<Value extends false> = Value;

type AuthorityCodeStaysInternal = AssertFalse<
  'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE' extends keyof AgentApi ? true : false
>;
type AuthorityErrorNameStaysInternal = AssertFalse<
  'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_ERROR_NAME' extends keyof AgentApi ? true : false
>;
type RetryableReasonListStaysInternal = AssertFalse<
  'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_REASONS' extends keyof AgentApi ? true : false
>;
type AuthorityErrorStaysInternal = AssertFalse<
  'ContextGraphAuthorityUnavailableError' extends keyof AgentApi ? true : false
>;
type AuthorityGuardStaysInternal = AssertFalse<
  'isContextGraphAuthorityUnavailableMarker' extends keyof AgentApi ? true : false
>;

type GateAuthorityResultStaysInternal =
  // @ts-expect-error The gate resolver result is internal orchestration state.
  import('@origintrail-official/dkg-agent').ContextGraphAgentGateAuthority;
type AuthorityMarkerStaysInternal =
  // @ts-expect-error The marker is consumed only by the internal promote boundary.
  import('@origintrail-official/dkg-agent').ContextGraphAuthorityUnavailableMarker;
type AuthorityReasonStaysInternal =
  // @ts-expect-error Authority reasons are owned by the internal resolver.
  import('@origintrail-official/dkg-agent').ContextGraphAuthorityUnavailableReason;

export type {
  AuthorityCodeStaysInternal,
  AuthorityErrorNameStaysInternal,
  RetryableReasonListStaysInternal,
  AuthorityErrorStaysInternal,
  AuthorityGuardStaysInternal,
  GateAuthorityResultStaysInternal,
  AuthorityMarkerStaysInternal,
  AuthorityReasonStaysInternal,
};
