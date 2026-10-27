import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent } from '@origintrail-official/dkg-agent';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { Wallet } from 'ethers';
import { createTripleStore } from '@origintrail-official/dkg-storage';
import { OperationTracker } from '@origintrail-official/dkg-node-ui';
import { handleKnowledgeAssetsRoutes } from '../src/daemon/routes/knowledge-assets.js';
import { handleContextGraphRoutes } from '../src/daemon/routes/context-graph.js';
import { handleQueryRoutes } from '../src/daemon/routes/query.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { startManagedOxigraph } from '../src/daemon/oxigraph-managed.js';
import { OXIGRAPH_VERSION } from '../src/daemon/oxigraph-binary.js';
import { freePort } from './fixtures/oxigraph-server-real-fixture.js';
import { requestAuthentication } from './_helpers/request-authentication.js';
import { makeTestKaNumberAllocator } from '../../agent/test/_helpers/ka-allocator.js';
import { ensureOkfCliBuilt, makeBundle, makeOkfCliHome, parseJsonTail, runCli } from './okf-test-helpers.js';
import {
  conceptIdToKaName, exportBundle, importBundle, loadBundleDir, parseDocument, quadsToNQuads,
  DKG_HAS_SECTION, GENID_TAGS, OKF_BODY_PART, OKF_BODY_PART_COUNT, type Quad,
} from '@origintrail-official/dkg-okf';
import { ApiClient } from '../src/api-client.js';

// Compiled CLI -> actual daemon routes -> actual agent lifecycle and Oxigraph.
// The chain is local/mock: this WM/SWM roundtrip needs no on-chain publication.
// Set DKG_TEST_OXIGRAPH_BINARY to exercise the same assertions on the checksum-
// verified native managed server; the default uses the persistent worker store.
/**
 * An OKF v0.2 bundle that stresses what storage could break: three entries in
 * every list family (order), a source naming another concept (lineage), a
 * scope-descriptor source, extension keys with a space and non-ASCII
 * characters, unquoted dates outside a date field (a family extension and a
 * producer key, which only YAML can type), and a nested producer object whose
 * strings carry a double quote, a backslash, a newline, non-ASCII text and an
 * astral character.
 * Values are already canonical (Z offsets, integers) so store canonicalisation
 * cannot legitimately change them.
 */
const V02_FILES: Record<string, string> = {
  'index.md': '---\nokf_version: "0.2"\n---\n\n# Root\n',
  'v02rt/metric.md': [
    '---',
    'type: Metric',
    'title: Revenue',
    'generated: { by: reference_agent/gemini-2.5-pro, at: 2026-06-30T14:00:00Z, "run note": nightly }',
    'verified:',
    '  - { by: human:jsmith@acme, at: 2026-07-01T09:00:00Z }',
    '  - { by: process:finance-nightly, at: 2026-07-02T02:00:00Z }',
    '  - { by: reference_agent/gemini-2.5-pro, at: 2026-07-03T02:00:00Z, note: re-run }',
    'status: draft',
    'stale_after: 2026-12-31T00:00:00Z',
    'released: 2026-06-15',
    'sources:',
    '  - { id: policy, resource: /v02rt/policy.md, title: Revenue policy, author: human:jsmith@acme }',
    '  - id: dashboard',
    '    resource: https://example.org/dash',
    '    author: team:finance',
    '    usage_count: 5000',
    '    last_modified: 2026-06-18T00:00:00Z',
    '    usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z, population: production }',
    '  - { resource: all queries in project acme }',
    'usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z, "sample rate": 1, café: oui }',
    'owner:',
    '  team: \'fin "ops"\'',
    '  path: \'C:\\data\\okf\'',
    '  note: "line one\\nline two"',
    '  label: Grüße 日本 🙂',
    '  reviewers: [human:a, human:b]',
    '---',
    '',
    'See the [computation](/v02rt/computation.md).',
    '',
  ].join('\n'),
  'v02rt/computation.md': [
    '---',
    'type: Attested Computation',
    'runtime: bigquery',
    'parameters:',
    '  - { name: year, type: integer, required: true }',
    '  - { name: region, type: string, required: false }',
    '  - { name: segment, type: string, required: false, default: all }',
    'computation: references/sql/revenue.sql',
    'executor: { resource: /v02rt/skill.md, receipt: [job_id, executed_sql, result], timeout_s: 30, last_run: 2026-06-30T14:00:00Z, since: 2026-06-15 }',
    'attester: { resource: references/attesters/sql_equality.py }',
    '---',
    '',
    'body',
    '',
  ].join('\n'),
  'v02rt/policy.md': '---\ntype: Policy\ntitle: Revenue policy\n---\n\nbody\n',
  'v02rt/skill.md': '---\ntype: Skill\ntitle: Run on BigQuery\n---\n\nbody\n',
};

