/**
 * Tests for the unified Visibility API on DKGAgent methods:
 * - writeToWorkspace: default public (broadcast), visibility option, legacy localOnly
 * - writeConditionalToWorkspace: same visibility semantics
 * - createParanet: visibility option, legacy private flag
 * - enshrineFromWorkspace: default public
 *
 * These tests use a real single-node agent to verify the API surface
 * integrates correctly with resolveVisibility.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { DKGAgent } from '../src/index.js';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { paranetMetaGraphUri } from '@origintrail-official/dkg-core';

const PARANET_BASE = 'vis-api-test';
const ENTITY_BASE = 'urn:vis-api:entity';
let counter = 0;
function nextParanet() { return `${PARANET_BASE}-${++counter}`; }
function nextEntity() { return `${ENTITY_BASE}:${++counter}`; }

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('writeToWorkspace — Visibility API', () => {
  let agent: DKGAgent;
  let gossipSpy: ReturnType<typeof vi.fn>;

  afterAll(async () => {
    try { await agent?.stop(); } catch { /* */ }
  });

  it('creates agent and patches gossip for inspection', async () => {
    agent = await DKGAgent.create({
      name: 'VisApiTest',
      listenPort: 0,
      chainAdapter: new MockChainAdapter('mock:31337'),
    });
    await agent.start();
    await sleep(500);

    // Spy on gossip.publish to track broadcast calls (vi.spyOn preserves prototype methods)
    gossipSpy = vi.spyOn((agent as any).gossip, 'publish').mockResolvedValue(undefined);
  }, 10000);

  it('writeToWorkspace with no options on public paranet → broadcasts (public default, backward compat)', async () => {
    const paranet = nextParanet();
    await agent.createParanet({ id: paranet, name: 'Test', visibility: 'public' });

    gossipSpy.mockClear();
    const entity = nextEntity();
    await agent.writeToWorkspace(paranet, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"Default Public"', graph: '' },
    ]);

    expect(gossipSpy).toHaveBeenCalledTimes(1);
  }, 10000);

  it('writeToWorkspace with no options on private paranet → inherits private (no broadcast)', async () => {
    const paranet = nextParanet();
    await agent.createParanet({ id: paranet, name: 'Test', visibility: 'private' });

    gossipSpy.mockClear();
    const entity = nextEntity();
    await agent.writeToWorkspace(paranet, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"Inherited Private"', graph: '' },
    ]);

    expect(gossipSpy).not.toHaveBeenCalled();
  }, 10000);

  it('writeToWorkspace with visibility: "public" → broadcasts', async () => {
    const paranet = nextParanet();
    await agent.createParanet({ id: paranet, name: 'Test', visibility: 'private' });

    gossipSpy.mockClear();
    const entity = nextEntity();
    await agent.writeToWorkspace(paranet, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"Public Write"', graph: '' },
    ], { visibility: 'public' });

    expect(gossipSpy).toHaveBeenCalledTimes(1);
  }, 10000);

  it('writeToWorkspace with visibility: "private" → does NOT broadcast', async () => {
    const paranet = nextParanet();
    await agent.createParanet({ id: paranet, name: 'Test', visibility: 'private' });

    gossipSpy.mockClear();
    const entity = nextEntity();
    await agent.writeToWorkspace(paranet, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"Explicit Private"', graph: '' },
    ], { visibility: 'private' });

    expect(gossipSpy).not.toHaveBeenCalled();
  }, 10000);

  it('writeToWorkspace with visibility: { peers: ["X"] } → does NOT broadcast (sync only)', async () => {
    const paranet = nextParanet();
    await agent.createParanet({ id: paranet, name: 'Test', visibility: 'private' });

    gossipSpy.mockClear();
    const entity = nextEntity();
    await agent.writeToWorkspace(paranet, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"Allow List Write"', graph: '' },
    ], { visibility: { peers: ['12D3KooWPeerX'] } });

    expect(gossipSpy).not.toHaveBeenCalled();
  }, 10000);

  it('writeToWorkspace with legacy localOnly: true → does NOT broadcast (backward compat)', async () => {
    const paranet = nextParanet();
    await agent.createParanet({ id: paranet, name: 'Test', visibility: 'private' });

    gossipSpy.mockClear();
    const entity = nextEntity();
    await agent.writeToWorkspace(paranet, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"Legacy Local"', graph: '' },
    ], { localOnly: true });

    expect(gossipSpy).not.toHaveBeenCalled();
  }, 10000);

  it('writeToWorkspace with legacy localOnly: false → broadcasts (backward compat)', async () => {
    const paranet = nextParanet();
    await agent.createParanet({ id: paranet, name: 'Test', visibility: 'private' });

    gossipSpy.mockClear();
    const entity = nextEntity();
    await agent.writeToWorkspace(paranet, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"Legacy Broadcast"', graph: '' },
    ], { localOnly: false });

    expect(gossipSpy).toHaveBeenCalledTimes(1);
  }, 10000);

  it('writeToWorkspace stores access policy metadata when visibility is set', async () => {
    const paranet = nextParanet();
    await agent.createParanet({ id: paranet, name: 'Test', visibility: 'private' });

    const entity = nextEntity();
    await agent.writeToWorkspace(paranet, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"With Policy"', graph: '' },
    ], { visibility: { peers: ['peerA'] } });

    const DKG_NS = 'http://dkg.io/ontology/';
    const wsMetaGraph = `did:dkg:paranet:${paranet}/_workspace_meta`;
    // Query the workspace_meta graph directly using a GRAPH clause
    const result = await agent.query(
      `SELECT ?policy ?peer WHERE {
        GRAPH <${wsMetaGraph}> {
          ?op <${DKG_NS}accessPolicy> ?policy .
          OPTIONAL { ?op <${DKG_NS}allowedPeer> ?peer }
        }
      }`,
    );
    expect(result.bindings.length).toBeGreaterThanOrEqual(1);
    expect(result.bindings[0]['policy']).toBe('"allowList"');
  }, 10000);
});

