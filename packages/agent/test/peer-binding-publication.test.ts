// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKGAgent,
  signAgentPeerIdBinding,
  verifyAgentPeerIdBinding,
} from '../src/index.js';

describe('agent peer-binding publication', () => {
  it('publishes a verifiable proof from the normal default custodial wallet', async () => {
    const operationalWallet = ethers.Wallet.createRandom();
    const agent = await DKGAgent.create({
      name: 'PeerBindingCustodial',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
      chainConfig: {
        rpcUrl: 'http://127.0.0.1:59998',
        hubAddress: ethers.ZeroAddress,
        operationalKeys: [operationalWallet.privateKey],
      },
    });
    let capturedProfile: Record<string, unknown> | undefined;

    try {
      await agent.start();
      (agent as any).profileManager.publishProfile = async (profile: Record<string, unknown>) => {
        capturedProfile = profile;
        return { status: 'confirmed', kaId: 1, kaManifest: [] };
      };
      (agent as any).broadcastPublish = async () => undefined;

      await agent.publishProfile();

      expect(capturedProfile?.agentAddress).toBe(agent.getDefaultAgentAddress());
      expect(typeof capturedProfile?.peerIdProof).toBe('string');
      expect(verifyAgentPeerIdBinding(
        capturedProfile!.agentAddress as string,
        agent.peerId,
        capturedProfile!.peerIdProof as string,
      )).toBe(true);
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);

  it('accepts and publishes an off-node proof for a self-sovereign default while keeping proofless registration supported', async () => {
    const agent = await DKGAgent.create({
      name: 'PeerBindingSelfSovereign',
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
    });
    const wallet = ethers.Wallet.createRandom();
    let capturedProfile: Record<string, unknown> | undefined;

    try {
      await agent.start();
      const peerIdProof = signAgentPeerIdBinding(wallet.address, agent.peerId, wallet.privateKey);
      const registered = await agent.registerAgent('SelfSovereignBound', {
        publicKey: wallet.signingKey.publicKey,
        peerIdProof,
      });
      expect(registered.peerIdProof).toBe(peerIdProof);

      const prooflessWallet = ethers.Wallet.createRandom();
      const proofless = await agent.registerAgent('SelfSovereignKeyless', {
        publicKey: prooflessWallet.signingKey.publicKey,
      });
      expect(proofless.mode).toBe('self-sovereign');
      expect(proofless.peerIdProof).toBeUndefined();

      // Select the registered self-sovereign identity as this node's profile
      // owner; publishProfileImpl must use the supplied proof because it has no
      // private key with which to synthesize one.
      (agent as any).defaultAgentAddress = registered.agentAddress;
      (agent as any).profileManager.publishProfile = async (profile: Record<string, unknown>) => {
        capturedProfile = profile;
        return { status: 'confirmed', kaId: 1, kaManifest: [] };
      };
      (agent as any).broadcastPublish = async () => undefined;

      await agent.publishProfile();

      expect(capturedProfile?.agentAddress).toBe(registered.agentAddress);
      expect(capturedProfile?.peerIdProof).toBe(peerIdProof);
      expect(verifyAgentPeerIdBinding(
        registered.agentAddress,
        agent.peerId,
        capturedProfile!.peerIdProof as string,
      )).toBe(true);
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);
});
