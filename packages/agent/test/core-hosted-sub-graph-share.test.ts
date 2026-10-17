// SPDX-License-Identifier: Apache-2.0

/**
 * A Core that hosts a catalog-owned public graph applies a member's share into
 * a named sub-graph and serves it to a pull (`swm/core-hosted-graph.ts`).
 *
 * Members that reach the graph only through Cores (relay-only Edges) send
 * their shares to those Cores. A Core that hosts the graph without subscribing
 * to it declined every one ("legacy SWM apply is not authoritative for
 * subgraph"), so the graph's owner, connected only to Cores, never got a
 * member's share. The root scope stays with the catalog, and every check of
 * the share handler still runs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { contextGraphDataUri, createOperationContext } from '@origintrail-official/dkg-core';
import type { WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import { DEFAULT_SWM_TTL_MS } from '../src/dkg-agent-constants.js';
import { resolveRfc64CatalogExecutionPlanV1 } from '../src/rfc64/public-catalog-activation-config-v1.js';
import { parseAndFilterNQuads, processSharedMemoryBatch } from '../src/sync-verify-worker-impl.js';
import { createSwmRecoveryMutationRuntimeV1 } from '../src/sync/requester/swm-recovery-apply.js';
import {
  SwmTargetExecutorV1,
  type PublicSwmTargetV1,
  type SwmTargetExecutorPortsV1,
} from '../src/sync/requester/swm-target-executor.js';
import { encodeRootlessWorkspaceRequest, rootlessSharedMemoryGraphFromWire } from
  '../../publisher/test/_helpers/rootless-workspace.js';
import { MemoryWorkspaceSnapshotStore } from './_helpers/memory-workspace-snapshot-store.js';
import { registerTestSyncHandler } from './_helpers/sync-responder.js';

const CG = '0x1111111111111111111111111111111111111111/core-hosted-sub-graph';
const SUB = 'reports';
const MEMBER = '12D3KooWMemberSharesThroughACore';
const ANOTHER_PEER = '12D3KooWAnotherPeerReplaysTheShare';

interface Internals {
  config: DKGAgent['config'];
  subscribedContextGraphs: Map<string, Record<string, unknown>>;
  contextGraphNameCommitment(contextGraphId: string): string;
  rfc64LegacySwmApplyAllowedForScope(contextGraphId: string, subGraphName: string | null): boolean;
  getOrCreateSharedMemoryHandler(): {
    handle(data: Uint8Array, from: string): Promise<{ applied: boolean; retryable?: boolean; reason?: string }>;
  };
  store: OxigraphStore;
  publicSnapshotStore: WorkspacePublicSnapshotStore;
}

describe('a Core that hosts a catalog-owned public graph', () => {
  let agent: DKGAgent;
  let internals: Internals;
  let wire: string;
  let shares = 0;

  beforeAll(async () => {
    agent = await DKGAgent.create({
      name: 'CoreHostedSubGraphShare',
      chainAdapter: new MockChainAdapter(),
      // A daemon keeps the public snapshot of each share it applies.
      publicSnapshotStore: new MemoryWorkspaceSnapshotStore(),
    });
    internals = agent as unknown as Internals;
    internals.config.rfc64CatalogExecutionPlan = resolveRfc64CatalogExecutionPlanV1({
      configuredContextGraphs: [CG],
      activation: {
        enabled: true,
        selectedContextGraphs: [CG],
        selectedPublicContextGraphs: [CG],
        rollout: { killSwitch: false, contextGraphModes: { [CG]: 'catalog' } },
      },
    });
    wire = internals.contextGraphNameCommitment(CG);
  });

  beforeEach(() => {
    internals.config.nodeRole = 'core';
    // Recorded when the Core signed a StorageACK for the graph; never subscribed.
    internals.subscribedContextGraphs.set(CG, { subscribed: false, synced: false, syncMode: 'always-on', coreHosted: true });
  });

  afterAll(async () => {
    try { await agent.stop(); } catch { /* not started */ }
  });

  /** A member's share, by the member, into `subGraphName` (the root for undefined). */
  function share(options: { subGraphName?: string; publisherPeerId?: string } = {}) {
    shares += 1;
    return encodeRootlessWorkspaceRequest({
      contextGraphId: wire,
      ...(options.subGraphName === undefined ? {} : { subGraphName: options.subGraphName }),
      nquads: new TextEncoder().encode(
        `<urn:test:core-hosted:report:${shares}> <http://schema.org/name> "Report ${shares}" `
          + `<${contextGraphDataUri(wire)}> .`,
      ),
      publisherPeerId: options.publisherPeerId ?? MEMBER,
      shareOperationId: `core-hosted-sub-graph-${shares}`,
      timestampMs: Date.now(),
    });
  }

  async function rows(store: OxigraphStore, graph: string): Promise<string[]> {
    const result = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
    const bindings = result.type === 'bindings' ? result.bindings : [];
    return bindings.map((row) => `${row['s']} ${row['p']} ${row['o']}`).sort();
  }

  async function holds(bytes: Uint8Array): Promise<boolean> {
    return internals.store.hasGraph(rootlessSharedMemoryGraphFromWire(bytes));
  }

  it('applies a member\'s share into a named sub-graph although it does not subscribe to the graph', async () => {
    const bytes = share({ subGraphName: SUB });

    await expect(internals.getOrCreateSharedMemoryHandler().handle(bytes, MEMBER)).resolves.toMatchObject({ applied: true });
    expect(await holds(bytes)).toBe(true);
  });

  it('declines a share into the root, which the catalog owns', async () => {
    const bytes = share();

    await expect(internals.getOrCreateSharedMemoryHandler().handle(bytes, MEMBER)).resolves.toMatchObject({
      applied: false,
      retryable: false,
      reason: expect.stringContaining('legacy SWM apply is not authoritative for root scope'),
    });
    expect(await holds(bytes)).toBe(false);
  });

  it('still rejects a sub-graph share that fails the share handler\'s checks', async () => {
    const replayed = share({ subGraphName: SUB });
    const badName = share({ subGraphName: 'Not a sub-graph name!' });
    const handler = internals.getOrCreateSharedMemoryHandler();

    // Sent by a peer that is not its publisher.
    await expect(handler.handle(replayed, ANOTHER_PEER)).resolves.toMatchObject({
      applied: false,
      reason: expect.stringContaining('does not match sender'),
    });
    await expect(handler.handle(badName, MEMBER)).resolves.toMatchObject({
      applied: false,
      reason: expect.stringContaining('invalid subGraphName'),
    });
    expect(await holds(replayed)).toBe(false);
  });

  it('declines a sub-graph share where it neither hosts nor subscribes, and on an Edge', async () => {
    internals.subscribedContextGraphs.set(CG, { subscribed: false, synced: false, syncMode: 'always-on' });
    const notHosted = share({ subGraphName: SUB });
    await expect(internals.getOrCreateSharedMemoryHandler().handle(notHosted, MEMBER)).resolves.toMatchObject({
      applied: false,
      reason: expect.stringContaining(`legacy SWM apply is not authoritative for subgraph "${SUB}"`),
    });

    internals.subscribedContextGraphs.set(CG, { subscribed: false, synced: false, syncMode: 'always-on', coreHosted: true });
    internals.config.nodeRole = 'edge';
    const onEdge = share({ subGraphName: SUB });
    await expect(internals.getOrCreateSharedMemoryHandler().handle(onEdge, MEMBER)).resolves.toMatchObject({
      applied: false,
      reason: expect.stringContaining(`legacy SWM apply is not authoritative for subgraph "${SUB}"`),
    });
    expect(internals.rfc64LegacySwmApplyAllowedForScope(wire, SUB)).toBe(false);
    expect(await holds(notHosted)).toBe(false);
    expect(await holds(onEdge)).toBe(false);
  });

  it('serves the applied share to a pull: an owner connected only to the Core holds it', async () => {
    const bytes = share({ subGraphName: SUB });
    await expect(internals.getOrCreateSharedMemoryHandler().handle(bytes, MEMBER)).resolves.toMatchObject({ applied: true });
    // The Core serves the share as any member does: its metadata, and its
    // content as the snapshot the share handler kept.
    const core = registerTestSyncHandler(internals.store, {
      sharedMemoryTtlMs: DEFAULT_SWM_TTL_MS,
      publicSnapshotStore: internals.publicSnapshotStore,
    });

    // The owner pulls the graph's named sub-graphs from the Core, as on the
    // Core's change notice or its own periodic pull.
    const owner = new OxigraphStore();
    try {
      const ports: SwmTargetExecutorPortsV1 = {
        store: owner,
        writeLocks: new Map(),
        listSubGraphs: async () => [{ name: SUB }],
        createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
        fetchSyncPages: async (_ctx, _peer, contextGraphId, includeSharedMemory, phase, graphUri, _deadline, fetch) => {
          const text = await core.invoke({
            contextGraphId,
            offset: 0,
            limit: 5_000,
            includeSharedMemory,
            phase,
            ...(fetch?.snapshotRef === undefined ? {} : { snapshotRef: fetch.snapshotRef }),
          });
          const quads = parseAndFilterNQuads(text, graphUri, contextGraphId).quads;
          return {
            quads,
            bytesReceived: text.length,
            resumedFromOffset: 0,
            nextOffset: quads.length,
            checkpointKey: `${phase}:${fetch?.snapshotRef ?? ''}`,
            completed: true,
            timedOut: false,
          };
        },
        processSharedMemoryBatch: async (...args) => processSharedMemoryBatch(...args),
        publicSnapshotStore: new MemoryWorkspaceSnapshotStore(),
        recordDrops: () => undefined,
        invalidateListContextGraphsCache: () => undefined,
        recoveryMutation: createSwmRecoveryMutationRuntimeV1({
          store: owner,
          recordDrops: () => undefined,
          invalidateListContextGraphsCache: () => undefined,
        }),
        setCheckpoint: () => undefined,
        deleteCheckpoint: () => undefined,
        deletePublicCheckpoint: () => undefined,
        ensureOwnedMap: () => new Map(),
        retireFinalizedSwmTwin: async () => undefined,
        logInfo: () => undefined,
        logWarn: () => undefined,
        logDebug: () => undefined,
      };
      const summary = await new SwmTargetExecutorV1(ports).syncPublicTarget({
        ctx: createOperationContext('sync'),
        remotePeerId: '12D3KooWTheCoreTheOwnerIsConnectedTo',
        contextGraphId: wire,
        remainingContextGraphs: 1,
        includeRootScope: false,
        mode: { kind: 'ordinary' },
      } as PublicSwmTargetV1);

      expect(summary.failedPhases).toBe(0);
      const graph = rootlessSharedMemoryGraphFromWire(bytes);
      expect(await rows(owner, graph)).toEqual(await rows(internals.store, graph));
      expect(await rows(owner, graph)).toEqual([`urn:test:core-hosted:report:${shares} http://schema.org/name "Report ${shares}"`]);
    } finally {
      await owner.close();
    }
  });
});
