import {
  CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE,
  CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_REASONS,
  ContextGraphAuthorityUnavailableError,
  isContextGraphAuthorityUnavailableMarker,
  type ContextGraphAgentGateAuthority,
  type ContextGraphAuthorityUnavailableMarker,
  type ContextGraphAuthorityUnavailableReason,
} from '@origintrail-official/dkg-agent';

const reason: ContextGraphAuthorityUnavailableReason =
  CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_REASONS[0]!;
const error = new ContextGraphAuthorityUnavailableError('authority unavailable', { reason });
const marker: ContextGraphAuthorityUnavailableMarker = error;
const authority: ContextGraphAgentGateAuthority = {
  kind: 'unavailable',
  reason,
};

if (isContextGraphAuthorityUnavailableMarker(marker)) {
  const code: typeof CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE_CODE = marker.code;
  void code;
}
void authority;
