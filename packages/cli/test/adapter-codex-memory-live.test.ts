/**
 * Codex private memory compatibility — real DKG 10.0.16 daemon, real HTTP
 * routes and real Oxigraph worker. No route or graph-store mocks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DkgMemory } from '../../adapter-codex/src/memory.mjs';
import { getJson, startLiveDaemon, stopLiveDaemon, type LiveDaemon } from './helpers/live-daemon.js';

describe('Codex private graph memory against the DKG 10.0.16 daemon', () => {
  let daemon: LiveDaemon;
  let stateDir: string;

  beforeAll(async () => {
    daemon = await startLiveDaemon({ authEnabled: true });
    stateDir = await mkdtemp(join(tmpdir(), 'dkg-codex-memory-live-'));
  }, 90_000);

  afterAll(async () => {
    await stopLiveDaemon(daemon);
    await rm(stateDir, { recursive: true, force: true });
  });

  it('creates an unregistered private graph and preserves WM writes, restart recovery, retry and recall without publishing', async () => {
    const memory = new DkgMemory({ stateDir, dkgHome: daemon.home, dkgPort: daemon.apiPort });
    const user = await memory.capture({
      threadId: 'live-thread', turnId: 'live-turn', messageId: 'user-1', role: 'user', surface: 'dkg',
      text: 'The heliotrope synchronization marker belongs to the private migration plan.',
    });
    const assistant = await memory.capture({
      threadId: 'live-thread', turnId: 'live-turn', messageId: 'assistant-1', role: 'assistant', surface: 'dkg',
      text: 'I will preserve the heliotrope marker in local working memory only.',
    });
    expect(user.status).toBe('stored');
    expect(assistant.status).toBe('stored');

    const listed = await getJson(daemon, '/api/context-graph/list');
    expect(listed.status).toBe(200);
    const graph = listed.body.contextGraphs.find((candidate: any) =>
      candidate.id === memory.settings.contextGraphId || candidate.id.endsWith(`/${memory.settings.contextGraphId}`));
    expect(graph).toBeDefined();
    expect(graph.accessPolicy).toBe('private');
    expect(graph.onChainId ?? graph.onChainContextGraphId).toBeUndefined();

    const direct = await memory.query(
      `SELECT ?text WHERE { <${user.entityUri}> <http://schema.org/text> ?text }`,
      memory.settings.contextGraphId,
      'WM',
    );
    expect(direct.some((row: any) => String(row.text?.value ?? row.text).includes('heliotrope synchronization'))).toBe(true);
    for (const layer of ['SWM', 'VM']) {
      const published = await memory.query(
        `SELECT ?p WHERE { <${user.entityUri}> ?p ?o }`,
        memory.settings.contextGraphId,
        layer,
      );
      expect(published, `${layer} must remain empty`).toEqual([]);
    }

    // Reconstructing the adapter from disk must retain the durable receipts.
    const restarted = new DkgMemory({ stateDir, dkgHome: daemon.home, dkgPort: daemon.apiPort });
    expect(restarted.snapshot('live-thread').records.map((record: any) => record.status)).toEqual(['stored', 'stored']);
    const recall = await restarted.recall('Where is the heliotrope synchronization marker?', 'dkg');
    expect(['ok', 'partial']).toContain(recall.status);
    expect(recall.hits.some((hit: any) => hit.entityUri === user.entityUri)).toBe(true);

    // Force one real-route WM write to fail, then prove the on-disk outbox is
    // picked up by another adapter instance and stored successfully.
    let failedWrite = false;
    const flaky = new DkgMemory({ stateDir, dkgHome: daemon.home, dkgPort: daemon.apiPort,
      fetcher: async (url: string | URL | Request, options?: RequestInit) => {
        if (!failedWrite && String(url).includes('/wm/write')) {
          failedWrite = true;
          return new Response('{"error":"injected transport failure"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
        }
        return fetch(url, options);
      },
    });
    const pending = await flaky.capture({
      threadId: 'live-thread', turnId: 'retry-turn', messageId: 'user-retry', role: 'user', surface: 'dkg',
      text: 'The durable celadon retry marker must survive an adapter restart.',
    });
    expect(failedWrite).toBe(true);
    expect(pending.status).toBe('pending');

    const retrying = new DkgMemory({ stateDir, dkgHome: daemon.home, dkgPort: daemon.apiPort });
    await retrying.retry();
    const retried = retrying.snapshot('live-thread').records.find((record: any) => record.id === pending.id);
    expect(retried?.status).toBe('stored');
    const retryRecall = await retrying.recall('Find the durable celadon retry marker', 'dkg');
    expect(retryRecall.hits.some((hit: any) => hit.entityUri === retried?.entityUri)).toBe(true);
  }, 120_000);
});
