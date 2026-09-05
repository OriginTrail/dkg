import {
  CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE,
  ContextGraphAuthorityUnavailableError,
  isContextGraphAuthorityUnavailableMarker,
  type ContextGraphAuthorityUnavailableMarker,
  type ContextGraphAuthorityUnavailableReason,
} from '@origintrail-official/dkg-agent';

type AgentApi = typeof import('../src/index.js');
type AssertFalse<Value extends false> = Value;

type AuthorityErrorNameStaysInternal = AssertFalse<
  'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_ERROR_NAME' extends keyof AgentApi ? true : false
>;
type RetryableReasonListStaysInternal = AssertFalse<
  'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_REASONS' extends keyof AgentApi ? true : false
>;
type GateAuthorityResultStaysInternal =
  // @ts-expect-error The gate resolver result is internal orchestration state.
  import('@origintrail-official/dkg-agent').ContextGraphAgentGateAuthority;

const reason: ContextGraphAuthorityUnavailableReason = 'chain-access-policy-timeout';
const error = new ContextGraphAuthorityUnavailableError('authority unavailable', { reason });
const marker: ContextGraphAuthorityUnavailableMarker = {
  code: CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE,
  reason: 'chain-access-policy-timeout',
  retryable: true,
};
if (isContextGraphAuthorityUnavailableMarker(marker)) {
  const code: typeof CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE = marker.code;
  void code;
}
void error;

export type {
  AuthorityErrorNameStaysInternal,
  RetryableReasonListStaysInternal,
  GateAuthorityResultStaysInternal,
};
