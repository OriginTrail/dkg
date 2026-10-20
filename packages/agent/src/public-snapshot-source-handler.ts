// SPDX-License-Identifier: Apache-2.0
import { ethers } from 'ethers';
import { startRequestAbortLifecycle } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import type { ProtocolRouter } from '@origintrail-official/dkg-core';
import type { AgentWorkLifetime } from './agent-work-lifetime.js';
import { PublicSnapshotAdmission } from './public-snapshot-admission.js';
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
  workLifetime: AgentWorkLifetime;
  sourceAdmission?: PublicSnapshotAdmission;
  captureHosted(id: string, onChainId: string): () => void;
  isPrivateContextGraph(id: string, options: { signal: AbortSignal }): Promise<boolean>;
}): void {
  if (agent.nodeRole !== 'core' || agent.chain.chainId !== 'base:8453'
    || !agent.chain.signMessage) return;
  const admission = agent.sourceAdmission ?? new PublicSnapshotAdmission();
  let active = 0;
  const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  agent.router.register(PUBLIC_SNAPSHOT_SOURCE_PROTOCOL, async (bytes, remote) => {
    let release: (() => void) | undefined;
    const lifetime = startRequestAbortLifecycle(10_000, [agent.workLifetime.signal]);
    try {
      const challenge = decodeSourceChallenge(bytes);
      if (challenge.requesterPeerId !== remote.toString() || challenge.responderPeerId !== agent.peerId
        || challenge.deploymentId !== agent.chain.deploymentId || active >= 4) throw new Error('Unavailable');
      const checkHosted = agent.captureHosted(challenge.contextGraphId, challenge.onChainId);
      const assertHosted = () => {
        lifetime.signal.throwIfAborted();
        checkHosted();
      };
      assertHosted();
      release = admission.acquire(remote.toString());
      active += 1;
      const operation = (async () => {
        if (await agent.isPrivateContextGraph(challenge.contextGraphId, { signal: lifetime.signal }))
          throw new Error('Unavailable');
        assertHosted();
        const identityId = (await agent.chain.getIdentityId({ signal: lifetime.signal })).toString();
        assertHosted();
        const signature = await agent.chain.signMessage!(sourceProofPayload(challenge, identityId), { signal: lifetime.signal });
        assertHosted();
        return encode({ identityId, signature: ethers.Signature.from({
          r: ethers.hexlify(signature.r), yParityAndS: ethers.hexlify(signature.vs),
        }).serialized });
      })();
      agent.workLifetime.track(operation);
      return await operation;
    } catch { return encode({ unavailable: true }); }
    finally { if (release) { active -= 1; release(); } lifetime.release(); }
  }, { maxReadBytes: PUBLIC_SNAPSHOT_SOURCE_MAX_BYTES });
}
