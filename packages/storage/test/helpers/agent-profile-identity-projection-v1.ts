import {
  agentProfileIdentityFactsV1,
  type AgentProfileActiveHeadObjectV1,
  type AgentProfileProjectionQuadV1,
} from '@origintrail-official/dkg-core/system-record-v1';

/** Exact graphless identity rows required by an authenticated profile head fixture. */
export function agentProfileIdentityProjectionV1(
  head: Pick<AgentProfileActiveHeadObjectV1,
    'rootSubject' | 'peerId' | 'peerPublicKey' | 'evmIssuer'>,
): AgentProfileProjectionQuadV1[] {
  const identity = agentProfileIdentityFactsV1({
    rootSubject: head.rootSubject,
    peerId: head.peerId,
    publicKey: Buffer.from(head.peerPublicKey, 'base64url').toString('base64'),
    agentAddress: head.evmIssuer,
  });
  return [identity.peerId, identity.publicKey!, identity.agentAddress!].map((fact) => ({
    subject: head.rootSubject,
    ...fact,
    graph: '',
  }));
}
