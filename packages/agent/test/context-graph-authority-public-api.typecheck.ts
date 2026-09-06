type AgentApi = typeof import('../src/index.js');
type PublicAgent = import('@origintrail-official/dkg-agent').DKGAgent;
type AssertFalse<Value extends false> = Value;
type AssertTrue<Value extends true> = Value;
type PublicPromoteOptions = import('@origintrail-official/dkg-agent').AssertionPromoteOptions;
type PublisherPromoteOptions = import(
  '@origintrail-official/dkg-publisher'
).PublisherAssertionPromoteOptions;
type FacadePromoteOptions = NonNullable<Parameters<PublicAgent['assertion']['promote']>[2]>;
type PromoteOptionsMatchFacade = AssertTrue<PublicPromoteOptions extends FacadePromoteOptions ? true : false>;
type FacadeOptionsMatchPublic = AssertTrue<FacadePromoteOptions extends PublicPromoteOptions ? true : false>;
type AgentAccessEnvelope = Pick<
  PublicPromoteOptions,
  'entities' | 'subGraphName' | 'accessPolicy' | 'allowedPeers'
>;
type PublisherAccessEnvelope = Pick<
  PublisherPromoteOptions,
  'entities' | 'subGraphName' | 'accessPolicy' | 'allowedPeers'
>;
type AgentEnvelopeFlowsToPublisher = AssertTrue<
  AgentAccessEnvelope extends PublisherAccessEnvelope ? true : false
>;
type PublisherEnvelopeFlowsToAgent = AssertTrue<
  PublisherAccessEnvelope extends AgentAccessEnvelope ? true : false
>;
type NamedPublisherResolver = AssertTrue<
  PublisherPromoteOptions['resolveWorkspaceRecipients'] extends
    import('@origintrail-official/dkg-publisher').WorkspaceAgentRecipientResolver | undefined
    ? true
    : false
>;

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
type DeepAuthorityStaysInternal =
  // @ts-expect-error The export map blocks authority implementation deep imports.
  typeof import('@origintrail-official/dkg-agent/dist/context-graph-authority.js');
type DeepGateResolverStaysInternal =
  // @ts-expect-error The export map blocks authority implementation deep imports.
  typeof import('@origintrail-official/dkg-agent/dist/context-graph-agent-gate-authority.js');
type DeepPolicyResolverStaysInternal =
  // @ts-expect-error The export map blocks authority implementation deep imports.
  typeof import('@origintrail-official/dkg-agent/dist/context-graph-access-policy.js');

export type {
  PromoteOptionsMatchFacade,
  FacadeOptionsMatchPublic,
  AgentEnvelopeFlowsToPublisher,
  PublisherEnvelopeFlowsToAgent,
  NamedPublisherResolver,
  GateResolverStaysProtected,
  LivePolicyResolverStaysProtected,
  GateProjectionRemainsPublic,
  PolicyProjectionRemainsPublic,
  AuthorityCodeStaysInternal,
  AuthorityErrorNameStaysInternal,
  AuthorityErrorStaysInternal,
  AuthorityGuardStaysInternal,
  GateAuthorityResultStaysInternal,
  AuthorityMarkerStaysInternal,
  DeepAuthorityStaysInternal,
  DeepGateResolverStaysInternal,
  DeepPolicyResolverStaysInternal,
};
