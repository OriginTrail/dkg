import { TEST_SNAPSHOT_STORAGE } from '../../../scripts/testing/snapshot-storage.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  PROTOCOL_SYNC,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  FileWorkspacePublicSnapshotStore,
  serializeWorkspacePublicSnapshotQuads,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import type {
  SyncPageFetchOptions,
  SyncPageResult,
} from '../src/sync/requester/page-fetch.js';
import { DKGAgent } from '../src/index.js';
import {
  allowAllNetworkAdmission,
  asSyncOnConnectTestAgent,
  emptyDetailedSync,
  peerSyncSessionDriver,
  recorder,
  resetPeerSyncSessionForTest,
  type SyncOnConnectTestAgent,
} from './_helpers/sync-on-connect-test-fixture.js';

const CHANGED_GRAPH = 'authority-catchup-changed';
const UNCHANGED_GRAPH = 'authority-catchup-unchanged';
const REMOTE_PEER = '12D3KooWAuthorityCatchupScopeRemote';

type FetchSyncPages = (
  ctx: OperationContext,
  remotePeerId: string,
  contextGraphId: string,
  includeSharedMemory: boolean,
  phase: 'data' | 'meta' | 'snapshot',
  graphUri: string,
  deadline: number,
  options?: SyncPageFetchOptions,
) => Promise<SyncPageResult>;

interface CatchupTestSeams {
  fetchSyncPages: FetchSyncPages;
  canUseSharedMemoryForContextGraph: (contextGraphId: string) => Promise<boolean>;
  resolveRfc64CatalogReceiverAuthorityV1: () => { legacySyncAllowed: boolean };
}

