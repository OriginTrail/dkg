// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { VectorStore, type EmbeddingRecord, type VectorWorkingMemoryScope } from '../src/vector-store.js';
import { handleMemoryRoutes } from '../src/daemon/routes/memory.js';
import { createRequestActor, type RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const A = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PEER = 'legacy-default-peer';
const CG = 'tenant-cg';
const owned = (address: string): VectorWorkingMemoryScope => ({ kind: 'agents', agentAddresses: [address] });
const stores: Array<{ dir: string; store: VectorStore }> = [];
afterEach(() => {
  for (const { dir, store } of stores.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function createStore(legacy = false) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-vector-tenants-'));
  if (legacy) {
    const db = new Database(join(dir, 'vector-store.db'));
    db.exec(`CREATE TABLE embeddings (
      id TEXT PRIMARY KEY, embedding BLOB NOT NULL, dimensions INTEGER NOT NULL,
      source_uri TEXT NOT NULL, entity_uri TEXT NOT NULL, context_graph_id TEXT NOT NULL,
      memory_layer TEXT NOT NULL CHECK(memory_layer IN ('wm','swm','vm')),
      model TEXT NOT NULL, label TEXT, snippet TEXT, created_at TEXT NOT NULL
    ); PRAGMA user_version = 1;`);
    const embedding = Buffer.alloc(8);
    embedding.writeFloatLE(1, 0);
    for (const layer of ['wm', 'swm', 'vm']) {
      db.prepare('INSERT INTO embeddings VALUES (?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(layer, embedding, `source:${layer}`, `legacy:${layer}`, CG, layer,
          'test', `label:${layer}`, `secret:${layer}`, '2026-01-01');
    }
    db.close();
  }
  const store = new VectorStore(dir);
  stores.push({ dir, store });
  return store;
}

async function insert(store: VectorStore, entityUri: string, memoryLayer: 'wm' | 'swm' | 'vm', agentAddress?: string) {
  const common = { embedding: [1, 0], entityUri,
    sourceUri: `source:${entityUri}`, contextGraphId: CG, model: 'test',
    label: `label:${entityUri}`, snippet: `secret:${entityUri}` };
  await store.insert(memoryLayer === 'wm'
    ? { ...common, memoryLayer, agentAddress: agentAddress ?? { kind: 'unknown' } }
    : { ...common, memoryLayer, agentAddress });
}

function request(store: VectorStore, principal: Parameters<typeof requestAuthentication>[0], path = '/api/memory/search') {
  const req = Object.assign(new EventEmitter(), {
    method: 'POST', headers: {}, aborted: false,
    __dkgPrebufferedBody: Buffer.from(JSON.stringify(path.endsWith('/turn')
      ? { contextGraphId: CG, markdown: '# owned turn', turnId: 'tenant-turn' }
      : { contextGraphId: CG, query: 'secret', memoryLayers: ['wm', 'swm', 'vm'] })),
  });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 0, body: '', destroyed: false, writableEnded: false,
    writeHead(status: number) { this.statusCode = status; },
    setHeader: vi.fn(),
    end(body: string) { this.body = body; this.writableEnded = true; },
  });
  const agent = {
    peerId: PEER, getDefaultAgentAddress: () => A,
    listLocalAgents: () => [A, B].map(agentAddress => ({ agentAddress })),
    resolveContextGraphReadAuthority: vi.fn(async () => ({
      outcome: 'allowed', source: 'registered-chain', reason: 'chain-participant',
    })),
    canUseSharedMemoryForContextGraph: async () => true,
    query: vi.fn(async () => ({ bindings: [] })),
    listContextGraphs: async () => [{ id: CG, subscribed: true, synced: true }],
    contextGraphExists: async () => true,
    assertion: { create: vi.fn(async () => 'wm-graph'), write: vi.fn(async () => undefined) },
  };
  const url = new URL(`http://127.0.0.1${path}`);
  const ctx = { req, res, agent, config: {}, vectorStore: store,
    embeddingProvider: { embed: async () => [1, 0], model: 'test', dimensions: 2 },
    fileStore: { put: async () => ({ keccak256: 'abc123' }) },
    path, url, authentication: requestAuthentication(principal), requestAgentAddress: A,
    emitMemoryGraphChanged: vi.fn(),
  } as unknown as RequestContext;
  return { ctx, res, agent };
}

async function search(store: VectorStore, principal: Parameters<typeof requestAuthentication>[0]) {
  const { ctx, res } = request(store, principal);
  await handleMemoryRoutes(ctx);
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body).results as Array<{ entityUri: string; snippet: string }>;
}

