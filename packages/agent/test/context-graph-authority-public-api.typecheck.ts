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
type RootRegisteredAuthority = import(
  '@origintrail-official/dkg-agent'
).RegisteredContextGraphAuthority;
type RootLivePolicyUnavailable = import(
  '@origintrail-official/dkg-agent'
).LiveOnChainAccessPolicyUnavailable;
type RootLivePolicyUnavailableReason = import(
  '@origintrail-official/dkg-agent'
).LiveOnChainAccessPolicyUnavailableReason;
type RootRegisteredAuthorityUnavailable = import(
  '@origintrail-official/dkg-agent'
).RegisteredContextGraphAuthorityUnavailable;
type RootRegisteredAuthorityUnavailableReason = import(
  '@origintrail-official/dkg-agent'
).RegisteredContextGraphAuthorityUnavailableReason;
type LegacyDeepRegisteredAuthority = import(
  '@origintrail-official/dkg-agent/dist/dkg-agent-cg-resolve.js'
).RegisteredContextGraphAuthority;
type PrePeerGateApprovedReplicaAuthority = {
  kind: 'unregistered';
  approvedPrivateReplicaAuthority: {
    approvedAgentAddress: string;
    ownerAddress: string;
    requestGeneration: string;
    curatorPeerId: string;
    memberAddresses: readonly string[];
  };
};
type ExpectedLegacyRegisteredAuthority =
  | { kind: 'unregistered' }
  | { kind: 'public'; onChainId: bigint }
  | { kind: 'private'; onChainId: bigint; participantAgents: string[] }
  | {
      kind: 'unavailable';
      reason: 'chain-access-policy-timeout' | 'chain-access-policy-unknown';
      onChainId: bigint;
      detail?: string;
    }
  | {
      kind: 'unavailable';
      reason:
        | 'finalized-name-absence-unaccepted'
        | 'chain-name-binding-unavailable'
        | 'authority-circuit-open'
        | 'local-chain-binding-unavailable'
        | 'local-existence-unavailable'
        | 'chain-access-policy-unavailable'
        | 'chain-participant-authority-unsupported'
        | 'chain-participant-authority-unavailable'
        | 'chain-participant-authority-invalid';
      onChainId?: bigint;
      detail?: string;
    };
type ExpectedLivePolicyUnavailable = {
  kind: 'unavailable';
  reason: 'chain-access-policy-timeout' | 'chain-access-policy-unknown';
  detail?: string;
};
type ExpectedRegisteredAuthorityUnavailable = Extract<
  ExpectedLegacyRegisteredAuthority,
  { kind: 'unavailable' }
>;
type LegacyAuthorityMatchesRoot = AssertTrue<
  LegacyDeepRegisteredAuthority extends RootRegisteredAuthority ? true : false
>;
type RootAuthorityMatchesLegacy = AssertTrue<
  RootRegisteredAuthority extends LegacyDeepRegisteredAuthority ? true : false
>;
type RootAuthorityMatchesExpected = AssertTrue<
  RootRegisteredAuthority extends ExpectedLegacyRegisteredAuthority ? true : false
>;
type ExpectedAuthorityMatchesRoot = AssertTrue<
  ExpectedLegacyRegisteredAuthority extends RootRegisteredAuthority ? true : false
>;
type LegacyAuthorityMatchesExpected = AssertTrue<
  LegacyDeepRegisteredAuthority extends ExpectedLegacyRegisteredAuthority ? true : false
>;
type ExpectedAuthorityMatchesLegacy = AssertTrue<
  ExpectedLegacyRegisteredAuthority extends LegacyDeepRegisteredAuthority ? true : false
>;
type PrePeerGateApprovedReplicaMatchesRoot = AssertTrue<
  PrePeerGateApprovedReplicaAuthority extends RootRegisteredAuthority ? true : false
>;
type PrePeerGateApprovedReplicaMatchesLegacy = AssertTrue<
  PrePeerGateApprovedReplicaAuthority extends LegacyDeepRegisteredAuthority ? true : false
>;
type LivePolicyUnavailableMatchesExpected = AssertTrue<
  RootLivePolicyUnavailable extends ExpectedLivePolicyUnavailable ? true : false
>;
type ExpectedMatchesLivePolicyUnavailable = AssertTrue<
  ExpectedLivePolicyUnavailable extends RootLivePolicyUnavailable ? true : false
>;
type LivePolicyReasonMatchesExpected = AssertTrue<
  RootLivePolicyUnavailableReason extends ExpectedLivePolicyUnavailable['reason'] ? true : false
>;
type ExpectedMatchesLivePolicyReason = AssertTrue<
  ExpectedLivePolicyUnavailable['reason'] extends RootLivePolicyUnavailableReason ? true : false
>;
type RegisteredUnavailableMatchesExpected = AssertTrue<
  RootRegisteredAuthorityUnavailable extends ExpectedRegisteredAuthorityUnavailable ? true : false
