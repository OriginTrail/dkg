import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent, agentFromPrivateKey, revokeCustodialWorkspaceEncryptionKey } from '../src/index.js';

const agents: DKGAgent[] = [];
afterEach(async () => { for (const agent of agents.splice(0)) await agent.stop().catch(() => {}); });
async function boot(privateGraph = true) {
  const agent = await DKGAgent.create({ name: 'admission-test', listenHost: '127.0.0.1', listenPort: 0, chainAdapter: new MockChainAdapter() });
  agents.push(agent);
  await agent.start();
  const owner = await agent.registerAgent('owner');
  (agent as any).defaultAgentAddress = owner.agentAddress;
  const graph = 'programs';
  await agent.createContextGraph({ id: graph, name: 'Programs', description: '', accessPolicy: privateGraph ? 1 : 0, callerAgentAddress: owner.agentAddress });
  return { agent, owner, graph };
}
describe('private participant readiness at common admission boundary', () => {
  it('rejects missing encryption key before membership changes', async () => {
    const { agent, owner, graph } = await boot();
    const target = ethers.Wallet.createRandom().address;
    const before = await (agent as any).getPrivateContextGraphParticipants(graph);
    await expect(agent.inviteAgentToContextGraph(graph, target, owner.agentAddress)).rejects.toThrow(/PRIVATE_RECIPIENT_NOT_READY/);
    expect(await (agent as any).getPrivateContextGraphParticipants(graph)).toEqual(before);
  });
  it('admits a verified key and rejects a forged or revoked key', async () => {
    const { agent, owner, graph } = await boot();
    const member = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'member');
    await (agent as any).persistAgentToStore(member);
    await agent.inviteAgentToContextGraph(graph, member.agentAddress, owner.agentAddress);
    expect(await (agent as any).getPrivateContextGraphParticipants(graph)).toContain(member.agentAddress);
    const revoked = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'revoked');
    revokeCustodialWorkspaceEncryptionKey(revoked, revoked.workspaceEncryptionKeys[0].encryptionKeyId);
    await (agent as any).persistAgentToStore(revoked);
    await expect(agent.inviteAgentToContextGraph(graph, revoked.agentAddress, owner.agentAddress)).rejects.toThrow(/PRIVATE_RECIPIENT_NOT_READY/);
    const forged = agentFromPrivateKey(ethers.Wallet.createRandom().privateKey, 'forged');
    forged.workspaceEncryptionKeys[0].encryptionKeyProof = member.workspaceEncryptionKeys[0].encryptionKeyProof;
    await (agent as any).persistAgentToStore(forged);
    await expect(agent.inviteAgentToContextGraph(graph, forged.agentAddress, owner.agentAddress)).rejects.toThrow(/PRIVATE_RECIPIENT_NOT_READY/);
  });
  it('does not require encryption enrollment for public graphs', async () => {
    const { agent, owner, graph } = await boot(false);
    await expect(agent.inviteAgentToContextGraph(graph, ethers.Wallet.createRandom().address, owner.agentAddress)).resolves.toBeUndefined();
  });
});
