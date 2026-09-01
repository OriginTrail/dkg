// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, it, vi } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { contextGraphDataUri } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { encodeRootlessWorkspaceRequest } from
  '../../publisher/test/_helpers/rootless-workspace.js';

const CONTEXT_GRAPH = 'rfc64-live-share-authority-wiring';
const PEER = '12D3KooWRfc64LiveSharePeer';

describe('agent wires RFC-64 authority into legacy live SHARE materialization', () => {
  let agent: DKGAgent | undefined;

  afterAll(async () => {
    try { await agent?.stop(); } catch { /* not started */ }
  });

  it('declines live legacy SHARE when catalog authority disables legacy sync', async () => {
    agent = await DKGAgent.create({
      name: 'Rfc64LiveShareAuthorityWiring',
      chainAdapter: new MockChainAdapter(),
    });
    const authority = vi.fn(() => ({ legacySyncAllowed: false }));
    const internals = agent as unknown as {
      resolveRfc64CatalogReceiverAuthorityV1:
        (contextGraphId: string) => { legacySyncAllowed: boolean };
      getOrCreateSharedMemoryHandler(): {
        handle(data: Uint8Array, from: string): Promise<{
          applied: boolean;
          retryable?: boolean;
          reason?: string;
        }>;
      };
      store: { hasGraph(graph: string): Promise<boolean> };
    };
    internals.resolveRfc64CatalogReceiverAuthorityV1 = authority;
    const handler = internals.getOrCreateSharedMemoryHandler();
    const wire = encodeRootlessWorkspaceRequest({
      contextGraphId: CONTEXT_GRAPH,
      nquads: new TextEncoder().encode(
        `<urn:test:rfc64-live-share> <http://schema.org/name> "Catalog owned" `
          + `<${contextGraphDataUri(CONTEXT_GRAPH)}> .`,
      ),
      publisherPeerId: PEER,
      shareOperationId: 'rfc64-live-share-authority',
      timestampMs: Date.now(),
    });

    const outcome = await handler.handle(wire, PEER);

    expect(outcome).toMatchObject({
      applied: false,
      retryable: false,
      reason: expect.stringContaining('not authoritative'),
    });
    expect(authority).toHaveBeenCalledWith(CONTEXT_GRAPH);
  });
});