describe('graph-scoped authority catch-up', () => {
  const tempDirs: string[] = [];
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    await Promise.all(agents.splice(0).map(async (agent) => {
      await agent.stop().catch(() => {});
      await agent.store.close().catch(() => {});
    }));
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('delivers the changed graph that an earlier pass skipped, and only that graph', async () => {
    const sourceDataDir = await tempDataDir();
    const source = await createAgent('AuthorityCatchupSource', sourceDataDir);
    const sourceSnapshots = new FileWorkspacePublicSnapshotStore(
      join(sourceDataDir, 'swm-public-snapshots'),
      undefined,
      TEST_SNAPSHOT_STORAGE,
    );
    await source.publisher.writeToWorkspace(CHANGED_GRAPH, [
      { subject: 'urn:catchup:changed', predicate: 'http://schema.org/name', object: '"Changed"', graph: '' },
    ], { publisherPeerId: 'peer-source' });
    await source.publisher.writeToWorkspace(UNCHANGED_GRAPH, [
      { subject: 'urn:catchup:unchanged', predicate: 'http://schema.org/name', object: '"Unchanged"', graph: '' },
    ], { publisherPeerId: 'peer-source' });

    const target = await createTarget('AuthorityCatchupTarget');
    target.config.syncContextGraphs = [CHANGED_GRAPH, UNCHANGED_GRAPH];
    // The changed graph's authority is still pending, so the local
    // shared-memory gate refuses it for now.
    let changedGraphAuthorityAccepted = false;
    const seams = target as unknown as CatchupTestSeams;
    seams.canUseSharedMemoryForContextGraph = async (contextGraphId) => (
      contextGraphId !== CHANGED_GRAPH || changedGraphAuthorityAccepted
    );
    // Durable recovery is not under test: record which graphs it is asked for.
    const durableGraphs = recorder(async (contextGraphId: string) => {
      void contextGraphId;
      return { result: { ...emptyDetailedSync({ completedPhases: 1 }), complete: true } };
    });
    (target as unknown as { syncDurableRecoveryContextGraph: unknown })
      .syncDurableRecoveryContextGraph = durableGraphs;
    const fetchedGraphs: string[] = [];
    installSharedMemoryPageTransport(target, source, sourceSnapshots, fetchedGraphs);
    const session = peerSyncSessionDriver(target);
    const syncErrors: unknown[] = [];
    const onError = (_peerId: string, error: unknown) => { syncErrors.push(error); };

    // 1. An ordinary pass while the authority is pending syncs the other
    //    graph and marks the peer fresh.
    expect(target.queueSyncFromPeerOnConnect(REMOTE_PEER, onError, 0)).toBe(true);
    await whenPeerJobDone(target);
    await expect(workspaceNames(target, UNCHANGED_GRAPH)).resolves.toEqual(['"Unchanged"']);
    await expect(workspaceNames(target, CHANGED_GRAPH)).resolves.toEqual([]);
    const freshAfterOrdinaryPass = session.snapshot(REMOTE_PEER).lastSuccessfulSync;
    expect(freshAfterOrdinaryPass).toBeDefined();

    // 2. The authority is accepted. The fresh peer holds off an ordinary pass.
    changedGraphAuthorityAccepted = true;
    expect(target.queueSyncFromPeerOnConnect(REMOTE_PEER, onError, 0)).toBe(false);
    expect(durableGraphs.calls.map(([contextGraphId]) => contextGraphId).sort())
      .toEqual([CHANGED_GRAPH, UNCHANGED_GRAPH]);
    fetchedGraphs.length = 0;
    durableGraphs.calls.length = 0;

    // 3. The catch-up for the changed graph still runs, and pulls only it.
    expect(target.queueSyncFromPeerOnConnect(REMOTE_PEER, onError, 0, {
      authorityScopeChanged: true,
      authorityScopeContextGraphIds: new Set([CHANGED_GRAPH]),
    })).toBe(true);
    await whenPeerJobDone(target);

    await expect(workspaceNames(target, CHANGED_GRAPH)).resolves.toEqual(['"Changed"']);
    expect([...new Set(fetchedGraphs)]).toEqual([CHANGED_GRAPH]);
    expect(durableGraphs.calls.map(([contextGraphId]) => contextGraphId)).toEqual([CHANGED_GRAPH]);
    // The graph pass says nothing about the peer's other graphs.
    expect(session.snapshot(REMOTE_PEER).lastSuccessfulSync).toBe(freshAfterOrdinaryPass);
    expect(syncErrors).toEqual([]);
  });

  it('keeps a graph-scoped pass to its graphs even when one is listed by its wire id', async () => {
    const target = await createTarget('AuthorityCatchupWireId');
    const wireId = `0x${'ab'.repeat(32)}`;
    target.config.syncContextGraphs = [wireId, UNCHANGED_GRAPH];
    (target as unknown as { wireIdToLocalCgId: Map<string, string> })
      .wireIdToLocalCgId.set(wireId, CHANGED_GRAPH);
    const durableGraphs = recorder(async (contextGraphId: string) => {
      void contextGraphId;
      return { result: { ...emptyDetailedSync({ completedPhases: 1 }), complete: true } };
    });
    (target as unknown as { syncDurableRecoveryContextGraph: unknown })
      .syncDurableRecoveryContextGraph = durableGraphs;
    const plannedScopes = recorder(async (_peerId: string | undefined, contextGraphIds: readonly string[]) => {
      void contextGraphIds;
      return { targets: [] };
    });
    target.planSharedMemorySyncContextGraphs = plannedScopes as never;

    await expect(target.trySyncFromPeer(
      REMOTE_PEER,
      undefined,
      'on-connect',
      new Set([CHANGED_GRAPH]),
    )).resolves.toBe('synced');

    expect(durableGraphs.calls.map(([contextGraphId]) => contextGraphId)).toEqual([wireId]);
    expect(plannedScopes.calls.map(([, contextGraphIds]) => contextGraphIds)).toEqual([[wireId]]);
    expect(peerSyncSessionDriver(target).snapshot(REMOTE_PEER).lastSuccessfulSync).toBeUndefined();
  });

  async function tempDataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dkg-authority-catchup-scope-'));
    tempDirs.push(dir);
    return dir;
  }

  async function createAgent(name: string, dataDir?: string): Promise<DKGAgent> {
    const agent = await DKGAgent.create({
      name,
      dataDir: dataDir ?? await tempDataDir(),
      sharedMemoryPublicSnapshotStorage: TEST_SNAPSHOT_STORAGE,
      listenHost: '127.0.0.1',
      chainAdapter: new MockChainAdapter(),
      rfc64CatalogActivation: { enabled: false },
    });
    (agent as unknown as CatchupTestSeams).resolveRfc64CatalogReceiverAuthorityV1 = () => ({
      legacySyncAllowed: true,
    });
    agents.push(agent);
    return agent;
  }

  async function createTarget(name: string): Promise<SyncOnConnectTestAgent> {
    const target = asSyncOnConnectTestAgent(await createAgent(name));
    resetPeerSyncSessionForTest(target);
    target.started = true;
    allowAllNetworkAdmission(target);
    target.getPeerProtocols = async () => [PROTOCOL_SYNC];
    target.refreshMetaSyncedFlags = async () => undefined;
    target.discoverContextGraphsFromStore = async () => 0;
    return target;
  }
});