async function writeBundle(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
}

async function readTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of (await readdir(dir, { recursive: true } as { recursive: true })) as string[]) {
    const path = String(entry).split('\\').join('/');
    if (path.endsWith('.md')) out[path] = await readFile(join(dir, path), 'utf-8');
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Everything but the presentational section structure. */
function semantic(quads: Array<{ subject: string; predicate: string; object: string }>): string {
  return quadsToNQuads(quads.filter((q) => !q.subject.includes(GENID_TAGS.section) && q.predicate !== DKG_HAS_SECTION));
}

describe.sequential('OKF subgraph lifecycle roundtrip', { timeout: 120_000 }, () => {
  let agent: DKGAgent;
  let server: Server;
  let home: string;
  let bundle: string;
  let root: string;
  let managed: Awaited<ReturnType<typeof startManagedOxigraph>>;
  let env: { DKG_HOME: string; DKG_API_PORT: string };
  const cg = 'okf-subgraph-roundtrip';
  const sub = 'science';

  beforeAll(async () => {
    await ensureOkfCliBuilt();
    root = await mkdtemp(join(tmpdir(), 'okf-scoped-roundtrip-'));
    if (process.env.DKG_TEST_OXIGRAPH_BINARY) {
      const cacheDir = join(root, 'native-cache');
      await mkdir(cacheDir);
      await copyFile(process.env.DKG_TEST_OXIGRAPH_BINARY,
        join(cacheDir, `oxigraph-v${OXIGRAPH_VERSION}${process.platform === 'win32' ? '.exe' : ''}`));
      managed = await startManagedOxigraph({
        config: { store: { backend: 'oxigraph-server', options: {
          port: await freePort(), cacheDir, location: join(root, 'native-data'),
        } } }, dataDir: root, log: () => {},
      });
      if (!managed) throw new Error('native managed store did not start');
    }
    const wallet = Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    chain.setMockACKSigner(wallet);
    agent = await DKGAgent.create({
      name: 'OKFScopedRoundtrip', dataDir: join(root, 'agent'), listenHost: '127.0.0.1',
      nodeRole: 'edge', chainAdapter: chain,
      kaNumberAllocator: makeTestKaNumberAllocator(),
      rfc64CatalogActivation: { enabled: false },
      ...(managed ? { store: await createTripleStore(managed.storeConfig) } : {}),
    });
    await agent.start();
    await agent.createContextGraph({ id: cg, name: cg });
    await agent.createSubGraph(cg, sub);
    const tracker = new OperationTracker(null);
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const ctx = {
        req, res, url, path: url.pathname, agent, tracker,
        requestAgentAddress: agent.getDefaultAgentAddress(),
        authentication: requestAuthentication({ kind: 'nodeOperator' }),
        extractionStatus: new Map(), assertionImportLocks: new Map(),
        emitMemoryGraphChanged: () => {}, publisherControl: {},
      } as unknown as RequestContext;
      try {
        await handleContextGraphRoutes(ctx);
        if (!res.writableEnded) await handleKnowledgeAssetsRoutes(ctx);
        if (!res.writableEnded) await handleQueryRoutes(ctx);
        if (!res.writableEnded) { res.writeHead(404); res.end('{}'); }
      } catch (error) {
        res.writeHead(500); res.end(JSON.stringify({ error: String(error) }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind');
    home = await makeOkfCliHome(address.port);
    env = { DKG_HOME: home, DKG_API_PORT: String(address.port) };
    bundle = await makeBundle();
  }, 120_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await agent?.stop();
    await managed?.handle.stop();
    for (const dir of [home, bundle, root]) if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('imports/shares/exports/verifies one subgraph without sibling/root data masking a shortfall', async () => {
    const imported = await runCli(['okf', 'import', bundle, '--context-graph-id', cg,
      '--sub-graph-name', sub, '--share', '--manifest', join(root, 'manifest.json')], env);
    expect(imported.exitCode, imported.stderr).toBe(0);
    expect(parseJsonTail(imported.stdout)).toMatchObject({ assetsShared: 2, memoryLayer: 'SWM' });
    const verify = (dir: string, scope?: string) => runCli(['okf', 'verify', dir,
      '--context-graph-id', cg, '--list-missing', '20', ...(scope ? ['--sub-graph-name', scope] : [])], env);
    const verified = await verify(bundle, sub);
    expect(verified.exitCode, verified.stderr).toBe(0);
    expect(parseJsonTail(verified.stdout)).toMatchObject({ complete: true, totalMissingTriples: 0, missingConcepts: [] });

    const output = join(root, 'export');
    const exported = await runCli(['okf', 'export', cg, output, '--sub-graph-name', sub], env);
    expect(exported.exitCode, exported.stderr).toBe(0);
    expect(parseJsonTail(exported.stdout).concepts).toBe(2);
    const reverified = await verify(output, sub);
    expect(reverified.exitCode, reverified.stderr).toBe(0);
    expect(parseJsonTail(reverified.stdout).complete).toBe(true);

    const rootMissing = await verify(bundle);
    expect(rootMissing.exitCode).not.toBe(0);
    expect(parseJsonTail(rootMissing.stdout)).toMatchObject({ complete: false, missingConcepts: ['urn:okf:a', 'urn:okf:b'] });
    await agent.createSubGraph(cg, 'empty');
    const siblingMissing = await verify(bundle, 'empty');
    expect(siblingMissing.exitCode).not.toBe(0);
    expect(parseJsonTail(siblingMissing.stdout)).toMatchObject({ complete: false, missingConcepts: ['urn:okf:a', 'urn:okf:b'] });
    expect(parseJsonTail(siblingMissing.stdout).totalMissingTriples).toBe(parseJsonTail(imported.stdout).triples);
  });

  it('round-trips an OKF v0.2 bundle through the real store: families, order, nested values', async () => {
    const v02 = 'v02rt';
    await agent.createSubGraph(cg, v02);
    const source = join(root, 'v02-bundle');
    await writeBundle(source, V02_FILES);

    const imported = await runCli(['okf', 'import', source, '--context-graph-id', cg,
      '--sub-graph-name', v02, '--share', '--manifest', join(root, 'v02-manifest.json')], env);
    expect(imported.exitCode, imported.stderr).toBe(0);
    expect(parseJsonTail(imported.stdout)).toMatchObject({ assetsShared: 4, memoryLayer: 'SWM' });

    const verified = await runCli(['okf', 'verify', source, '--context-graph-id', cg, '--sub-graph-name', v02], env);
    expect(verified.exitCode, verified.stdout + verified.stderr).toBe(0);
    expect(parseJsonTail(verified.stdout)).toMatchObject({ complete: true, totalMissingTriples: 0 });

    const output = join(root, 'v02-export');
    const exported = await runCli(['okf', 'export', cg, output, '--sub-graph-name', v02], env);
    expect(exported.exitCode, exported.stderr).toBe(0);
    expect(parseJsonTail(exported.stdout).concepts).toBe(4);

    // The strongest check: the store-backed export is byte-identical to the
    // offline export of the same bundle, so storage and sharing lost nothing.
    const offline = importBundle(loadBundleDir(source));
    const offlineExport = Object.fromEntries(exportBundle(offline).map((f) => [f.path, f.content]));
    const storeExport = await readTree(output);
    expect(Object.keys(storeExport)).toEqual(Object.keys(offlineExport).sort());
    for (const [path, content] of Object.entries(offlineExport)) expect(storeExport[path], path).toBe(content);

    // And the payloads themselves, explicitly.
    const metric = parseDocument('v02rt/metric.md', storeExport['v02rt/metric.md']).frontmatter;
    expect((metric.verified as Array<{ by: string }>).map((v) => v.by)).toEqual([
      'human:jsmith@acme', 'process:finance-nightly', 'reference_agent/gemini-2.5-pro',
    ]);
    expect((metric.sources as Array<Record<string, unknown>>).map((src) => src.resource)).toEqual([
      '/v02rt/policy.md', 'https://example.org/dash', 'all queries in project acme',
    ]);
    expect(metric.owner).toEqual({
      team: 'fin "ops"', path: 'C:\\data\\okf', note: 'line one\nline two', label: 'Grüße 日本 🙂', reviewers: ['human:a', 'human:b'],
    });
    expect(metric.usage_window).toEqual({ from: '2026-06-01T00:00:00Z', to: '2026-06-30T00:00:00Z', 'sample rate': 1, café: 'oui' });
    const computation = parseDocument('v02rt/computation.md', storeExport['v02rt/computation.md']).frontmatter;
    expect(computation.type).toBe('Attested Computation');
    expect((computation.parameters as Array<{ name: string }>).map((param) => param.name)).toEqual(['year', 'region', 'segment']);
    expect(computation.executor).toMatchObject({ resource: '/v02rt/skill.md', receipt: ['executed_sql', 'job_id', 'result'], timeout_s: 30 });
    // Dates outside a date field come back unquoted, so re-import types them again.
    expect(storeExport['v02rt/computation.md']).toContain('last_run: 2026-06-30T14:00:00Z');
    expect(storeExport['v02rt/computation.md']).toContain('since: 2026-06-15');
    expect(storeExport['v02rt/metric.md']).toContain('released: 2026-06-15');

    // Re-importing the store export reproduces the original graph.
    expect(semantic(importBundle(loadBundleDir(output)).quads)).toBe(semantic(offline.quads));
  });

  it('stores each body verbatim through the real store, a long one in parts the write route accepts', async () => {
    const bodies = 'bodyrt';
    await agent.createSubGraph(cg, bodies);
    const source = join(root, 'body-bundle');
    // Over the node's 60,000-byte literal limit, dense with what costs extra
    // bytes: escapes, control characters, non-ASCII and astral characters.
    const unit = 'ab😀 "q" \\ \t\u0001 é漢\n';
    const long = Array.from({ length: 4000 }, (_, i) => `${i} ${unit}`).join('');
    const files: Record<string, string> = {
      'index.md': '---\nokf_version: "0.2"\n---\n\n# Root\n',
      'bodyrt/long.md': `---\ntype: Note\n---\n\n# Notes\n\nSee [short](/bodyrt/short.md).\n\n${long}\n# Citations\n\n[1] [spec](https://example.org/spec)\n`,
      'bodyrt/short.md': '---\ntype: Note\n---\nNo blank line before me, trailing spaces after me   \n\n\n',
    };
    await writeBundle(source, files);
    expect(importBundle(loadBundleDir(source)).quads.filter((q) => q.predicate === OKF_BODY_PART).length).toBeGreaterThan(3);

    const imported = await runCli(['okf', 'import', source, '--context-graph-id', cg,
      '--sub-graph-name', bodies, '--share', '--manifest', join(root, 'body-manifest.json')], env);
    expect(imported.exitCode, imported.stderr).toBe(0);
    expect(parseJsonTail(imported.stdout)).toMatchObject({ assetsShared: 2, memoryLayer: 'SWM' });
    const verified = await runCli(['okf', 'verify', source, '--context-graph-id', cg, '--sub-graph-name', bodies], env);
    expect(verified.exitCode, verified.stdout + verified.stderr).toBe(0);

    const output = join(root, 'body-export');
    const exported = await runCli(['okf', 'export', cg, output, '--sub-graph-name', bodies], env);
    expect(exported.exitCode, exported.stderr).toBe(0);
    const storeExport = await readTree(output);
    for (const path of ['bodyrt/long.md', 'bodyrt/short.md']) {
      expect(parseDocument(path, storeExport[path]).body, path).toBe(parseDocument(path, files[path]).body);
    }
  });

  it('stores the bodies of a Working Memory import made before bodies were stored, on import --replace', async () => {
    const upgrade = 'okf-body-upgrade';
    await agent.createContextGraph({ id: upgrade, name: upgrade });
    const source = join(root, 'upgrade-bundle');
    const files: Record<string, string> = {
      'index.md': '---\nokf_version: "0.2"\n---\n\n# Root\n',
      'bodyup/a.md': '---\ntype: Note\n---\n\n# About\n\nProse that links to [b](/bodyup/b.md).\n',
      'bodyup/b.md': '---\ntype: Note\n---\n\nMore prose.\n',
    };
    await writeBundle(source, files);
    // What an earlier release left in Working Memory: the same drafts, without the body triples.
    const earlier = (quads: Quad[]) =>
      quads.filter((q) => !q.subject.includes(GENID_TAGS.body) && !q.object.includes(GENID_TAGS.body) && q.predicate !== OKF_BODY_PART_COUNT);
    const client = new ApiClient(Number(env.DKG_API_PORT), 'stub-token');
    const stages: Record<string, string> = {};
    for (const concept of importBundle(loadBundleDir(source)).concepts) {
      const name = conceptIdToKaName(concept.conceptId);
      await client.createKnowledgeAsset(upgrade, name);
      await client.knowledgeAssetWrite(upgrade, name, earlier(concept.quads).map((q) => ({ ...q, graph: `did:dkg:context-graph:${upgrade}` })));
      stages[concept.conceptId] = 'written';
    }
    const manifest = join(root, 'upgrade-manifest.json');
    await writeFile(manifest, JSON.stringify({ contextGraphId: upgrade, mode: 'per-concept', stages }));
    const reimport = (flag: string) => runCli(['okf', 'import', source, '--context-graph-id', upgrade, '--manifest', manifest, flag], env);

    // --replace writes the drafts again, bodies included; the share that follows
    // advances them as they are, so verify passes only if the bodies were written.
    expect((await reimport('--replace')).exitCode).toBe(0);
    expect((await reimport('--share')).exitCode).toBe(0);
    const verified = await runCli(['okf', 'verify', source, '--context-graph-id', upgrade], env);
    expect(parseJsonTail(verified.stdout)).toMatchObject({ complete: true, totalMissingTriples: 0 });
    const output = join(root, 'upgrade-export');
    expect((await runCli(['okf', 'export', upgrade, output], env)).exitCode).toBe(0);
    const storeExport = await readTree(output);
    for (const path of ['bodyup/a.md', 'bodyup/b.md']) {
      expect(parseDocument(path, storeExport[path]).body, path).toBe(parseDocument(path, files[path]).body);
    }
  });
});
