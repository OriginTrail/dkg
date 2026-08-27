/**
 * E2E tests for the Working Memory assertion lifecycle through DKGAgent:
 *
 * 1. assertion.create — creates a named assertion in a context graph
 * 2. assertion.write — writes triples to the assertion
 * 3. assertion.query — reads back the assertion's triples
 * 4. assertion.promote — promotes WM data to SWM
 * 5. assertion.discard — discards an assertion cleanly
 * 6. Multi-assertion isolation — two assertions don't leak data
 * 7. Promote with entity selection — only specified entities promoted
 * 8. Sub-graph assertions — assertion lifecycle within a sub-graph
 * 9. Two-node promote gossip — promoted data replicates via gossip
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { makeTestKaNumberAllocator } from "./_helpers/ka-allocator.js";
import { DKGAgent } from '../src/index.js';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { ethers } from 'ethers';

let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

const agents: DKGAgent[] = [];

afterEach(async () => {
  for (const a of agents) {
    try { await a.stop(); } catch {}
  }
  agents.length = 0;
});

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

const CG_ID = 'assertion-e2e';

async function createAgent(name: string) {
  const agent = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
    name,
    listenPort: 0,
    chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
  });
  agents.push(agent);
  await agent.start();
  await agent.createContextGraph({ id: CG_ID, name: 'Assertion E2E' });
  return agent;
}

describe('Assertion lifecycle (single agent)', () => {
  it('create → write → query → discard', async () => {
    const agent = await createAgent('AssertionBot');

    const uri = await agent.assertion.create(CG_ID, 'draft-1');
    expect(uri).toContain(CG_ID);
    // Uniform layout: WM graph is number-keyed (…/_working_memory/{addr}/{number}), not name-keyed.
    expect(uri).toContain('/_working_memory/');

    await agent.assertion.write(CG_ID, 'draft-1', [
      { subject: 'urn:alice', predicate: 'http://schema.org/name', object: '"Alice"' },
      { subject: 'urn:bob', predicate: 'http://schema.org/name', object: '"Bob"' },
    ]);

    const quads = await agent.assertion.query(CG_ID, 'draft-1');
    expect(quads.length).toBe(2);
    const names = quads.map(q => q.object).sort();
    expect(names).toEqual(['"Alice"', '"Bob"']);

    await agent.assertion.discard(CG_ID, 'draft-1');

    const afterDiscard = await agent.assertion.query(CG_ID, 'draft-1');
    expect(afterDiscard.length).toBe(0);
  }, 15_000);

  it('promote moves triples from WM to SWM', async () => {
    const agent = await createAgent('PromoteBot');

    await agent.assertion.create(CG_ID, 'to-promote');
    await agent.assertion.write(CG_ID, 'to-promote', [
      { subject: 'urn:paper:1', predicate: 'http://schema.org/name', object: '"Quantum Computing Survey"' },
      { subject: 'urn:paper:1', predicate: 'http://schema.org/author', object: '"Dr. Smith"' },
    ]);

    const beforePromote = await agent.query(
      'SELECT ?name WHERE { <urn:paper:1> <http://schema.org/name> ?name }',
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(beforePromote.bindings.length).toBe(0);

    const result = await agent.assertion.promote(CG_ID, 'to-promote');
    expect(result.promotedCount).toBeGreaterThan(0);

    const afterPromote = await agent.query(
      'SELECT ?name WHERE { <urn:paper:1> <http://schema.org/name> ?name }',
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(afterPromote.bindings.length).toBe(1);
    expect(afterPromote.bindings[0]?.['name']).toBe('"Quantum Computing Survey"');

    // WM assertion is cleaned up after promote
    const wmAfter = await agent.assertion.query(CG_ID, 'to-promote');
    expect(wmAfter.length).toBe(0);
  }, 15_000);

  it('rejects entity-subset promotion because a graph-scoped KA is atomic', async () => {
    const agent = await createAgent('SelectivePromote');

    await agent.assertion.create(CG_ID, 'selective');
    await agent.assertion.write(CG_ID, 'selective', [
      { subject: 'urn:entity:keep', predicate: 'http://schema.org/name', object: '"Keep Me"' },
      { subject: 'urn:entity:skip', predicate: 'http://schema.org/name', object: '"Skip Me"' },
    ]);

    await expect(agent.assertion.promote(CG_ID, 'selective', {
      entities: ['urn:entity:keep'],
    })).rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });
    expect(await agent.assertion.query(CG_ID, 'selective')).toHaveLength(2);
  }, 15_000);

  it('multiple assertions are isolated from each other', async () => {
    const agent = await createAgent('IsolationBot');

    await agent.assertion.create(CG_ID, 'draft-a');
    await agent.assertion.create(CG_ID, 'draft-b');

    await agent.assertion.write(CG_ID, 'draft-a', [
      { subject: 'urn:a:1', predicate: 'http://schema.org/name', object: '"From A"' },
    ]);
    await agent.assertion.write(CG_ID, 'draft-b', [
      { subject: 'urn:b:1', predicate: 'http://schema.org/name', object: '"From B"' },
    ]);

    const quadsA = await agent.assertion.query(CG_ID, 'draft-a');
    const quadsB = await agent.assertion.query(CG_ID, 'draft-b');

    expect(quadsA.length).toBe(1);
    expect(quadsA[0].subject).toBe('urn:a:1');
    expect(quadsB.length).toBe(1);
    expect(quadsB[0].subject).toBe('urn:b:1');
  }, 15_000);

  it('discard is terminal — a second mutation is rejected explicitly', async () => {
    const agent = await createAgent('IdempotentDiscard');

    await agent.assertion.create(CG_ID, 'ephemeral');
    await agent.assertion.write(CG_ID, 'ephemeral', [
      { subject: 'urn:temp', predicate: 'http://schema.org/name', object: '"Temporary"' },
    ]);

    await agent.assertion.discard(CG_ID, 'ephemeral');
    await expect(agent.assertion.discard(CG_ID, 'ephemeral'))
      .rejects.toMatchObject({ code: 'KA_WM_LIFECYCLE_REQUIRED' });

    const quads = await agent.assertion.query(CG_ID, 'ephemeral');
    expect(quads.length).toBe(0);
  }, 15_000);
});

describe('Assertion lifecycle with sub-graphs', () => {
  it('assertion in sub-graph is isolated from root graph', async () => {
    const agent = await createAgent('SubGraphAssertion');
    await agent.createSubGraph(CG_ID, 'research');

    await agent.assertion.create(CG_ID, 'sg-draft', { subGraphName: 'research' });
    await agent.assertion.write(CG_ID, 'sg-draft', [
      { subject: 'urn:sg:1', predicate: 'http://schema.org/name', object: '"Sub-graph Data"' },
    ], { subGraphName: 'research' });

    // Queryable within sub-graph
    const sgQuads = await agent.assertion.query(CG_ID, 'sg-draft', { subGraphName: 'research' });
    expect(sgQuads.length).toBe(1);

    // Promote to sub-graph SWM
    const result = await agent.assertion.promote(CG_ID, 'sg-draft', { subGraphName: 'research' });
    expect(result.promotedCount).toBeGreaterThan(0);

    // Data in sub-graph SWM
    const sgSwm = await agent.query(
      'SELECT ?name WHERE { <urn:sg:1> <http://schema.org/name> ?name }',
      { contextGraphId: CG_ID, subGraphName: 'research', graphSuffix: '_shared_memory' },
    );
    expect(sgSwm.bindings.length).toBe(1);

    // NOT in root SWM
    const rootSwm = await agent.query(
      'SELECT ?name WHERE { <urn:sg:1> <http://schema.org/name> ?name }',
      { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
    );
    expect(rootSwm.bindings.length).toBe(0);
  }, 15_000);
});

describe('Assertion promote gossip (2 nodes)', () => {
  it('a rootless Markdown-shaped KA replicates to the connected peer with its entities intact', async () => {
    const nodeA = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'PromoteGossipA',
      listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    agents.push(nodeA);
    const nodeB = await DKGAgent.create({
      kaNumberAllocator: makeTestKaNumberAllocator(),
      name: 'PromoteGossipB',
      listenPort: 0,
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    agents.push(nodeB);

    await nodeA.start();
    await nodeB.start();
    await sleep(500);

    const addrA = nodeA.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))!;
    await nodeB.connectTo(addrA);
    await sleep(500);

    await nodeA.createContextGraph({ id: CG_ID, name: 'Gossip Promote' });
    // The context-graph ontology announcement is asynchronous. Wait until the
    // peer can authorize this public CG before installing its SWM subscription.
    const discoveryDeadline = Date.now() + 10_000;
    while (!(await nodeB.contextGraphExists(CG_ID)) && Date.now() < discoveryDeadline) {
      await sleep(100);
    }
    expect(await nodeB.contextGraphExists(CG_ID)).toBe(true);
    nodeB.subscribeToContextGraph(CG_ID);
    await sleep(500);

    const markdownRoot = 'did:dkg:context-graph:assertion-e2e/assertion/0xauthor/readme.md';
    // The Markdown extractor emits section blank nodes. Finalization owns the
    // conversion into the protocol-reserved urn:dkg:ka-skolem namespace.
    const markdownSection = '_:section-safety';
    const markdownFile = 'urn:dkg:file:keccak256:abc';
    await nodeA.assertion.create(CG_ID, 'gossip-draft');
    await nodeA.assertion.write(CG_ID, 'gossip-draft', [
      { subject: markdownRoot, predicate: 'http://schema.org/name', object: '"Construction notes"' },
      { subject: markdownRoot, predicate: 'http://dkg.io/ontology/sourceContentType', object: '"text/markdown"' },
      { subject: markdownRoot, predicate: 'http://dkg.io/ontology/sourceFile', object: markdownFile },
      { subject: markdownRoot, predicate: 'http://dkg.io/ontology/markdownForm', object: markdownFile },
      { subject: markdownRoot, predicate: 'http://dkg.io/ontology/rootEntity', object: markdownRoot },
      { subject: markdownRoot, predicate: 'http://dkg.io/ontology/hasSection', object: markdownSection },
      { subject: markdownSection, predicate: 'http://schema.org/name', object: '"Safety"' },
    ]);

    const publishWorkspaceGossip = vi.spyOn(nodeA, 'publishWorkspaceGossip');
    const promoted = await nodeA.assertion.promote(CG_ID, 'gossip-draft');
    expect(promoted.shareOperationId).toBeTruthy();
    const publishCall = publishWorkspaceGossip.mock.calls[0];
    expect(publishCall?.[0]).toBe(CG_ID);
    expect(publishCall?.[1]).toEqual({
      message: expect.any(Uint8Array),
      fanout: { kind: 'resolve-current' },
    });
    expect(publishCall?.[4]).toBe(promoted.shareOperationId);

    const deadline = Date.now() + 15_000;
    let bindings: any[] = [];
    while (Date.now() < deadline) {
      const result = await nodeB.query(
        `SELECT ?title ?contentType ?sectionName WHERE {
          <${markdownRoot}> <http://schema.org/name> ?title ;
            <http://dkg.io/ontology/sourceContentType> ?contentType ;
            <http://dkg.io/ontology/hasSection> ?section .
          ?section <http://schema.org/name> ?sectionName .
        }`,
        { contextGraphId: CG_ID, graphSuffix: '_shared_memory' },
      );
      bindings = result.bindings;
      if (bindings.length > 0) break;
      await sleep(500);
    }
    expect(bindings.length).toBe(1);
    expect(bindings[0]?.['title']).toBe('"Construction notes"');
    expect(bindings[0]?.['contentType']).toBe('"text/markdown"');
    expect(bindings[0]?.['sectionName']).toBe('"Safety"');
  }, 20_000);
});