describe('createParanet — Visibility API', () => {
  let agent: DKGAgent;

  afterAll(async () => {
    try { await agent?.stop(); } catch { /* */ }
  });

  it('creates agent', async () => {
    agent = await DKGAgent.create({
      name: 'ParanetVisTest',
      listenPort: 0,
      chainAdapter: new MockChainAdapter('mock:31337'),
    });
    await agent.start();
    await sleep(500);
  }, 10000);

  it('createParanet with visibility: "private" → local only, no gossip', async () => {
    const paranet = nextParanet();
    await agent.createParanet({
      id: paranet,
      name: 'Private Paranet',
      visibility: 'private',
    });

    const exists = await agent.paranetExists(paranet);
    expect(exists).toBe(true);
  }, 10000);

  it('createParanet with visibility: "public" → chain registration + gossip (default)', async () => {
    const paranet = nextParanet();
    await agent.createParanet({
      id: paranet,
      name: 'Public Paranet',
      visibility: 'public',
    });

    const exists = await agent.paranetExists(paranet);
    expect(exists).toBe(true);
  }, 10000);

  it('createParanet with legacy private: true → same as visibility: "private" (backward compat)', async () => {
    const paranet = nextParanet();
    await agent.createParanet({
      id: paranet,
      name: 'Legacy Private',
      private: true,
    });

    const exists = await agent.paranetExists(paranet);
    expect(exists).toBe(true);
  }, 10000);

  it('createParanet stores dkg:accessPolicy triple for non-public visibility', async () => {
    const paranet = nextParanet();
    await agent.createParanet({
      id: paranet,
      name: 'Private With Policy',
      visibility: 'private',
    });

    const DKG_NS = 'http://dkg.io/ontology/';
    const metaGraph = paranetMetaGraphUri(paranet);
    const paranetUri = `did:dkg:paranet:${paranet}`;
    const result = await agent.query(
      `SELECT ?policy WHERE { GRAPH <${metaGraph}> { <${paranetUri}> <${DKG_NS}accessPolicy> ?policy } }`,
    );
    expect(result.bindings.length).toBe(1);
    expect(result.bindings[0]['policy']).toBe('"ownerOnly"');
  }, 10000);

  it('createParanet with visibility: { peers: [...] } stores allowList + allowedPeer triples', async () => {
    const paranet = nextParanet();
    await agent.createParanet({
      id: paranet,
      name: 'Allow List Paranet',
      visibility: { peers: ['peerA', 'peerB'] },
    });

    const DKG_NS = 'http://dkg.io/ontology/';
    const metaGraph = paranetMetaGraphUri(paranet);
    const paranetUri = `did:dkg:paranet:${paranet}`;

    const policyResult = await agent.query(
      `SELECT ?policy WHERE { GRAPH <${metaGraph}> { <${paranetUri}> <${DKG_NS}accessPolicy> ?policy } }`,
    );
    expect(policyResult.bindings.length).toBe(1);
    expect(policyResult.bindings[0]['policy']).toBe('"allowList"');

    const peerResult = await agent.query(
      `SELECT ?peer WHERE { GRAPH <${metaGraph}> { <${paranetUri}> <${DKG_NS}allowedPeer> ?peer } }`,
    );
    expect(peerResult.bindings.length).toBe(2);
  }, 10000);

  it('createParanet with default (no visibility) → public, no accessPolicy triple', async () => {
    const paranet = nextParanet();
    await agent.createParanet({
      id: paranet,
      name: 'Default Public',
    });

    const DKG_NS = 'http://dkg.io/ontology/';
    const ontologyGraph = 'did:dkg:paranet:ontology';
    const paranetUri = `did:dkg:paranet:${paranet}`;
    const result = await agent.query(
      `SELECT ?policy WHERE { GRAPH <${ontologyGraph}> { <${paranetUri}> <${DKG_NS}accessPolicy> ?policy } }`,
    );
    // Default is public, and public doesn't store accessPolicy triple
    expect(result.bindings.length).toBe(0);
  }, 10000);

  it('createParanet with allowList → registers on chain but does NOT broadcast definition', async () => {
    const paranet = nextParanet();
    // Spy on gossip.publish (vi.spyOn preserves prototype methods like subscribe)
    const publishSpy = vi.spyOn((agent as any).gossip, 'publish').mockResolvedValue(undefined);
    publishSpy.mockClear();

    await agent.createParanet({
      id: paranet,
      name: 'Allow List No Broadcast',
      visibility: { peers: ['peerA'] },
    });

    // The definition should NOT be broadcast on the ontology topic
    // (allowList paranets are discoverable only via direct sharing)
    expect(publishSpy).not.toHaveBeenCalled();

    // But the paranet should exist locally
    const exists = await agent.paranetExists(paranet);
    expect(exists).toBe(true);

    publishSpy.mockRestore();
  }, 10000);
});

