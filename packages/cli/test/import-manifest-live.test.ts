/**
 * #3569: the import manifest helper (`scripts/lib/manifest.mjs`) through the real Knowledge Asset routes. The daemon
 * refuses a share that selects root entities (`400 KA_ATOMIC_SHARE_REQUIRED`), seals what it shares, and keeps each
 * shared asset in a graph of its own, so this runs the helper's whole flow against a real daemon (mock chain, no
 * Hardhat): a manifest over two pages, status changes after the first share, a read back and a resume.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startLiveDaemon, stopLiveDaemon, postJson, type LiveDaemon } from './helpers/live-daemon.js';
import { DkgClient } from '../../../scripts/lib/dkg-daemon.mjs';
import {
  createImportManifest,
  loadImportManifest,
  markPartitionStatus,
  markPartitionStatuses,
} from '../../../scripts/lib/manifest.mjs';

const CG = `import-manifest-${Date.now().toString(36)}`;
const SUB_GRAPH = 'meta';
const silent = { log: () => {}, warn: () => {}, error: () => {} };
let daemon: LiveDaemon;
let client: DkgClient;

beforeAll(async () => {
  daemon = await startLiveDaemon({ extraConfig: { chain: { type: 'mock' } } });
  const registered = await postJson(daemon, '/api/agent/register', { name: CG, framework: 'test' });
  expect(registered.status, JSON.stringify(registered.body)).toBeLessThan(300);
  daemon.token = String(registered.body.authToken);
  const cg = await postJson(daemon, '/api/context-graph/create', { id: CG, name: CG });
  expect(cg.status, JSON.stringify(cg.body)).toBeLessThan(300);
  const sub = await postJson(daemon, '/api/sub-graph/create', { contextGraphId: CG, subGraphName: SUB_GRAPH });
  expect(sub.status, JSON.stringify(sub.body)).toBeLessThan(300);
  client = new DkgClient({ apiBase: daemon.base, token: daemon.token, logger: silent });
  client.cgId = CG;
}, 120_000);

afterAll(async () => {
  await stopLiveDaemon(daemon);
});

it('creates, updates, reads back and resumes a manifest through the real routes', async () => {
  const importId = `${CG}-run`;
  const partitions = ['src/c.ts', 'src/a.ts', 'src/b.ts'];
  const manifest = { client, importId, subGraphName: SUB_GRAPH };

  const created = await createImportManifest({ ...manifest, partitions, maxPartitionsPerPage: 2 });
  expect(created.pageAssertionNames).toHaveLength(2);
  expect((await loadImportManifest(manifest)).partitions.map((p) => [p.key, p.status]))
    .toEqual([['src/a.ts', 'pending'], ['src/b.ts', 'pending'], ['src/c.ts', 'pending']]);

  // Each status change is an asset of its own, so a second change of one partition works after the first is shared.
  await markPartitionStatus({ ...manifest, partitionKey: 'src/a.ts', status: 'in_progress' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await markPartitionStatus({ ...manifest, partitionKey: 'src/a.ts', status: 'done' });
  await markPartitionStatuses({ ...manifest, statuses: [
    { partitionKey: 'src/b.ts', status: 'in_progress' },
    { partitionKey: 'src/b.ts', status: 'failed' },
  ] });
  const state = await loadImportManifest(manifest);
  expect(state.partitions.map((p) => [p.key, p.status]))
    .toEqual([['src/a.ts', 'done'], ['src/b.ts', 'failed'], ['src/c.ts', 'pending']]);
  expect(state.partitions.find((p) => p.key === 'src/a.ts')?.recordedAt).toBeTruthy();

  // A second run over the same partitions changes nothing; another partition set is refused.
  await expect(createImportManifest({ ...manifest, partitions: [...partitions].reverse(), maxPartitionsPerPage: 2 }))
    .resolves.toMatchObject({ assertionName: created.assertionName, pageAssertionNames: created.pageAssertionNames });
  await expect(createImportManifest({ ...manifest, partitions: [...partitions, 'src/d.ts'] }))
    .rejects.toThrow(/different partition set/);
  expect((await loadImportManifest(manifest)).partitions.map((p) => [p.key, p.status]))
    .toEqual([['src/a.ts', 'done'], ['src/b.ts', 'failed'], ['src/c.ts', 'pending']]);
}, 180_000);

it('the daemon refuses the root-list share the helper used to send', async () => {
  // Guards the premise of the redesign: if the daemon took a root list again, this test would say so.
  const name = `${CG}-root-list`;
  const createdAsset = await postJson(daemon, '/api/knowledge-assets', { contextGraphId: CG, name, subGraphName: SUB_GRAPH });
  expect(createdAsset.status, JSON.stringify(createdAsset.body)).toBe(201);
  await client.writeAssertion({ contextGraphId: CG, assertionName: name, subGraphName: SUB_GRAPH,
    triples: [{ subject: 'urn:test:root', predicate: 'urn:test:p', object: '"x"' }] });
  await expect(client.promote({ contextGraphId: CG, assertionName: name, subGraphName: SUB_GRAPH, entities: ['urn:test:root'] }))
    .rejects.toMatchObject({ status: 400, body: { code: 'KA_ATOMIC_SHARE_REQUIRED' } });
}, 60_000);
