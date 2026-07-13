import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { registerTestSyncHandler } from './_helpers/sync-responder.js';

describe('sync responder page diagnostics', () => {
  it('logs successful page timing once per phase/session instead of once per page', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'log-volume';
    const graph = `did:dkg:context-graph:${contextGraphId}/context/1`;
    await store.insert([
      { graph, subject: 'urn:log-volume:1', predicate: 'urn:test:value', object: '"one"' },
      { graph, subject: 'urn:log-volume:2', predicate: 'urn:test:value', object: '"two"' },
    ]);

    const debugMessages: string[] = [];
    const handler = registerTestSyncHandler(store, {
      syncPageSize: 1,
      logDebug: (_ctx, message) => debugMessages.push(message),
    });
    const request = {
      contextGraphId,
      includeSharedMemory: false,
      phase: 'data' as const,
      limit: 1,
      syncSessionId: 'log-volume-session',
    };

    await handler.invoke({ ...request, offset: 0 });
    await handler.invoke({ ...request, offset: 1 });

    expect(
      debugMessages.filter((message) =>
        message.startsWith(`Sync responder durable data for "${contextGraphId}"`),
      ),
    ).toHaveLength(1);
  });
});
