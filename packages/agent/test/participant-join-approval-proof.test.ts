// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { contextGraphMetaGraphUri, DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { signAgentDelegation } from '../src/auth/agent-delegation.js';
import { joinDelegationScope } from '../src/dkg-agent-helpers.js';
import { hasAuthoritativePrivateMetaDefinition } from '../src/context-graph-private-meta-proof.js';

describe('approved metadata for an existing registered participant', () => {
  let agent: DKGAgent | undefined;
  let home: string | undefined;

  afterEach(async () => {
    await agent?.stop();
    agent = undefined;
    if (home) await rm(home, { recursive: true, force: true });
    home = undefined;
  });

  it.each(['participant-only', 'already-allowed'] as const)(
    'produces the unchanged member proof after a %s join and keeps roster mutation idempotent',
    async (mode) => {
      // Unit-only in-memory chain; the native local-EVM reproduction is kept separately.
      const chain = new MockChainAdapter();
      home = await mkdtemp(join(tmpdir(), 'dkg-participant-proof-'));
      agent = await DKGAgent.create({
        name: 'Participant approval proof',
        chainAdapter: chain,
        bootstrapPeers: [],
        listenHost: '127.0.0.1',
        listenPort: 0,
        dataDir: home,
        skills: [],
      });
      const owner = await agent.registerAgent('curator', { framework: 'test' });
      await agent.markDefaultAgent(owner.agentAddress);
      await agent.start();
      // The Graph Computer branch requires a verified recipient encryption key.
      const registered = await agent.registerAgent('member', { framework: 'test' });
      const member = new ethers.Wallet(agent.getCustodialAgentPrivateKey(registered.agentAddress)!);
      const contextGraphId = 'participant-approval-' + mode;
      await agent.createContextGraph({
        id: contextGraphId,
        name: 'Participant approval proof',
        accessPolicy: 1,
        callerAgentAddress: owner.agentAddress,
        participantAgents: [member.address],
        ...(mode === 'already-allowed' ? { allowedAgents: [member.address] } : {}),
      });
      const registration = await agent.registerContextGraph(contextGraphId, {
        callerAgentAddress: owner.agentAddress,
      });
      const onChainId = BigInt(registration.onChainId);
      const rosterBefore = await chain.getContextGraphParticipantAgents(onChainId);
      expect(rosterBefore.map((address) => address.toLowerCase())).toContain(member.address.toLowerCase());
      const addParticipant = vi.spyOn(chain, 'addContextGraphParticipantAgent');
      const notify = vi.fn(async () => {});
      // Keep only delivery outside this unit boundary; admission, writes, flush and proof are real.
      agent.notifyJoinApproval = notify;
      const store = agent.store;
      const graph = contextGraphMetaGraphUri(contextGraphId);
      const readRoot = async () => {
        const result = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
        if (result.type !== 'quads') throw new Error('Expected root metadata quads');
        return result.quads;
      };
      const issuedAtMs = Date.now();
      const delegation = await signAgentDelegation({
        agentAddress: member.address,
        agentPrivateKey: member.privateKey,
        scope: joinDelegationScope(chain.deploymentId, contextGraphId),
        issuedAtMs,
        expiresAtMs: issuedAtMs + 60_000,
        delegateePeerId: agent.peerId,
      });
      const proof = { approvedAgentAddress: member.address, expectedDelegateePeerId: agent.peerId };
      expect(hasAuthoritativePrivateMetaDefinition(contextGraphId, await readRoot(), proof)).toBe(false);

      const decision = await agent.processIncomingJoinRequest(contextGraphId, delegation, 'existing participant', agent.peerId);
      expect(decision).toMatchObject({ status: 'approved', alreadyMember: true });
      expect(notify).toHaveBeenCalledTimes(1);
      // The actual consumer contract must accept what the authorized producer just committed.
      expect(hasAuthoritativePrivateMetaDefinition(contextGraphId, await readRoot(), proof)).toBe(true);
      expect(addParticipant).not.toHaveBeenCalled();
      expect(await chain.getContextGraphParticipantAgents(onChainId)).toEqual(rosterBefore);

      await agent.processIncomingJoinRequest(contextGraphId, delegation, 'existing participant', agent.peerId);
      const refreshed = await readRoot();
      expect(refreshed.filter((quad) => quad.predicate === DKG_ONTOLOGY.DKG_ALLOWED_AGENT
        && quad.object.replaceAll('"', '').toLowerCase() === member.address.toLowerCase())).toHaveLength(1);
      expect(hasAuthoritativePrivateMetaDefinition(contextGraphId, refreshed, proof)).toBe(true);
      expect(addParticipant).not.toHaveBeenCalled();

      await agent.removeAgentFromContextGraph(contextGraphId, member.address, owner.agentAddress);
      expect(hasAuthoritativePrivateMetaDefinition(contextGraphId, await readRoot(), proof)).toBe(false);
    },
  );

  it('repairs a missing local witness on an authorized manual re-invite', async () => {
    const chain = new MockChainAdapter();
    home = await mkdtemp(join(tmpdir(), 'dkg-manual-participant-proof-'));
    agent = await DKGAgent.create({
      name: 'Manual participant approval', chainAdapter: chain, bootstrapPeers: [],
      listenHost: '127.0.0.1', listenPort: 0, dataDir: home, skills: [],
    });
    const owner = await agent.registerAgent('curator', { framework: 'test' });
    await agent.markDefaultAgent(owner.agentAddress);
    await agent.start();
    // The Graph Computer branch requires a verified recipient encryption key.
    const registered = await agent.registerAgent('member', { framework: 'test' });
    const member = new ethers.Wallet(agent.getCustodialAgentPrivateKey(registered.agentAddress)!);
    const contextGraphId = 'manual-participant-approval';
    await agent.createContextGraph({
      id: contextGraphId, name: 'Manual participant approval', accessPolicy: 1,
      callerAgentAddress: owner.agentAddress, participantAgents: [member.address],
    });
    await agent.registerContextGraph(contextGraphId, { callerAgentAddress: owner.agentAddress });
    const addParticipant = vi.spyOn(chain, 'addContextGraphParticipantAgent');
    const store = agent.store;
    const graph = contextGraphMetaGraphUri(contextGraphId);
    const allowedRows = async () => {
      const result = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
      if (result.type !== 'quads') throw new Error('Expected root metadata quads');
      return result.quads.filter((quad) => quad.predicate === DKG_ONTOLOGY.DKG_ALLOWED_AGENT
        && quad.object.replaceAll('"', '').toLowerCase() === member.address.toLowerCase());
    };
    expect(await allowedRows()).toHaveLength(0);
    await expect(agent.inviteAgentToContextGraph(contextGraphId, member.address, member.address))
      .rejects.toThrow();
    expect(await allowedRows()).toHaveLength(0);
    await agent.inviteAgentToContextGraph(contextGraphId, member.address, owner.agentAddress);
    expect(await allowedRows()).toHaveLength(1);
    await agent.inviteAgentToContextGraph(contextGraphId, member.address, owner.agentAddress);
    expect(await allowedRows()).toHaveLength(1);
    expect(addParticipant).not.toHaveBeenCalled();
  });
});