async function whenPeerJobDone(agent: SyncOnConnectTestAgent): Promise<void> {
  const scheduler = agent.getSyncOnConnectPeerScheduler();
  const startedAt = Date.now();
  while (scheduler.has(REMOTE_PEER) || agent.peerSyncSession.isSyncing(REMOTE_PEER)) {
    if (Date.now() - startedAt > 30_000) throw new Error('peer job did not finish');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Serve the target's shared-memory page requests from the source's store. */
function installSharedMemoryPageTransport(
  target: SyncOnConnectTestAgent,
  source: DKGAgent,
  sourceSnapshots: FileWorkspacePublicSnapshotStore,
  fetchedGraphs: string[],
): void {
  const fetchSyncPages: FetchSyncPages = async (
    _ctx,
    _remotePeerId,
    contextGraphId,
    _includeSharedMemory,
    phase,
    graphUri,
    _deadline,
    { snapshotRef } = {},
  ) => {
    fetchedGraphs.push(contextGraphId);
    const quads = phase === 'snapshot'
      ? (snapshotRef === undefined ? [] : (await sourceSnapshots.getSnapshot(snapshotRef)) ?? [])
      : await selectGraphQuads(source, graphUri || (
        phase === 'meta'
          ? contextGraphWorkspaceMetaGraphUri(contextGraphId)
          : contextGraphWorkspaceGraphUri(contextGraphId)
      ));
    return {
      quads,
      bytesReceived: phase === 'snapshot'
        ? Buffer.byteLength(serializeWorkspacePublicSnapshotQuads(quads), 'utf8')
        : Buffer.byteLength(JSON.stringify(quads), 'utf8'),
      resumedFromOffset: 0,
      nextOffset: quads.length,
      checkpointKey: `catchup:${contextGraphId}:${phase}`,
      completed: true,
      timedOut: false,
    };
  };
  (target as unknown as CatchupTestSeams).fetchSyncPages = fetchSyncPages;
}

async function selectGraphQuads(agent: DKGAgent, graph: string): Promise<Quad[]> {
  const result = await agent.store.query(
    `SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } } ORDER BY ?s ?p ?o`,
  );
  if (result.type !== 'bindings') return [];
  return result.bindings.map((row) => ({
    subject: row['s'],
    predicate: row['p'],
    object: row['o'],
    graph,
  }));
}

async function workspaceNames(agent: SyncOnConnectTestAgent, contextGraphId: string): Promise<string[]> {
  const result = await agent.store.query(
    `SELECT ?name WHERE { GRAPH <${contextGraphWorkspaceGraphUri(contextGraphId)}> { ?s <http://schema.org/name> ?name } }`,
  );
  if (result.type !== 'bindings') return [];
  return result.bindings.map((row) => row['name']).sort();
}
