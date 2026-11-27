import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import type { WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import {
  DKG_NS,
  registerTestSyncHandler,
  workspaceOpQuads,
} from './_helpers/sync-responder.js';

describe('sync responder page diagnostics', () => {
  it('logs every successful responder phase once per session instead of once per page', async () => {
    const store = new OxigraphStore();
    const contextGraphId = 'log-volume';
    const prefix = `did:dkg:context-graph:${contextGraphId}`;
    const durableData = `${prefix}/context/1`;
    const durableMeta = `${prefix}/_meta`;
    const swmData = `${prefix}/_shared_memory`;
    const swmMeta = `${prefix}/_shared_memory_meta`;
    const catalog = `${prefix}/_catalog`;
    await store.insert([
      { graph: catalog, subject: prefix, predicate: 'urn:catalog:value', object: '"one"' },
      { graph: catalog, subject: prefix, predicate: 'urn:catalog:label', object: '"two"' },
      { graph: durableData, subject: 'urn:durable:1', predicate: 'urn:test:value', object: '"one"' },
      { graph: durableData, subject: 'urn:durable:2', predicate: 'urn:test:value', object: '"two"' },
      { graph: durableMeta, subject: prefix, predicate: `${DKG_NS}createdAt`, object: '"2026-07-01T00:00:00Z"' },
      { graph: durableMeta, subject: prefix, predicate: `${DKG_NS}updatedAt`, object: '"2026-07-02T00:00:00Z"' },
      { graph: swmData, subject: 'urn:swm:1', predicate: 'urn:test:value', object: '"one"' },
      { graph: swmData, subject: 'urn:swm:2', predicate: 'urn:test:value', object: '"two"' },
      ...workspaceOpQuads(
        contextGraphId,
        'share-1',
        'urn:swm:1',
        swmMeta,
        '2026-07-01T00:00:00.000Z',
      ),
    ]);

    const snapshotQuads = [
      { graph: '', subject: 'urn:snapshot:1', predicate: 'urn:test:value', object: '"one"' },
      { graph: '', subject: 'urn:snapshot:2', predicate: 'urn:test:value', object: '"two"' },
    ];
    const publicSnapshotStore: WorkspacePublicSnapshotStore = {
      putSnapshot: async () => ({ ref: 'snapshot-ref', byteLength: 0 }),
      getSnapshot: async () => {
        throw new Error('paged responder must not materialize the complete snapshot');
      },
      getSnapshotPage: async (_ref, offset, limit) => snapshotQuads.slice(offset, offset + limit),
    };
    const debugMessages: string[] = [];
    const handler = registerTestSyncHandler(store, {
      syncPageSize: 1,
      logDebug: (_ctx, message) => debugMessages.push(message),
      publicSnapshotStore,
    });

    const cases = [
      {
        name: 'catalog',
        prefix: `Sync responder catalog facet for "${contextGraphId}"`,
        request: { includeSharedMemory: false, phase: 'catalog' as const },
      },
      {
        name: 'durable data',
        prefix: `Sync responder durable data for "${contextGraphId}"`,
        request: { includeSharedMemory: false, phase: 'data' as const },
      },
      {
        name: 'durable meta',
        prefix: `Sync responder durable meta for "${contextGraphId}"`,
        request: { includeSharedMemory: false, phase: 'meta' as const },
      },
      {
        name: 'SWM snapshot',
        prefix: `Sync responder SWM snapshot for "${contextGraphId}"`,
        request: {
          includeSharedMemory: true,
          phase: 'snapshot' as const,
          snapshotRef: 'snapshot-ref',
        },
      },
      {
        name: 'SWM meta',
        prefix: `Sync responder SWM meta for "${contextGraphId}"`,
        request: { includeSharedMemory: true, phase: 'meta' as const },
      },
      {
        name: 'SWM data',
        prefix: `Sync responder SWM data for "${contextGraphId}"`,
        request: { includeSharedMemory: true, phase: 'data' as const },
      },
    ];

    for (const testCase of cases) {
      const request = {
        contextGraphId,
        limit: 1,
        syncSessionId: `log-volume-${testCase.name}`,
        ...testCase.request,
      };
      const first = await handler.invoke({ ...request, offset: 0 });
      const second = await handler.invoke({ ...request, offset: 1 });

      expect(first, `${testCase.name} first page`).not.toBe('');
      expect(second, `${testCase.name} second page`).not.toBe('');
      expect(
        debugMessages.filter((message) => message.startsWith(testCase.prefix)),
        `${testCase.name} diagnostic count`,
      ).toHaveLength(1);
    }
  });
});
