import { afterEach, describe, expect, it } from 'vitest';
import { createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import { GraphManager, OxigraphStore, PrivateContentStore, decodeKnowledgeAssetPrivateArtifact, knowledgeAssetPrivateArtifactOwnerCandidates, readKnowledgeAssetPrivateArtifactsPage } from '../src/index.js';

const CG = 'private-artifact/layout';
const UAL = 'did:dkg:31337/0x1111111111111111111111111111111111111111/7';
const AUTHOR = '0x1111111111111111111111111111111111111111';
const stores: OxigraphStore[] = [];
function fixture() { const store = new OxigraphStore(); stores.push(store); return { store, privateStore: new PrivateContentStore(store, new GraphManager(store)) }; }
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });

describe('storage-owned private artifact discovery', () => {
  it('retains every legal owner interpretation of slash-containing namespaces', () => {
    const graph = `did:dkg:context-graph:a/b/_private/${AUTHOR}/7/assertions/3/commitments/${'ab'.repeat(32)}`;
    expect(knowledgeAssetPrivateArtifactOwnerCandidates(graph)).toEqual(expect.arrayContaining([
      { contextGraphId: 'a', subGraphName: 'b' },
      { contextGraphId: 'a/b', subGraphName: undefined },
    ]));
    expect(knowledgeAssetPrivateArtifactOwnerCandidates('urn:unrecognized')).toEqual([]);
  });
  it.each([undefined, 'topic'])('decodes builder-produced version and commitment graphs in %s', async subGraphName => {
    const { privateStore } = fixture(); const scope = createGraphKnowledgeAssetScope(UAL, 2);
    const legacy = privateStore.knowledgeAssetPrivateGraphUri(CG, scope, subGraphName);
    const commitment = 'ab'.repeat(32);
    const archive = privateStore.knowledgeAssetPrivateCommitmentGraphUri(CG, scope, `0x${commitment}`, subGraphName);
    const identity = { contextGraphId: CG, subGraphName, agentAddress: AUTHOR, kaNumber: '7', assertionVersion: '2' };
    expect(decodeKnowledgeAssetPrivateArtifact(CG, legacy)).toEqual({ ...identity, graphUri: legacy, commitmentId: undefined });
    expect(decodeKnowledgeAssetPrivateArtifact(CG, archive)).toEqual({ ...identity, graphUri: archive, commitmentId: commitment });
    expect(decodeKnowledgeAssetPrivateArtifact('other', archive)).toBeUndefined();
    for (const invalid of [legacy.replace('/assertions/2', '/assertions/0'), legacy.replace('/7/', '/0/'), `${legacy}/commitments/invalid`, privateStore.knowledgeAssetPrivateDraftGraphUri(CG, AUTHOR, 'draft', subGraphName)]) {
      expect(decodeKnowledgeAssetPrivateArtifact(CG, invalid)).toBeUndefined();
    }
  });

  it('pages nonempty private graph identities once and advances past unknown layouts', async () => {
    const { store, privateStore } = fixture(); const expected: string[] = [];
    for (let version = 1; version <= 20; version += 1) {
      const scope = createGraphKnowledgeAssetScope(UAL, version);
      expected.push(privateStore.knowledgeAssetPrivateGraphUri(CG, scope));
      expected.push(privateStore.knowledgeAssetPrivateCommitmentGraphUri(CG, scope, 'ab'.repeat(32), 'topic'));
    }
    const empty = privateStore.knowledgeAssetPrivateGraphUri(CG, createGraphKnowledgeAssetScope(UAL, 99));
    await store.createGraph(empty);
    const unknown = privateStore.knowledgeAssetPrivateDraftGraphUri(CG, AUTHOR, 'unknown');
    const outside = privateStore.knowledgeAssetPrivateGraphUri('other', createGraphKnowledgeAssetScope(UAL, 3));
    await store.insert([...expected, unknown, outside].map(graph => ({ graph, subject: 'urn:item', predicate: 'urn:secret', object: '"private"' })));
    const found: string[] = []; const cursors = new Set<string>(); let cursor = '';
    do {
      const page = await readKnowledgeAssetPrivateArtifactsPage(store, CG, { cursor, limit: 7 });
      expect(page).toBeDefined(); expect(page!.artifacts.length).toBeLessThanOrEqual(7);
      found.push(...page!.artifacts.map(artifact => artifact.graphUri)); cursor = page!.nextCursor;
      if (cursor) { expect(cursors.has(cursor)).toBe(false); cursors.add(cursor); }
    } while (cursor);
    expect(found.sort()).toEqual(expected.sort());
    expect(new Set(found).size).toBe(40);
  });

  it('refuses unbounded page sizes and keeps unavailable query coverage explicit', async () => {
    const { store } = fixture();
    for (const limit of [0, 129, NaN, 1.5]) await expect(readKnowledgeAssetPrivateArtifactsPage(store, CG, { limit })).rejects.toThrow('page limit');
    store.query = async () => ({ type: 'boolean', value: false });
    expect(await readKnowledgeAssetPrivateArtifactsPage(store, CG)).toBeUndefined();
  });
});
