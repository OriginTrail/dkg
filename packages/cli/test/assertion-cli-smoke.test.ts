import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'dist', 'cli.js');

describe.sequential('assertion CLI smoke', () => {
  let dkgHome: string;
  let server: ReturnType<typeof createServer>;
  let smokeApiPort: string;
  let lastImportBody = '';
  let lastImportContentType = '';

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
      if (req.method === 'POST' && req.url === '/api/assertion/paper/import-file') {
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

      if (req.method === 'GET' && req.url === '/api/assertion/paper/extraction-status?contextGraphId=research') {
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

      if (req.method === 'GET' && req.url === '/api/assertion/paper/extraction-status?contextGraphId=research&subGraphName=lab') {
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

      if (req.method === 'POST' && req.url === '/api/assertion/paper/promote') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          promoted: true,
          contextGraphId: 'research',
          count: 14,
          sharedMemoryGraph: 'did:dkg:context-graph:research/shared-memory',
          rootEntities: ['urn:company:acme'],
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/assertion/paper/query') {
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
  }, 15000);
});
