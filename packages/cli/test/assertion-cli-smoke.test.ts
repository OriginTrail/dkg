import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'dist', 'cli.js');
const MAX_UINT72_DECIMAL = '4722366482869645213695';
const UINT72_OVERFLOW_DECIMAL = '4722366482869645213696';

describe.sequential('assertion CLI smoke', () => {
  let dkgHome: string;
  let server: ReturnType<typeof createServer>;
  let smokeApiPort: string;
  let lastImportBody = '';
  let lastImportContentType = '';
  let lastPublishAsyncBody = '';
  let indexCalls: Array<{ method: string; url: string; body: any }> = [];
  let daemonCalls: Array<{ method: string; url: string }> = [];

  beforeAll(async () => {
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-assertion-cli-'));
    if (!existsSync(CLI_ENTRY)) {
      await execFileAsync('pnpm', ['build'], { cwd: join(__dirname, '..') });
    }
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`CLI entry not found after build: ${CLI_ENTRY}`);
    }
    await writeFile(join(dkgHome, 'sample.pdf'), Buffer.from('%PDF-1.4\nfake-pdf\n', 'utf-8'));

    server = createServer(async (req, res) => {
      daemonCalls.push({ method: req.method ?? '', url: req.url ?? '' });
      if (req.method === 'POST' && req.url === '/api/knowledge-assets/paper/wm/import-file') {
        lastImportContentType = String(req.headers['content-type'] ?? '');
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        lastImportBody = Buffer.concat(chunks).toString('latin1');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          assertionUri: 'did:dkg:context-graph:research/assertion/0xAgent/paper',
          fileHash: 'keccak256:filehash',
          detectedContentType: 'application/pdf',
          extraction: {
            status: 'completed',
            tripleCount: 14,
            pipelineUsed: 'application/pdf',
            mdIntermediateHash: 'keccak256:mdhash',
          },
        }));
        return;
      }

      if (req.method === 'GET' && req.url === '/api/knowledge-assets/paper/wm/extraction-status?contextGraphId=research') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          assertionUri: 'did:dkg:context-graph:research/assertion/0xAgent/paper',
          fileHash: 'keccak256:filehash',
          status: 'completed',
          tripleCount: 14,
          pipelineUsed: 'application/pdf',
          mdIntermediateHash: 'keccak256:mdhash',
        }));
        return;
      }

      if (req.method === 'GET' && req.url === '/api/knowledge-assets/paper/wm/extraction-status?contextGraphId=research&subGraphName=lab') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          assertionUri: 'did:dkg:context-graph:research/sub-graph/lab/assertion/0xAgent/paper',
          fileHash: 'keccak256:filehash-subgraph',
          status: 'completed',
          tripleCount: 9,
          pipelineUsed: 'application/pdf',
          mdIntermediateHash: 'keccak256:mdhash-subgraph',
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/knowledge-assets/paper/swm/share') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          swmShared: true,
          promotedCount: 14,
          contextGraphId: 'research',
          sharedMemoryGraph: 'did:dkg:context-graph:research/shared-memory',
          rootEntities: ['urn:company:acme'],
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/knowledge-assets/paper/vm/publish-async') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        lastPublishAsyncBody = Buffer.concat(chunks).toString('utf-8');
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jobId: 'job-cli-123',
          status: 'accepted',
          contextGraphId: 'research',
          name: 'paper',
          subGraphName: 'lab',
          shareOperationId: 'share-cli-123',
          rootsCount: 1,
          sealMerkleRoot: `0x${'12'.repeat(32)}`,
          intentKey: `sha256:${'ab'.repeat(32)}`,
        }));
        return;
      }

      if (req.method === 'GET' && req.url === '/api/knowledge-assets/paper/wm/quads?contextGraphId=research') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          count: 2,
          quads: [
            {
              subject: 'urn:company:acme',
              predicate: 'http://schema.org/name',
              object: '"Acme Logistics"',
              graph: 'did:dkg:context-graph:research/assertion/paper',
            },
            {
              subject: 'urn:company:acme',
              predicate: 'http://schema.org/industry',
              object: '"Logistics"',
              graph: 'did:dkg:context-graph:research/assertion/paper',
            },
          ],
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/knowledge-assets') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks).toString('utf-8');
        const body = JSON.parse(raw);
        if (typeof body.name === 'string' && body.name.startsWith('index-')) {
          indexCalls.push({ method: req.method, url: req.url, body });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            name: body.name,
            assertionUri: `did:dkg:context-graph:${body.contextGraphId}/assertion/0xAgent/${body.name}`,
            status: 'draft-open',
          }));
          return;
        }
      }

      const indexLifecycle = req.url?.match(/^\/api\/knowledge-assets\/(index-[^/]+)\/(wm\/write|wm\/finalize|swm\/share|vm\/publish)$/);
      if (req.method === 'POST' && indexLifecycle) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks).toString('utf-8');
        const body = raw ? JSON.parse(raw) : {};
        indexCalls.push({ method: req.method, url: req.url, body });
        const [, name, action] = indexLifecycle;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (action === 'wm/write') {
          res.end(JSON.stringify({ written: Array.isArray(body.quads) ? body.quads.length : 0 }));
        } else if (action === 'wm/finalize') {
          res.end(JSON.stringify({
            assertionUri: `did:dkg:context-graph:${body.contextGraphId}/assertion/0xAgent/${name}`,
            merkleRoot: `0x${'34'.repeat(32)}`,
            authorAddress: '0x0000000000000000000000000000000000000001',
            schemeVersion: 1,
            chainId: '31337',
            kav10Address: '0x0000000000000000000000000000000000000002',
            eip712Digest: `0x${'56'.repeat(32)}`,
          }));
        } else if (action === 'swm/share') {
          res.end(JSON.stringify({ swmShared: true, promotedCount: 1, shareOperationId: 'share-index-1' }));
        } else {
          res.end(JSON.stringify({ kaId: '42', status: 'confirmed', kas: [], txHash: '0xindex' }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        smokeApiPort = typeof addr === 'object' && addr ? String(addr.port) : '0';
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dkgHome, { recursive: true, force: true });
  });

  it('imports a PDF file through the CLI multipart wrapper, queries status, inspects assertion quads, and promotes it', async () => {
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: smokeApiPort };

    const imported = await execFileAsync('node', [
      CLI_ENTRY,
      'assertion',
      'import-file',
      'paper',
      '--file',
      join(dkgHome, 'sample.pdf'),
      '--context-graph',
      'research',
    ], { env });

    expect(imported.stdout).toContain('Assertion import complete:');
    expect(imported.stdout).toContain('application/pdf');
    expect(imported.stdout).toContain('keccak256:filehash');
    expect(lastImportContentType).toContain('multipart/form-data; boundary=');
    expect(lastImportBody).toContain('name="contextGraphId"');
    expect(lastImportBody).toContain('research');
    expect(lastImportBody).toContain('filename="sample.pdf"');
    expect(lastImportBody).toContain('Content-Type: application/pdf');

    const status = await execFileAsync('node', [
      CLI_ENTRY,
      'assertion',
      'extraction-status',
      'paper',
      '--context-graph',
      'research',
    ], { env });

    expect(status.stdout).toContain('Extraction status for "paper":');
    expect(status.stdout).toContain('Status:         completed');
    expect(status.stdout).toContain('Pipeline:       application/pdf');

    const subgraphStatus = await execFileAsync('node', [
      CLI_ENTRY,
      'assertion',
      'extraction-status',
      'paper',
      '--context-graph',
      'research',
      '--sub-graph-name',
      'lab',
    ], { env });

    expect(subgraphStatus.stdout).toContain('did:dkg:context-graph:research/sub-graph/lab/assertion/0xAgent/paper');
    expect(subgraphStatus.stdout).toContain('keccak256:filehash-subgraph');

    const queried = await execFileAsync('node', [
      CLI_ENTRY,
      'assertion',
      'query',
      'paper',
      '--context-graph',
      'research',
    ], { env });

    expect(queried.stdout).toContain('<urn:company:acme> <http://schema.org/name> "Acme Logistics"');
    expect(queried.stdout).toContain('<urn:company:acme> <http://schema.org/industry> "Logistics"');
    expect(queried.stdout).toContain('2 quad(s)');

    const promoted = await execFileAsync('node', [
      CLI_ENTRY,
      'assertion',
      'promote',
      'paper',
      '--context-graph',
      'research',
    ], { env });

    expect(promoted.stdout).toContain('Assertion promoted to shared memory:');
    expect(promoted.stdout).toContain('Triples:        14');
    expect(promoted.stdout).toContain('urn:company:acme');
    expect(promoted.stdout).toContain('Next:           dkg ka publish-async paper --context-graph-id research');
    expect(promoted.stdout).toContain('Alias:          dkg publisher publish-async research paper');

    const promotedSubgraph = await execFileAsync('node', [
      CLI_ENTRY,
      'assertion',
      'promote',
      'paper',
      '--context-graph',
      'research',
      '--sub-graph-name',
      'lab',
    ], { env });

    expect(promotedSubgraph.stdout).toContain('Next:           dkg ka publish-async paper --context-graph-id research --sub-graph-name lab');
    expect(promotedSubgraph.stdout).toContain('Alias:          dkg publisher publish-async research paper --sub-graph lab');
  }, 60000);

  it('does not expose retired shared-memory or raw publisher enqueue commands', async () => {
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: smokeApiPort };

    daemonCalls = [];
    await expectUnknownCommand(['shared-memory', 'write', 'research'], env, 'shared-memory');
    expect(daemonCalls).toEqual([]);

    daemonCalls = [];
    await expectUnknownCommand(['publisher', 'enqueue', 'research'], env, 'enqueue');
    expect(daemonCalls).toEqual([]);
  }, 15000);

  it('enqueues a named KA async VM publish through the shared CLI publish options', async () => {
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: smokeApiPort };

    const publishedViaKa = await execFileAsync('node', [
      CLI_ENTRY,
      'ka',
      'publish-async',
      'paper',
      '--context-graph-id',
      'research',
      '--sub-graph-name',
      'lab',
      '--publish-epochs',
      '3',
      '--publisher-node-identity-id',
      '7',
    ], { env });

    expect(publishedViaKa.stdout).toContain('Knowledge asset publish job accepted:');
    expect(publishedViaKa.stdout).toContain('Job ID:     job-cli-123');
    expect(publishedViaKa.stdout).toContain('Status:     accepted');
    expect(JSON.parse(lastPublishAsyncBody)).toEqual({
      contextGraphId: 'research',
      subGraphName: 'lab',
      options: { publishEpochs: 3, publisherNodeIdentityIdOverride: '7' },
    });

    await execFileAsync('node', [
      CLI_ENTRY,
      'ka',
      'publish-async',
      'paper',
      '--context-graph-id',
      'research',
      '--publisher-node-identity-id',
      '0',
    ], { env });

    expect(JSON.parse(lastPublishAsyncBody)).toEqual({
      contextGraphId: 'research',
      options: { publisherNodeIdentityIdOverride: '0' },
    });

    await execFileAsync('node', [
      CLI_ENTRY,
      'ka',
      'publish-async',
      'paper',
      '--context-graph-id',
      'research',
      '--publisher-node-identity-id',
      MAX_UINT72_DECIMAL,
    ], { env });

    expect(JSON.parse(lastPublishAsyncBody)).toEqual({
      contextGraphId: 'research',
      options: { publisherNodeIdentityIdOverride: MAX_UINT72_DECIMAL },
    });

    const publishedViaAlias = await execFileAsync('node', [
      CLI_ENTRY,
      'publisher',
      'publish-async',
      'research',
      'paper',
      '--sub-graph',
      'lab',
      '--publish-epochs',
      '3',
      '--publisher-node-identity-id',
      '7',
    ], { env });

    expect(publishedViaAlias.stdout).toContain('Knowledge asset publish job accepted:');
    expect(publishedViaAlias.stdout).toContain('Job ID:     job-cli-123');
    expect(publishedViaAlias.stdout).toContain('Status:     accepted');
    expect(JSON.parse(lastPublishAsyncBody)).toEqual({
      contextGraphId: 'research',
      subGraphName: 'lab',
      options: { publishEpochs: 3, publisherNodeIdentityIdOverride: '7' },
    });

    await execFileAsync('node', [
      CLI_ENTRY,
      'publisher',
      'publish-async',
      'research',
      'paper',
      '--publisher-node-identity-id',
      '0',
    ], { env });

    expect(JSON.parse(lastPublishAsyncBody)).toEqual({
      contextGraphId: 'research',
      options: { publisherNodeIdentityIdOverride: '0' },
    });

    await expect(execFileAsync('node', [
      CLI_ENTRY,
      'publisher',
      'publish-async',
      'research',
      'paper',
      '--publisher-node-identity-id',
      UINT72_OVERFLOW_DECIMAL,
    ], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining(`--publisher-node-identity-id must be between 0 and ${MAX_UINT72_DECIMAL} (uint72)`),
    });
  }, 30000);

  it('publishes dkg index output through the named KA lifecycle', async () => {
    indexCalls = [];
    const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: smokeApiPort };
    const repo = join(dkgHome, 'index-repo');
    await mkdir(join(repo, 'packages', 'demo', 'src'), { recursive: true });
    await writeFile(join(repo, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    await writeFile(join(repo, 'packages', 'demo', 'package.json'), JSON.stringify({ name: '@demo/pkg', version: '1.0.0' }));
    await writeFile(join(repo, 'packages', 'demo', 'src', 'index.ts'), 'export function greet(name: string): string { return `hi ${name}`; }\n');

    const indexed = await execFileAsync('node', [
      CLI_ENTRY,
      'index',
      repo,
      '--context-graph',
      'research',
    ], { env });

    expect(indexed.stdout).toContain('Published');
    expect(indexed.stdout).toContain('knowledge asset "index-');
    expect(indexed.stdout).toContain('KA ID:  42');
    expect(indexCalls.map((call) => call.url.replace(/index-[^/]+/g, 'index-*'))).toEqual([
      '/api/knowledge-assets',
      '/api/knowledge-assets/index-*/wm/write',
      '/api/knowledge-assets/index-*/wm/finalize',
      '/api/knowledge-assets/index-*/swm/share',
      '/api/knowledge-assets/index-*/vm/publish',
    ]);
    expect(indexCalls[0].body).toMatchObject({ contextGraphId: 'research' });
    expect(indexCalls[0].body.name).toMatch(/^index-/);
    expect(indexCalls[1].body.contextGraphId).toBe('research');
    expect(indexCalls[1].body.quads.length).toBeGreaterThan(0);
    expect(indexCalls.some((call) => call.url === '/api/knowledge-assets/publish')).toBe(false);

    indexCalls = [];
    const staged = await execFileAsync('node', [
      CLI_ENTRY,
      'index',
      repo,
      '--context-graph',
      'research',
      '--shared-memory',
    ], { env });

    expect(staged.stdout).toContain('Staged');
    expect(staged.stdout).toContain('WM knowledge asset "index-');
    expect(staged.stdout).toContain('Next: finalize, share, and publish it through the knowledge-assets lifecycle API.');
    expect(indexCalls.map((call) => call.url.replace(/index-[^/]+/g, 'index-*'))).toEqual([
      '/api/knowledge-assets',
      '/api/knowledge-assets/index-*/wm/write',
    ]);
  }, 60000);
});

async function expectUnknownCommand(args: string[], env: NodeJS.ProcessEnv, command: string): Promise<void> {
  let failure: any;
  try {
    await execFileAsync('node', [CLI_ENTRY, ...args], { env });
  } catch (err) {
    failure = err;
  }

  expect(failure).toBeTruthy();
  expect(failure.code).toBe(1);
  expect(failure.stdout).toBe('');
  expect(String(failure.stderr ?? '').replace(/\r\n/g, '\n')).toBe(`error: unknown command '${command}'\n`);
}
