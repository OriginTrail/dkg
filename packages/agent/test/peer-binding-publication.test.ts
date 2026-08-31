// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import type { PublishOptions } from '@origintrail-official/dkg-publisher';
import {
  AGENT_PEER_BINDING_VERSION,
  DKGAgent,
  signAgentPeerIdBinding,
  verifyAgentPeerIdBinding,
} from '../src/index.js';

function captureSerializedProfile(agent: DKGAgent): () => PublishOptions | undefined {
  let captured: PublishOptions | undefined;
  const capture = async (options: PublishOptions) => {
    captured = options;
    return { status: 'confirmed', kaId: 1n, kaManifest: [] } as any;
  };
  (agent as any).publisher.publish = capture;
  (agent as any).publisher.update = async (_kaId: bigint, options: PublishOptions) => capture(options);
  (agent as any).broadcastPublish = async () => undefined;
  return () => captured;
}

function assertSerializedPeerBinding(
  options: PublishOptions | undefined,
  agentAddress: string,
  peerId: string,
  expectedProof: string,
): void {
  const peerIdQuad = options?.quads.find((quad) => (
    quad.predicate === DKG_ONTOLOGY.DKG_PEER_ID
    && quad.object === `"${peerId}"`
  ));
  expect(peerIdQuad).toBeDefined();
  const root = peerIdQuad!.subject;
  expect(root.toLowerCase()).toBe(`did:dkg:agent:${agentAddress}`.toLowerCase());
  expect(options?.quads).toContainEqual(expect.objectContaining({
    subject: root,
    predicate: DKG_ONTOLOGY.DKG_PEER_BINDING_VERSION,
    object: `"${AGENT_PEER_BINDING_VERSION}"`,
  }));
  expect(options?.quads).toContainEqual(expect.objectContaining({
    subject: root,
    predicate: DKG_ONTOLOGY.DKG_PEER_ID_PROOF,
    object: `"${expectedProof}"`,
  }));
  expect(verifyAgentPeerIdBinding(agentAddress, peerId, expectedProof)).toBe(true);
}

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
    try {
      await agent.start();
      const captured = captureSerializedProfile(agent);

      await agent.publishProfile();

      const options = captured();
      const address = agent.getDefaultAgentAddress()!;
      const proofQuad = options?.quads.find(
        (quad) => quad.predicate === DKG_ONTOLOGY.DKG_PEER_ID_PROOF,
      );
      const proof = proofQuad?.object.slice(1, -1);
      expect(proof).toBeDefined();
      assertSerializedPeerBinding(options, address, agent.peerId, proof!);
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
      const captured = captureSerializedProfile(agent);

      await agent.publishProfile();

      assertSerializedPeerBinding(captured(), registered.agentAddress, agent.peerId, peerIdProof);

      (agent as any).defaultAgentAddress = proofless.agentAddress;
      await agent.publishProfile();
      const prooflessOptions = captured();
      const prooflessRoot = prooflessOptions?.quads.find((quad) => (
        quad.predicate === DKG_ONTOLOGY.DKG_PEER_ID
        && quad.object === `"${agent.peerId}"`
      ))?.subject;
      expect(prooflessRoot?.toLowerCase()).toBe(
        `did:dkg:agent:${proofless.agentAddress}`.toLowerCase(),
      );
      expect(prooflessOptions?.quads.some((quad) => (
        quad.subject === prooflessRoot
        && (
          quad.predicate === DKG_ONTOLOGY.DKG_PEER_BINDING_VERSION
          || quad.predicate === DKG_ONTOLOGY.DKG_PEER_ID_PROOF
        )
      ))).toBe(false);
    } finally {
      await agent.stop().catch(() => {});
    }
  }, 30_000);

  it('persists a valid self-sovereign proof across restart and rejects a proof for another peer', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dkg-peer-binding-persistence-'));
    let first: DKGAgent | undefined;
    let restarted: DKGAgent | undefined;
    let originalPeerId = '';
    try {
      first = await DKGAgent.create({
        name: 'PeerBindingPersistence',
        dataDir,
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: new MockChainAdapter(),
      });
      await first.start();
      originalPeerId = first.peerId;
      const validWallet = ethers.Wallet.createRandom();
      const invalidWallet = ethers.Wallet.createRandom();
      const validProof = signAgentPeerIdBinding(
        validWallet.address,
        first.peerId,
        validWallet.privateKey,
      );
      const initiallyValidButTampered = signAgentPeerIdBinding(
        invalidWallet.address,
        first.peerId,
        invalidWallet.privateKey,
      );
      const valid = await first.registerAgent('PersistedValidProof', {
        publicKey: validWallet.signingKey.publicKey,
        peerIdProof: validProof,
      });
      const invalid = await first.registerAgent('PersistedWrongPeerProof', {
        publicKey: invalidWallet.signingKey.publicKey,
        peerIdProof: initiallyValidButTampered,
      });
      await first.stop();
      first = undefined;

      const keystorePath = join(dataDir, 'agent-keystore.json');
      const keystore = JSON.parse(await readFile(keystorePath, 'utf8')) as Record<
        string,
        { peerIdProof?: string }
      >;
      keystore[invalid.agentAddress.toLowerCase()]!.peerIdProof = signAgentPeerIdBinding(
        invalidWallet.address,
        '12D3KooWDifferentPersistedPeer',
        invalidWallet.privateKey,
      );
      await writeFile(keystorePath, JSON.stringify(keystore, null, 2), { mode: 0o600 });

      restarted = await DKGAgent.create({
        name: 'PeerBindingPersistence',
        dataDir,
        listenHost: '127.0.0.1',
        listenPort: 0,
        chainAdapter: new MockChainAdapter(),
      });
      await restarted.start();
      expect(restarted.peerId).toBe(originalPeerId);
      const records = restarted.listLocalAgents();
      expect(records.find((record) => record.agentAddress === valid.agentAddress)?.peerIdProof)
        .toBe(validProof);
      expect(records.find((record) => record.agentAddress === invalid.agentAddress)?.peerIdProof)
        .toBeUndefined();

      (restarted as any).defaultAgentAddress = valid.agentAddress;
      const captured = captureSerializedProfile(restarted);
      await restarted.publishProfile();
      assertSerializedPeerBinding(captured(), valid.agentAddress, restarted.peerId, validProof);
    } finally {
      await first?.stop().catch(() => {});
      await restarted?.stop().catch(() => {});
      await first?.store.close().catch(() => {});
      await restarted?.store.close().catch(() => {});
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
