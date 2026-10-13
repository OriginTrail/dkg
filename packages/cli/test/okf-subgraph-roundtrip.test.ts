import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
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

// Compiled CLI -> actual daemon routes -> actual agent lifecycle and Oxigraph.
// The chain is local/mock: this WM/SWM roundtrip needs no on-chain publication.
// Set DKG_TEST_OXIGRAPH_BINARY to exercise the same assertions on the checksum-
// verified native managed server; the default uses the persistent worker store.
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
});
