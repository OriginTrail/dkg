// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { contextGraphDataUri } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { resolveRfc64CatalogExecutionPlanV1 } from
  '../src/rfc64/public-catalog-activation-config-v1.js';
import { encodeRootlessWorkspaceRequest, rootlessSharedMemoryGraphFromWire } from
  '../../publisher/test/_helpers/rootless-workspace.js';

const CONTEXT_GRAPH = 'rfc64-live-share-authority-wiring';
const HASH_SHAPED_CONTEXT_GRAPH = `0x${'ab'.repeat(32)}`;
const PEER = '12D3KooWRfc64LiveSharePeer';

describe('agent wires RFC-64 authority into legacy live SHARE materialization', () => {
  let agent: DKGAgent | undefined;

  afterAll(async () => {
    try { await agent?.stop(); } catch { /* not started */ }
  });

  it('declines catalog-root SHAREs before reverse discovery and scopes named SHAREs to members', async () => {
    agent = await DKGAgent.create({
      name: 'Rfc64LiveShareAuthorityWiring',
      chainAdapter: new MockChainAdapter(),
    });
    const internals = agent as unknown as {
      config: DKGAgent['config'];
      wireIdToLocalCgId: Map<string, string>;
      subscribedContextGraphs: Map<string, { subscribed: boolean }>;
      contextGraphNameCommitment(contextGraphId: string): string;
      rfc64LegacySwmGossipAllowedForContextGraph(contextGraphId: string): boolean;
      getOrCreateSharedMemoryHandler(): {
        handle(data: Uint8Array, from: string): Promise<{
          applied: boolean;
          retryable?: boolean;
          reason?: string;
        }>;
      };
      store: { hasGraph(graph: string): Promise<boolean> };
    };
    internals.config.rfc64CatalogExecutionPlan = resolveRfc64CatalogExecutionPlanV1({
      configuredContextGraphs: [CONTEXT_GRAPH, HASH_SHAPED_CONTEXT_GRAPH],
      activation: {
        enabled: true,
        selectedContextGraphs: [CONTEXT_GRAPH, HASH_SHAPED_CONTEXT_GRAPH],
        selectedPublicContextGraphs: [CONTEXT_GRAPH, HASH_SHAPED_CONTEXT_GRAPH],
        rollout: {
          killSwitch: false,
          contextGraphModes: {
            [CONTEXT_GRAPH]: 'catalog',
            [HASH_SHAPED_CONTEXT_GRAPH]: 'catalog',
          },
        },
      },
    });
    const authority = vi.spyOn(internals, 'rfc64LegacySwmGossipAllowedForContextGraph');
    const handler = internals.getOrCreateSharedMemoryHandler();
    for (const [index, selectedContextGraphId] of [
      CONTEXT_GRAPH,
      HASH_SHAPED_CONTEXT_GRAPH,
    ].entries()) {
      const wireContextGraph = internals.contextGraphNameCommitment(selectedContextGraphId);
      expect(internals.wireIdToLocalCgId.has(wireContextGraph)).toBe(false);
      const wire = encodeRootlessWorkspaceRequest({
        contextGraphId: wireContextGraph,
        nquads: new TextEncoder().encode(
          `<urn:test:rfc64-live-share:${index}> <http://schema.org/name> "Catalog owned" `
            + `<${contextGraphDataUri(wireContextGraph)}> .`,
        ),
        publisherPeerId: PEER,
        shareOperationId: `rfc64-live-share-authority-${index}`,
        timestampMs: Date.now(),
      });

      const outcome = await handler.handle(wire, PEER);

      expect(outcome).toMatchObject({
        applied: false,
        retryable: false,
        reason: expect.stringContaining('not authoritative'),
      });
      expect(authority).toHaveBeenCalledWith(wireContextGraph);
      expect(internals.wireIdToLocalCgId.has(wireContextGraph)).toBe(false);
      await expect(internals.store.hasGraph(rootlessSharedMemoryGraphFromWire(wire)))
        .resolves.toBe(false);

    }

    const wireContextGraph = internals.contextGraphNameCommitment(CONTEXT_GRAPH);
    const subgraphWire = encodeRootlessWorkspaceRequest({
      contextGraphId: wireContextGraph,
      subGraphName: 'research',
      nquads: new TextEncoder().encode(
        '<urn:test:rfc64-live-subgraph> <http://schema.org/name> "Legacy subgraph lane" '
          + `<${contextGraphDataUri(wireContextGraph)}> .`,
      ),
      publisherPeerId: PEER,
      shareOperationId: 'rfc64-live-subgraph-authority',
      timestampMs: Date.now(),
    });
    await expect(handler.handle(subgraphWire, PEER)).resolves.toMatchObject({
      applied: false,
      retryable: false,
      reason: expect.stringContaining('not authoritative'),
    });

    internals.subscribedContextGraphs.set(CONTEXT_GRAPH, { subscribed: true });
    await expect(handler.handle(subgraphWire, PEER)).resolves.toMatchObject({
      applied: true,
    });
    await expect(internals.store.hasGraph(rootlessSharedMemoryGraphFromWire(subgraphWire)))
      .resolves.toBe(true);
  });
});
