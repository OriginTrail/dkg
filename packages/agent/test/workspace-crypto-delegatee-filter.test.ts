import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  DKG_ONTOLOGY,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';

describe('workspace crypto delegatee authorization lookups', () => {
  let agent: DKGAgent | undefined;

  afterEach(async () => {
    await agent?.stop().catch(() => {});
    agent = undefined;
  });

  it('returns peer and key credentials only for effective, non-revoked delegation principals', async () => {
    agent = await DKGAgent.create({
      name: 'WorkspaceCryptoDelegateeFilter',
      chainAdapter: new MockChainAdapter(),
    });
    const contextGraphId = 'workspace-crypto-delegatee-filter';
    const cgEntity = contextGraphDataGraphUri(contextGraphId);
    const metaGraph = contextGraphMetaGraphUri(contextGraphId);
    const allowedAgent = ethers.Wallet.createRandom().address;
    const participantAgent = ethers.Wallet.createRandom().address;
    const orphanedAgent = ethers.Wallet.createRandom().address;
    const revokedAgent = ethers.Wallet.createRandom().address;
    const allowedKey = ethers.Wallet.createRandom().address;
    const participantKey = ethers.Wallet.createRandom().address;
    const orphanedKey = ethers.Wallet.createRandom().address;
    const revokedKey = ethers.Wallet.createRandom().address;
    const allowedPeer = '12D3KooWAllowedDelegatee';
    const participantPeer = '12D3KooWParticipantDelegatee';
    const orphanedPeer = '12D3KooWOrphanedDelegatee';
    const revokedPeer = '12D3KooWRevokedDelegatee';
    const delegationSubject = (principal: string) =>
      `did:dkg:agent-delegation:${contextGraphId}:${principal.toLowerCase()}`;
    const delegationQuads = (principal: string, peer: string, key: string) => [{
      graph: metaGraph,
      subject: delegationSubject(principal),
      predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT,
      object: `"${principal}"`,
    }, {
      graph: metaGraph,
      subject: delegationSubject(principal),
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER,
      object: `"${peer}"`,
    }, {
      graph: metaGraph,
      subject: delegationSubject(principal),
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_KEY,
      object: `"${key}"`,
    }];

    await agent.store.insert([
      {
        graph: metaGraph,
        subject: cgEntity,
        predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
        object: `"${allowedAgent}"`,
      },
      {
        graph: metaGraph,
        subject: cgEntity,
        predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT,
        object: `"${revokedAgent}"`,
      },
      {
        graph: metaGraph,
        subject: cgEntity,
        predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT,
        object: `"${participantAgent}"`,
      },
      {
        graph: metaGraph,
        subject: cgEntity,
        predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT,
        object: `"${revokedAgent.toLowerCase()}"`,
      },
      ...delegationQuads(allowedAgent, allowedPeer, allowedKey),
      ...delegationQuads(participantAgent, participantPeer, participantKey),
      ...delegationQuads(orphanedAgent, orphanedPeer, orphanedKey),
      ...delegationQuads(revokedAgent, revokedPeer, revokedKey),
    ]);

    const peers = await (agent as any).getContextGraphAllowedDelegateePeers(contextGraphId);
    const keys = await (agent as any).getContextGraphAllowedDelegateeKeys(contextGraphId);

    expect(peers.size).toBe(2);
    expect(keys.size).toBe(2);
    expect(peers.get(allowedAgent.toLowerCase())).toEqual([allowedPeer]);
    expect(keys.get(allowedAgent.toLowerCase())).toEqual([allowedKey.toLowerCase()]);
    expect(peers.get(participantAgent.toLowerCase())).toEqual([participantPeer]);
    expect(keys.get(participantAgent.toLowerCase())).toEqual([participantKey.toLowerCase()]);
    expect(peers.has(orphanedAgent.toLowerCase())).toBe(false);
    expect(peers.has(revokedAgent.toLowerCase())).toBe(false);
    expect(keys.has(orphanedAgent.toLowerCase())).toBe(false);
    expect(keys.has(revokedAgent.toLowerCase())).toBe(false);
  });
});
