import { describe, it, expect, afterEach } from 'vitest';
import { DKGAgent } from '../src/index.js';

const agents: DKGAgent[] = [];

afterEach(async () => {
  for (const a of agents) {
    try { await a.stop(); } catch {}
  }
  agents.length = 0;
});

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

describe('Two-Agent E2E', () => {
  it('agents connect, publish profiles, discover each other via GossipSub', async () => {
    const agentA = await DKGAgent.create({
      name: 'AlphaBot',
      framework: 'OpenClaw',
      listenPort: 0,
      skills: [{
        skillType: 'ImageAnalysis',
        pricePerCall: 1.0,
        handler: async () => ({ success: true }),
      }],
    });
    agents.push(agentA);
    await agentA.start();

    const agentB = await DKGAgent.create({
      name: 'BetaBot',
      framework: 'ElizaOS',
      listenPort: 0,
      skills: [{
        skillType: 'TextAnalysis',
        pricePerCall: 0.5,
        handler: async () => ({ success: true }),
      }],
    });
    agents.push(agentB);
    await agentB.start();

    // Publish profiles
    await agentA.publishProfile();
    await agentB.publishProfile();

    // Connect B → A
    const addrA = agentA.multiaddrs[0];
    await agentB.connectTo(addrA);
    await sleep(1000);

    // A re-broadcasts its profile so B receives it
    await agentA.publishProfile();
    await sleep(2000);

    // B should discover both agents
    const agentsOnB = await agentB.findAgents();
    expect(agentsOnB.length).toBeGreaterThanOrEqual(2);

    const names = agentsOnB.map(a => a.name).sort();
    expect(names).toContain('AlphaBot');
    expect(names).toContain('BetaBot');

    // B can find A's ImageAnalysis skill
    const offerings = await agentB.findSkills({ skillType: 'ImageAnalysis' });
    expect(offerings.length).toBeGreaterThanOrEqual(1);
    expect(offerings[0].agentName).toBe('AlphaBot');
  }, 15000);

  it('agents exchange chat messages', async () => {
    const agentA = await DKGAgent.create({
      name: 'ChatA', listenPort: 0, skills: [],
    });
    agents.push(agentA);

    const agentB = await DKGAgent.create({
      name: 'ChatB', listenPort: 0, skills: [],
    });
    agents.push(agentB);

    const receivedOnA: string[] = [];
    const receivedOnB: string[] = [];

    agentA.onChat((text) => { receivedOnA.push(text); });
    agentB.onChat((text) => { receivedOnB.push(text); });

    await agentA.start();
    await agentB.start();

    // Connect
    await agentB.connectTo(agentA.multiaddrs[0]);
    await sleep(500);

    // B sends chat to A
    const r1 = await agentB.sendChat(agentA.peerId, 'hello from B');
    expect(r1.delivered).toBe(true);
    expect(receivedOnA).toContain('hello from B');

    // A sends chat to B
    const r2 = await agentA.sendChat(agentB.peerId, 'hey from A');
    expect(r2.delivered).toBe(true);
    expect(receivedOnB).toContain('hey from A');
  }, 10000);

  it('chat to unknown peer fails gracefully', async () => {
    const agent = await DKGAgent.create({
      name: 'LonelyBot', listenPort: 0, skills: [],
    });
    agents.push(agent);
    await agent.start();

    const result = await agent.sendChat('16Uiu2HAm1234567890abcdefghijklmnopqrstuvwxyz', 'hello?');
    expect(result.delivered).toBe(false);
    expect(result.error).toBeDefined();
  }, 10000);

  it('agents publish and query knowledge in a custom paranet', async () => {
    const agentA = await DKGAgent.create({
      name: 'KnowledgeA', listenPort: 0, skills: [],
    });
    agents.push(agentA);
    await agentA.start();

    const result = await agentA.publish('test-paranet', [
      { subject: 'did:dkg:entity:1', predicate: 'http://schema.org/name', object: '"TestEntity"', graph: '' },
      { subject: 'did:dkg:entity:1', predicate: 'http://schema.org/type', object: '"Thing"', graph: '' },
    ]);

    expect(result.kcId).toBeDefined();
    expect(result.kaManifest.length).toBe(1);

    const qr = await agentA.query(
      'SELECT ?name WHERE { <did:dkg:entity:1> <http://schema.org/name> ?name }',
      'test-paranet',
    );
    expect(qr.bindings.length).toBe(1);
    expect(qr.bindings[0]['name']).toContain('TestEntity');
  }, 10000);
});
