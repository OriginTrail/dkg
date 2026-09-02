// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { contextGraphDataUri } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { resolveRfc64CatalogExecutionPlanV1 } from
  '../src/rfc64/public-catalog-activation-config-v1.js';
import { encodeRootlessWorkspaceRequest } from
  '../../publisher/test/_helpers/rootless-workspace.js';

const CONTEXT_GRAPH = 'rfc64-live-share-authority-wiring';
const HASH_SHAPED_CONTEXT_GRAPH = `0x${'ab'.repeat(32)}`;
const PEER = '12D3KooWRfc64LiveSharePeer';

describe('agent wires RFC-64 authority into legacy live SHARE materialization', () => {
  let agent: DKGAgent | undefined;

  afterAll(async () => {
    try { await agent?.stop(); } catch { /* not started */ }
  });

  it('declines the first wire-form live SHARE before reverse discovery is populated', async () => {
    agent = await DKGAgent.create({
      name: 'Rfc64LiveShareAuthorityWiring',
      chainAdapter: new MockChainAdapter(),
    });
    const internals = agent as unknown as {
      config: DKGAgent['config'];
      wireIdToLocalCgId: Map<string, string>;
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
      await expect(internals.store.hasGraph(contextGraphDataUri(wireContextGraph)))
        .resolves.toBe(false);
    }
  });
});
