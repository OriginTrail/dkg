type AgentApi = typeof import('../src/index.js');
type PublicAgent = import('@origintrail-official/dkg-agent').DKGAgent;
type AssertFalse<Value extends false> = Value;
type AssertTrue<Value extends true> = Value;
type PublicPromoteOptions = import('@origintrail-official/dkg-agent').AssertionPromoteOptions;
type FacadePromoteOptions = NonNullable<Parameters<PublicAgent['assertion']['promote']>[2]>;
type PromoteOptionsMatchFacade = AssertTrue<PublicPromoteOptions extends FacadePromoteOptions ? true : false>;
type FacadeOptionsMatchPublic = AssertTrue<FacadePromoteOptions extends PublicPromoteOptions ? true : false>;

type GateResolverStaysProtected = AssertFalse<
  'resolveContextGraphAgentGateAuthority' extends keyof PublicAgent ? true : false
>;
type LivePolicyResolverStaysProtected = AssertFalse<
  'resolveLiveOnChainAccessPolicyState' extends keyof PublicAgent ? true : false
>;
type GateProjectionRemainsPublic = AssertTrue<
  'getContextGraphAgentGateAddresses' extends keyof PublicAgent ? true : false
>;
type PolicyProjectionRemainsPublic = AssertTrue<
  'readLiveOnChainAccessPolicy' extends keyof PublicAgent ? true : false
>;

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
  PromoteOptionsMatchFacade,
  FacadeOptionsMatchPublic,
  GateResolverStaysProtected,
  LivePolicyResolverStaysProtected,
  GateProjectionRemainsPublic,
  PolicyProjectionRemainsPublic,
  AuthorityCodeStaysInternal,
  AuthorityErrorNameStaysInternal,
  RetryableReasonListStaysInternal,
  AuthorityErrorStaysInternal,
  AuthorityGuardStaysInternal,
  GateAuthorityResultStaysInternal,
  AuthorityMarkerStaysInternal,
  AuthorityReasonStaysInternal,
};