>;
type ExpectedMatchesRegisteredUnavailable = AssertTrue<
  ExpectedRegisteredAuthorityUnavailable extends RootRegisteredAuthorityUnavailable ? true : false
>;
type RegisteredUnavailableReasonMatchesExpected = AssertTrue<
  RootRegisteredAuthorityUnavailableReason extends
    ExpectedRegisteredAuthorityUnavailable['reason'] ? true : false
>;
type ExpectedMatchesRegisteredUnavailableReason = AssertTrue<
  ExpectedRegisteredAuthorityUnavailable['reason'] extends
    RootRegisteredAuthorityUnavailableReason ? true : false
>;
// GH#3067: the closed set of throw sites the worker log may carry. Only the TYPE
// is public; the error class, its marker and any runtime list stay internal.
type RootAuthorityFailureSite = import(
  '@origintrail-official/dkg-agent'
).ContextGraphAuthorityFailureSite;
type ExpectedAuthorityFailureSite =
  | 'transport-unavailable'
  | 'transport-changed'
  | 'revision-moved'
  | 'recipient-set-changed';
type AuthorityFailureSiteMatchesExpected = AssertTrue<
  RootAuthorityFailureSite extends ExpectedAuthorityFailureSite ? true : false
>;
type ExpectedMatchesAuthorityFailureSite = AssertTrue<
  ExpectedAuthorityFailureSite extends RootAuthorityFailureSite ? true : false
>;
// The closed set of detail codes a read-authority log line may carry. As with
// the failure sites, only the TYPE is public.
type RootFinalizedAbsenceDetailCode = import(
  '@origintrail-official/dkg-agent'
).ContextGraphFinalizedAbsenceDetailCode;
type ExpectedFinalizedAbsenceDetailCode =
  | 'no-accepted-authority'
  | 'replica-proof-timeout'
  | 'replica-proof-error'
  | 'replica-proof-absent'
  | 'replica-metadata-moved'
  | 'replica-binding-changed'
  | 'replica-registered-metadata';
type FinalizedAbsenceDetailCodeMatchesExpected = AssertTrue<
  RootFinalizedAbsenceDetailCode extends ExpectedFinalizedAbsenceDetailCode ? true : false
>;
type ExpectedMatchesFinalizedAbsenceDetailCode = AssertTrue<
  ExpectedFinalizedAbsenceDetailCode extends RootFinalizedAbsenceDetailCode ? true : false
>;
type RegisteredUnavailableDetailCode = NonNullable<
  Extract<RootRegisteredAuthorityUnavailable, { detailCode?: unknown }>['detailCode']
>;
type RegisteredUnavailableCarriesDetailCode = AssertTrue<
  RootFinalizedAbsenceDetailCode extends RegisteredUnavailableDetailCode ? true : false
>;
type DeepAuthorityStaysInternal =
  // @ts-expect-error The export map blocks authority implementation deep imports.
  typeof import('@origintrail-official/dkg-agent/dist/internal/context-graph-authority/context-graph-authority.js');
type DeepGateResolverStaysInternal =
  // @ts-expect-error The export map blocks authority implementation deep imports.
  typeof import('@origintrail-official/dkg-agent/dist/internal/context-graph-authority/context-graph-agent-gate-authority.js');
type DeepPolicyResolverStaysInternal =
  // @ts-expect-error The export map blocks authority implementation deep imports.
  typeof import('@origintrail-official/dkg-agent/dist/internal/context-graph-authority/context-graph-access-policy.js');

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
  LegacyAuthorityMatchesRoot,
  RootAuthorityMatchesLegacy,
  RootAuthorityMatchesExpected,
  ExpectedAuthorityMatchesRoot,
  LegacyAuthorityMatchesExpected,
  ExpectedAuthorityMatchesLegacy,
  PrePeerGateApprovedReplicaMatchesRoot,
  PrePeerGateApprovedReplicaMatchesLegacy,
  LivePolicyUnavailableMatchesExpected,
  ExpectedMatchesLivePolicyUnavailable,
  LivePolicyReasonMatchesExpected,
  ExpectedMatchesLivePolicyReason,
  RegisteredUnavailableMatchesExpected,
  ExpectedMatchesRegisteredUnavailable,
  RegisteredUnavailableReasonMatchesExpected,
  ExpectedMatchesRegisteredUnavailableReason,
  AuthorityFailureSiteMatchesExpected,
  ExpectedMatchesAuthorityFailureSite,
  FinalizedAbsenceDetailCodeMatchesExpected,
  ExpectedMatchesFinalizedAbsenceDetailCode,
  RegisteredUnavailableCarriesDetailCode,
  GateAuthorityResultStaysInternal,
  AuthorityMarkerStaysInternal,
  DeepAuthorityStaysInternal,
  DeepGateResolverStaysInternal,
  DeepPolicyResolverStaysInternal,
};
