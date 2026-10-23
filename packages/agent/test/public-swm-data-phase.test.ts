/**
 * The data-phase gate of a public shared-memory sync round (#3421): the
 * aggregate data phase is fetched only for legacy roots and graph-backed
 * snapshots, as the private recovery lane does. A graph of graph-scoped
 * shares gets its content from the snapshot phase alone.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  contextGraphWorkspaceGraphUri,
  createOperationContext,
  workspaceKnowledgeAssetOperationSnapshotGraph,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { fetchPublicSwmDataPhase } from '../src/sync/requester/public-swm-data-phase.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import { processSharedMemoryBatch } from '../src/sync-verify-worker-impl.js';
import { getSyncCheckpointKey } from '../src/sync/checkpoint/state.js';
import { runManagedSwmSyncHarness } from './_helpers/swm-sync-harness.js';
import { swmFixtures } from './swm-descriptor-fixtures.js';

const CG = '0x5555555555555555555555555555555555555555/data-phase-gate';
const PEER = '12D3KooWDataPhaseResponder';
const DKG = 'http://dkg.io/ontology/';
const fixtures = swmFixtures(CG);
const META_GRAPH = fixtures.metaGraph;
const DATA_GRAPH = contextGraphWorkspaceGraphUri(CG);
const ctx = createOperationContext('sync');

function page(quads: Quad[], phase: 'meta' | 'data' = 'data'): SyncPageResult {
  return {
    quads,
    bytesReceived: quads.length,
    resumedFromOffset: 0,
    nextOffset: quads.length,
    checkpointKey: `${CG}:${phase}`,
    completed: true,
    timedOut: false,
  };
}

/** A legacy share's metadata: a workspace operation rooted at `root`. */
function legacyMeta(root: string): Quad[] {
  const operation = `urn:dkg:share:${CG}:op-legacy`;
  return [
    { subject: operation, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${DKG}WorkspaceOperation`, graph: META_GRAPH },
    { subject: operation, predicate: `${DKG}publishedAt`, object: '"2026-10-23T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>', graph: META_GRAPH },
    { subject: operation, predicate: `${DKG}rootEntity`, object: root, graph: META_GRAPH },
    { subject: operation, predicate: `${DKG}publisherPeerId`, object: '"peer-source"', graph: META_GRAPH },
  ];
}

/** The gate over `metaQuads`, with a fetch that records whether it ran and serves `served`. */
async function gate(metaQuads: Quad[], options: { whole?: boolean; served?: Quad[] } = {}) {
  const fetch = vi.fn(async () => page(options.served ?? []));
  const verifyMetadata = vi.fn((quads: Quad[]) => Promise.resolve(processSharedMemoryBatch([], quads, CG, [], [])));
  const phase = await fetchPublicSwmDataPhase({
    contextGraphId: CG,
    remotePeerId: PEER,
    metaQuads,
    metaWhole: options.whole ?? true,
    verifyMetadata,
    fetch,
  });
  return { phase, fetch, verifyMetadata };
}

describe('the data phase of a public shared-memory round (#3421)', () => {
  it('is not fetched for the metadata of graph-scoped shares: complete and empty, with the metadata\'s verification', async () => {
    const share = fixtures.share({ version: 1, operationId: 'op-1', marker: 'one', ual: 'did:dkg:hardhat:31337/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/1' });

    const { phase, fetch } = await gate(share.meta);

    expect(fetch).not.toHaveBeenCalled();
    expect(phase.result).toEqual({
      quads: [],
      bytesReceived: 0,
      resumedFromOffset: 0,
      nextOffset: 0,
      checkpointKey: getSyncCheckpointKey(PEER, CG, true, 'data'),
      completed: true,
      timedOut: false,
    });
    expect(phase.metadataOnly?.verifiedMeta).toHaveLength(share.meta.length);
    expect(phase.descriptors?.map(({ assertionGraph }) => assertionGraph)).toEqual([share.assertionGraph]);
  });

  it('is fetched when the metadata names a root entity, and keeps graph-scoped transport graphs out of the root check', async () => {
    const share = fixtures.share({ version: 1, operationId: 'op-1', marker: 'one', ual: 'did:dkg:hardhat:31337/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/1' });
    const legacy: Quad = { subject: 'urn:legacy:root', predicate: 'http://schema.org/name', object: '"kept"', graph: DATA_GRAPH };
    const transported: Quad = { subject: 'urn:snap:one:0', predicate: 'http://schema.org/status', object: '"one"', graph: share.assertionGraph };

    const { phase, fetch } = await gate([...share.meta, ...legacyMeta('urn:legacy:root')], { served: [legacy, transported] });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(phase.metadataOnly).toBeUndefined();
    expect(phase.legacyQuads(phase.result.quads)).toEqual([legacy]);
  });

  it('is fetched for a legacy root whose operation names no creator, which the verifier still admits rows for', async () => {
    const withoutCreator = legacyMeta('urn:legacy:root').filter((row) => row.predicate !== `${DKG}publisherPeerId`);

    const { phase, fetch, verifyMetadata } = await gate(withoutCreator);

    expect((await verifyMetadata.mock.results[0]!.value).entityCreators).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(phase.metadataOnly).toBeUndefined();
  });

  it('is fetched when the metadata is not whole, is empty, or does not parse, and then checks every quad', async () => {
    const share = fixtures.share({ version: 1, operationId: 'op-1', marker: 'one', ual: 'did:dkg:hardhat:31337/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/1' });
    const quad: Quad = { subject: 'urn:any', predicate: 'http://schema.org/name', object: '"x"', graph: share.assertionGraph };
    const notWhole = await gate(share.meta, { whole: false, served: [quad] });
    const empty = await gate([], { served: [quad] });
    // A head whose operation names another asset: the parser refuses the metadata.
    const broken = share.meta.map((row) => (row.predicate === `${DKG}kaUal` && row.subject === share.headSubject
      ? { ...row, object: 'did:dkg:hardhat:31337/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/9' }
      : row));
    const unparsed = await gate(broken, { served: [quad] });

    for (const { phase, fetch } of [notWhole, empty, unparsed]) {
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(phase.legacyQuads(phase.result.quads)).toEqual([quad]);
    }
    expect(notWhole.verifyMetadata).not.toHaveBeenCalled();
    expect(empty.verifyMetadata).not.toHaveBeenCalled();
  });

  it('is fetched for a graph-backed snapshot, whose bytes travel in it, and keeps its graphs out of the root check', async () => {
    const share = fixtures.share({ version: 1, operationId: 'op-g', marker: 'g', ual: 'did:dkg:hardhat:31337/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/7' });
    const snapshotGraph = workspaceKnowledgeAssetOperationSnapshotGraph(CG, 'op-g');
    const graphBacked = share.meta
      .filter((row) => row.predicate !== `${DKG}publicSnapshotRef`)
      .concat({ subject: share.operationSubject, predicate: `${DKG}publicSnapshotGraph`, object: snapshotGraph, graph: META_GRAPH });
    const inLocator: Quad = { subject: 'urn:snap:g:0', predicate: 'http://schema.org/status', object: '"g"', graph: snapshotGraph };

    const { phase, fetch } = await gate(graphBacked, { served: [inLocator] });

    expect(phase.descriptors?.map(({ snapshotSource }) => snapshotSource.locator)).toEqual([{ kind: 'graph', graph: snapshotGraph }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(phase.metadataOnly).toBeUndefined();
    expect(phase.legacyQuads(phase.result.quads)).toEqual([]);
  });
});

describe('a public shared-memory round of graph-scoped shares (#3421)', () => {
  it('materializes the share without asking for the data phase, even where that phase would fail', async () => {
    const share = fixtures.share({ version: 1, operationId: 'op-1', marker: 'one', ual: 'did:dkg:hardhat:31337/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/1' });
    const phases: string[] = [];

    const { summary } = await runManagedSwmSyncHarness({
      ctx,
      contextGraphId: CG,
      served: share,
      fetchPage: async ({ phase }, fallback) => {
        phases.push(phase);
        if (phase === 'data') throw new Error('The stream has been reset');
        return fallback;
      },
    });

    expect(phases).not.toContain('data');
    expect(summary.insertedDataTriples).toBe(share.payload.length);
    expect(summary.failedPeers).toBe(0);
    expect(summary.failedPhases).toBe(0);
  });
});

describe('a public shared-memory round with legacy rows (#3421)', () => {
  it('still fetches the data phase, and names the graph and the peer when it drops rows', async () => {
    const warnings: string[] = [];
    const inserted: Quad[] = [];
    const kept: Quad = { subject: 'urn:legacy:root', predicate: 'http://schema.org/name', object: '"kept"', graph: DATA_GRAPH };
    const stray: Quad = { subject: 'urn:stray', predicate: 'http://schema.org/name', object: '"dropped"', graph: DATA_GRAPH };
    const phases: string[] = [];

    await runSharedMemorySync({
      mode: { kind: 'ordinary' },
      ctx,
      remotePeerId: PEER,
      contextGraphIds: [CG],
      createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (_ctx, _peer, _contextGraphId, _includeSharedMemory, phase) => {
        phases.push(phase);
        return phase === 'meta' ? page(legacyMeta('urn:legacy:root'), 'meta') : page(phase === 'data' ? [kept, stray] : []);
      },
      processSharedMemoryBatch: async (data, meta, contextGraphId, registered, excluded) => (
        processSharedMemoryBatch(data, meta, contextGraphId, registered, excluded)
      ),
      ensureContextGraph: async () => {},
      storeInsert: async (quads) => { inserted.push(...quads); },
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      ensureOwnedMap: () => new Map(),
      logInfo: () => {},
      logWarn: (_ctx, message) => { warnings.push(message); },
      logDebug: () => {},
    });

    expect(phases).toEqual(['meta', 'data']);
    expect(inserted).toContainEqual(kept);
    expect(inserted).not.toContainEqual(stray);
    expect(warnings).toContain(
      `SWM sync dropped 1 triples with invalid subjects (not in meta rootEntity or skolemized child) for "${CG}" from ${PEER.slice(-8)}`,
    );
  });
});
