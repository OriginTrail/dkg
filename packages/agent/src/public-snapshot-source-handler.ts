// SPDX-License-Identifier: Apache-2.0
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { ProtocolRouter } from '@origintrail-official/dkg-core';
import type { PublicSnapshotProofRuntime } from './public-snapshot-proof-runtime.js';
import {
  decodeSourceChallenge, sourceProofPayload,
  PUBLIC_SNAPSHOT_SOURCE_PROTOCOL, PUBLIC_SNAPSHOT_SOURCE_MAX_BYTES,
} from './public-snapshot-source-proof.js';

/** Core-only challenge. Membership is independently checked by the requester.
 * Private/missing graphs, unavailable RPC, and overload share one refusal. */
export function registerSnapshotSourceHandler(agent: {
  nodeRole: string;
  chain: Pick<ChainAdapter, 'chainId' | 'deploymentId' | 'signMessage' | 'getIdentityId'>;
  router: Pick<ProtocolRouter, 'register'>;
  peerId: string;
  proofRuntime: PublicSnapshotProofRuntime;
  captureHosted(id: string, onChainId: string): () => void;
  isPrivateContextGraph(id: string, options: { signal: AbortSignal }): Promise<boolean>;
}): void {
  if (agent.nodeRole !== 'core' || agent.chain.chainId !== 'base:8453'
    || !agent.chain.signMessage) return;
  agent.router.register(PUBLIC_SNAPSHOT_SOURCE_PROTOCOL, (bytes, remote) => agent.proofRuntime.respond(remote.toString(), signal => {
    const challenge = decodeSourceChallenge(bytes);
    if (challenge.requesterPeerId !== remote.toString() || challenge.responderPeerId !== agent.peerId
      || challenge.deploymentId !== agent.chain.deploymentId) throw new Error('Unavailable');
    const assertCurrent = agent.captureHosted(challenge.contextGraphId, challenge.onChainId);
    return {
      assertCurrent,
      validate: async () => {
        if (await agent.isPrivateContextGraph(challenge.contextGraphId, { signal })) throw new Error('Unavailable');
      },
      proof: identityId => ({ fields: { identityId }, payload: sourceProofPayload(challenge, identityId) }),
    };
  }), { maxReadBytes: PUBLIC_SNAPSHOT_SOURCE_MAX_BYTES });
}