describe('enabled vector memory search tenant isolation', () => {
  it('rejects an untyped new WM record whose owner was omitted', async () => {
    const store = createStore();
    await expect(store.insert({ embedding: [1, 0], sourceUri: 'source:unattributed', entityUri: 'unattributed',
      contextGraphId: CG, memoryLayer: 'wm', model: 'test' } as EmbeddingRecord))
      .rejects.toThrow('Working-memory embedding requires explicit ownership');
    expect(await store.count()).toBe(0);
  });

  it('returns only the caller WM plus shared layers, with EVM case folding', async () => {
    const store = createStore();
    await insert(store, 'alice', 'wm', A);
    await insert(store, 'bob', 'wm', B);
    await insert(store, 'shared', 'swm', B);
    await insert(store, 'verified', 'vm', B);
    const result = await search(store, { kind: 'agent', agentAddress: A.toLowerCase() });
    expect(result.map(row => row.entityUri).sort()).toEqual(['alice', 'shared', 'verified']);
    expect(JSON.stringify(result)).not.toContain('secret:bob');
    expect((await search(store, { kind: 'agent', agentAddress: B })).map(row => row.entityUri).sort())
      .toEqual(['bob', 'shared', 'verified']);
  });

  it('spans the default agent peer alias without sharing it with a co-tenant', async () => {
    const store = createStore();
    await insert(store, 'old-default', 'wm', PEER);
    await insert(store, 'new-default', 'wm', A);
    await insert(store, 'bob', 'wm', B);
    expect((await search(store, { kind: 'agent', agentAddress: A })).map(row => row.entityUri).sort())
      .toEqual(['new-default', 'old-default']);
    expect((await search(store, { kind: 'agent', agentAddress: B })).map(row => row.entityUri))
      .toEqual(['bob']);
  });

  it('keeps explicit operator access while anonymous reads use only the default identity', async () => {
    const store = createStore();
    await insert(store, 'alice', 'wm', A);
    await insert(store, 'bob', 'wm', B);
    await insert(store, 'unknown-owner', 'wm');
    expect((await search(store, { kind: 'nodeOperator' })).map(row => row.entityUri).sort())
      .toEqual(['alice', 'bob', 'unknown-owner']);
    expect((await search(store, { kind: 'anonymous', mode: 'disabled' })).map(row => row.entityUri))
      .toEqual(['alice']);
  });

  it('migrates v1 rows without granting unknown WM ownership to any agent', async () => {
    const store = createStore(true);
    expect(await store.count()).toBe(3);
    expect((await search(store, { kind: 'agent', agentAddress: A })).map(row => row.entityUri).sort())
      .toEqual(['legacy:swm', 'legacy:vm']);
    expect((await search(store, { kind: 'nodeOperator' })).map(row => row.entityUri).sort())
      .toEqual(['legacy:swm', 'legacy:vm', 'legacy:wm']);
    await insert(store, 'new-owned', 'wm', A);
    expect((await search(store, { kind: 'agent', agentAddress: A })).map(row => row.entityUri).sort())
      .toEqual(['legacy:swm', 'legacy:vm', 'new-owned']);
  });

  it('records the authenticated turn writer, ignoring an inconsistent default projection', async () => {
    const store = createStore();
    const { ctx, res, agent } = request(store, { kind: 'agent', agentAddress: B }, '/api/memory/turn');
    await handleMemoryRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).embeddingId).toBeTruthy();
    expect(agent.assertion.create).toHaveBeenCalledWith(CG, expect.any(String), { agentAddress: B });
    const visible = await store.search([1, 0], { contextGraphId: CG, memoryLayers: ['wm'],
      limit: 10, workingMemoryScope: owned(B) });
    expect(visible).toHaveLength(1);
    expect(await store.search([1, 0], { contextGraphId: CG, memoryLayers: ['wm'],
      limit: 10, workingMemoryScope: owned(A) })).toEqual([]);
  });

  it('uses the correlated actor when legacy context fields contradict it', async () => {
    const store = createStore();
    await insert(store, 'alice', 'wm', A);
    await insert(store, 'bob', 'wm', B);
    const { ctx, res, agent } = request(store, { kind: 'nodeOperator' });
    Object.assign(ctx, { actor: createRequestActor(
      requestAuthentication({ kind: 'agent', agentAddress: B }), () => A,
    ) });
    await handleMemoryRoutes(ctx);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).results.map((row: { entityUri: string }) => row.entityUri)).toEqual(['bob']);
    expect(agent.resolveContextGraphReadAuthority).toHaveBeenCalledWith(CG, { callerAgentAddress: B });
  });
});