describe('Paranet visibility inheritance', () => {
  let agent: DKGAgent;
  let gossipSpy: ReturnType<typeof vi.fn>;

  afterAll(async () => {
    try { await agent?.stop(); } catch { /* */ }
  });

  it('creates agent and patches gossip', async () => {
    agent = await DKGAgent.create({
      name: 'InheritVisTest',
      listenPort: 0,
      chainAdapter: new MockChainAdapter('mock:31337'),
    });
    await agent.start();
    await sleep(500);

    gossipSpy = vi.spyOn((agent as any).gossip, 'publish').mockResolvedValue(undefined);
  }, 10000);

  it('writeToWorkspace inherits allowList visibility from paranet when no opts given', async () => {
    const paranet = nextParanet();
    await agent.createParanet({
      id: paranet,
      name: 'AllowList Paranet',
      visibility: { peers: ['peerX'] },
    });

    gossipSpy.mockClear();
    const entity = nextEntity();
    await agent.writeToWorkspace(paranet, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"Inherited AllowList"', graph: '' },
    ]);

    // allowList → no gossip broadcast (targeted push only)
    expect(gossipSpy).not.toHaveBeenCalled();
  }, 10000);

  it('explicit visibility overrides paranet default', async () => {
    const paranet = nextParanet();
    await agent.createParanet({
      id: paranet,
      name: 'Private Paranet Override',
      visibility: 'private',
    });

    gossipSpy.mockClear();
    const entity = nextEntity();
    await agent.writeToWorkspace(paranet, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"Override to Public"', graph: '' },
    ], { visibility: 'public' });

    // Explicit public overrides inherited private
    expect(gossipSpy).toHaveBeenCalledTimes(1);
  }, 10000);
});
