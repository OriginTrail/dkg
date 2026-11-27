/**
 * Shared stub daemon, fixtures and CLI runner for the knowledge-asset CLI
 * smoke suites (knowledge-asset-cli-smoke-*.test.ts). Each suite spawns the
 * CLI source through tsx dozens of times, which made the original single file
 * the slowest in the CLI lane (about 150 s in CI); it is split by theme so the
 * weighted CLI shards can balance it. Every suite opens its own DKG_HOME and
 * stub daemon, and every test resets the request log it asserts on.
 */
import { onTestFinished } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
export interface CliInvocation { readonly env: NodeJS.ProcessEnv; readonly signal: AbortSignal; }
export interface SmokeCall { method: string; url: string; body?: any; contentType?: string }
export interface SmokeEnvironment {
  readonly dkgHome: string;
  readonly port: string;
  close(): Promise<void>;
}
const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
export const AUTHOR_AGENT_ADDRESS = `0x${'11'.repeat(20)}`;
export const PENDING_OBLIGATION = {
  status: 'confirmed', code: 'CONFIRMED_CATALOG_OBLIGATION_PENDING', catalogObligationPending: true,
  error: 'Confirmed publication catalog obligation was not durably recorded; recovery is required',
  txHash: `0x${'ab'.repeat(32)}`, blockNumber: 100,
  recovery: { version: 1, contextGraphId: 'pending-obligation', assertionCoordinate: 'paper', subGraphName: null,
    transactionHash: `0x${'ab'.repeat(32)}`, blockNumber: 100,
    seal: { authorAddress: AUTHOR_AGENT_ADDRESS, assertionMerkleRoot: `0x${'11'.repeat(32)}`,
      authorAttestationR: `0x${'22'.repeat(32)}`, authorAttestationVS: `0x${'33'.repeat(32)}`,
      authorSchemeVersion: '1', assertedAtChainId: '31337', assertedAtKav10Address: AUTHOR_AGENT_ADDRESS,
      reservedKaId: ((BigInt(AUTHOR_AGENT_ADDRESS) << 96n) | 7n).toString(),
      assertionFinalizedAt: '2026-10-11T12:00:00.000Z', contentScopeVersion: '2',
      kaUal: `did:dkg:evm:31337/${AUTHOR_AGENT_ADDRESS}/7`, assertionVersion: '2',
      publicTripleCount: '1', privateTripleCount: '0', privateMerkleRoot: null } },
  retryAction: 'observe_confirmed_catalog_obligation', retryUrl: '/api/knowledge-assets/paper/vm/observe-confirmed',
};
export const PRE_SIGNED_AUTHOR_ATTESTATION = {
  address: `0x${'22'.repeat(20)}`,
  reservedKaId: '1948668849774537224271579776955044026207910057309515413017665',
  signature: { r: `0x${'33'.repeat(32)}`, vs: `0x${'44'.repeat(32)}` },
};

/** Write the input fixtures, then serve the stub daemon on an ephemeral loopback port. */
export async function openSmokeEnvironment(record: (call: SmokeCall) => void): Promise<SmokeEnvironment> {
  const dkgHome = await mkdtemp(join(tmpdir(), 'dkg-ka-cli-'));
  let server: ReturnType<typeof createServer> | undefined;
  const close = async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    await rm(dkgHome, { recursive: true, force: true });
  };
  try {
    await writeSmokeFixtures(dkgHome);
    server = createSmokeDaemon(record);
    const smokeServer = server;
    const port = await new Promise<string>((resolve, reject) => {
      smokeServer.once('error', reject);
      smokeServer.listen(0, '127.0.0.1', () => {
        const addr = smokeServer.address();
        resolve(typeof addr === 'object' && addr ? String(addr.port) : '0');
      });
    });
    return { dkgHome, port, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function writeSmokeFixtures(dkgHome: string): Promise<void> {
  await writeFile(join(dkgHome, 'paper.md'), '# Paper\n\nAcme logistics note.\n');
  await writeFile(
    join(dkgHome, 'paper.nt'),
    '<urn:company:acme> <http://schema.org/name> "Acme" .\n',
  );
  await writeFile(
    join(dkgHome, 'mixed-graphs.nq'),
    [
      '<urn:company:default> <http://schema.org/name> "Default" .',
      '<urn:company:named> <http://schema.org/name> "Named" <urn:graph:named> .',
      '',
    ].join('\n'),
  );
  await writeFile(join(dkgHome, 'named.jsonld'), JSON.stringify({
    '@context': { name: 'http://schema.org/name' },
    '@id': 'urn:graph:named',
    '@graph': [{ '@id': 'urn:company:named', name: 'Named' }],
  }));
  await writeFile(join(dkgHome, 'mixed.jsonld'), JSON.stringify([
    { '@id': 'urn:company:default', 'http://schema.org/name': 'Default' },
    { '@id': 'urn:graph:named', '@graph': [{ '@id': 'urn:company:named', 'http://schema.org/name': 'Named' }] },
  ]));
  await writeFile(join(dkgHome, 'legacy.jsonld'), JSON.stringify([{
    subject: 'urn:company:legacy', predicate: 'http://schema.org/name',
    object: '"Legacy"', graph: 'urn:graph:legacy',
  }]));
  await writeFile(
    join(dkgHome, 'attestation.json'),
    JSON.stringify(PRE_SIGNED_AUTHOR_ATTESTATION),
  );
}

function createSmokeDaemon(record: (call: SmokeCall) => void): ReturnType<typeof createServer> {
  return createServer(async (req, res) => {
    const method = req.method ?? '';
    const url = req.url ?? '';

    if (method === 'POST' && url === PENDING_OBLIGATION.retryUrl) {
      const body = await readJsonBody(req); record({ method, url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'confirmed', catalogObligationPending: false }));
      return;
    }

    if (method === 'POST' && url === '/api/knowledge-assets') {
      const body = await readJsonBody(req);
      record({ method, url, body });
      if (body.name === 'partial-create') {
        res.writeHead(207, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          name: body.name,
          assertionUri: `did:dkg:context-graph:${body.contextGraphId}/assertion/0xAgent/${body.name}`,
          status: 'wm-sealed',
          created: true,
          swmShared: false,
          publishReady: false,
          errors: [{ phase: 'swm-share', error: 'curator acknowledgement timed out' }],
        }));
        return;
      }
      res.writeHead(201, { 'Content-Type': 'application/json' });
      const promotedCount = body.name === 'already-shared-create' ? 0 : 1;
      res.end(JSON.stringify({
        name: body.name,
        assertionUri: `did:dkg:context-graph:${body.contextGraphId}/assertion/0xAgent/${body.name}`,
        status: body.alsoShareSwm ? 'swm-shared' : 'wm-sealed',
        written: Array.isArray(body.quads) ? body.quads.length : undefined,
        merkleRoot: `0x${'11'.repeat(32)}`,
        shareOperationId: body.alsoShareSwm ? 'share-op-create' : undefined,
        swmShared: body.alsoShareSwm ? true : undefined,
        promotedCount: body.alsoShareSwm ? promotedCount : undefined,
        publishReady: body.alsoShareSwm ? true : undefined,
      }));
      return;
    }

    const lifecycle = url.match(/^\/api\/knowledge-assets\/paper\/(wm\/write|wm\/finalize|swm\/share|swm\/share-async|vm\/publish|vm\/publish-async|wm\/pull-from|wm\/discard)$/);
    if (method === 'POST' && lifecycle) {
      const body = await readJsonBody(req);
      record({ method, url, body });
      const isSharePartial = lifecycle[1] === 'swm/share' && body.contextGraphId === 'partial-share';
      const isPublishPartial = lifecycle[1] === 'vm/publish' && body.contextGraphId === 'partial-binding';
      if (lifecycle[1] === 'vm/publish' && body.contextGraphId === 'pending-obligation') {
        res.writeHead(207, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(PENDING_OBLIGATION)); return;
      }
      res.writeHead(
        lifecycle[1] === 'vm/publish-async'
          ? 202
          : isSharePartial || isPublishPartial
            ? 207
            : 200,
        { 'Content-Type': 'application/json' },
      );
      if (lifecycle[1] === 'wm/write') {
        res.end(JSON.stringify({ written: Array.isArray(body.quads) ? body.quads.length : 0 }));
      } else if (lifecycle[1] === 'wm/finalize') {
        res.end(JSON.stringify({ merkleRoot: `0x${'22'.repeat(32)}`, eip712Digest: `0x${'33'.repeat(32)}` }));
      } else if (lifecycle[1] === 'swm/share') {
        if (isSharePartial) {
          res.end(JSON.stringify({
            swmShared: false,
            promotedCount: 0,
            publishReady: false,
            errors: [{ phase: 'swm-share', error: 'curator acknowledgement timed out' }],
          }));
          return;
        }
        const promotedCount = body.contextGraphId === 'already-shared' ? 0 : 2;
        res.end(JSON.stringify({
          swmShared: true,
          promotedCount,
          sealed: !body.skipSeal,
          publishReady: !body.skipSeal,
          shareOperationId: 'share-op-1',
        }));
      } else if (lifecycle[1] === 'swm/share-async') {
        res.end(JSON.stringify({ jobId: 'share-job-1', state: 'queued' }));
      } else if (lifecycle[1] === 'vm/publish') {
        if (isPublishPartial) {
          res.end(JSON.stringify({
            kaId: '42',
            ual: 'did:dkg:ka:42',
            txHash: '0xpublish',
            status: 'confirmed',
            contextGraphError: 'binding quorum was not reached',
          }));
          return;
        }
        res.end(JSON.stringify({ kaId: '42', ual: 'did:dkg:ka:42', txHash: '0xpublish', status: 'confirmed' }));
      } else if (lifecycle[1] === 'vm/publish-async') {
        res.end(JSON.stringify({
          jobId: 'vm-job-1',
          status: 'accepted',
          contextGraphId: body.contextGraphId,
          name: 'paper',
          shareOperationId: 'share-op-1',
          contentScopeVersion: 2,
          kaUal: 'did:dkg:31337/0x1111111111111111111111111111111111111111/7',
          assertionVersion: '1',
          publicTripleCount: 1,
          privateTripleCount: 0,
          sealMerkleRoot: `0x${'44'.repeat(32)}`,
          intentKey: `sha256:${'55'.repeat(32)}`,
        }));
      } else if (lifecycle[1] === 'wm/pull-from') {
        res.end(JSON.stringify({ wmDraft: 'open', seededFrom: { layer: body.layer }, replaced: body.onConflict === 'replace' }));
      } else {
        res.end(JSON.stringify({ discarded: true }));
      }
      return;
    }

    if (method === 'POST' && url === '/api/knowledge-assets/paper-doc/wm/import-file') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      record({
        method,
        url,
        body: Buffer.concat(chunks).toString('latin1'),
        contentType: String(req.headers['content-type'] ?? ''),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        assertionUri: 'did:dkg:context-graph:research/assertion/0xAgent/paper-doc',
        fileHash: 'keccak256:filehash',
        detectedContentType: 'text/markdown',
        extraction: { status: 'completed', tripleCount: 3 },
      }));
      return;
    }

    if (method === 'GET' && url === '/api/knowledge-assets/paper-doc/wm/extraction-status?contextGraphId=research') {
      record({ method, url });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'completed', tripleCount: 3, fileHash: 'keccak256:filehash' }));
      return;
    }

    if (method === 'GET' && url === '/api/knowledge-assets/paper/wm/quads?contextGraphId=research') {
      record({ method, url });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        count: 1,
        quads: [{
          subject: 'urn:company:acme',
          predicate: 'http://schema.org/name',
          object: '"Acme"',
          graph: 'did:dkg:context-graph:research/assertion/paper',
        }],
      }));
      return;
    }

    if (method === 'GET' && url === '/api/knowledge-assets/paper?contextGraphId=research') {
      record({ method, url });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'paper', state: 'swm-shared', wmCurrentAssertion: 'wm-1', swmCurrentAssertion: 'swm-1' }));
      return;
    }

    if (method === 'GET' && url === '/api/knowledge-assets/swm/share-jobs?contextGraphId=research&state=queued&limit=5') {
      record({ method, url });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jobs: [{
          jobId: 'share-job-1',
          state: 'queued',
          contextGraphId: 'research',
          assertionName: 'paper',
          entities: 'all',
          enqueuedAt: '2026-07-02T00:00:00.000Z',
          updatedAt: '2026-07-02T00:00:00.000Z',
          attempts: 0,
          maxAttempts: 3,
        }],
      }));
      return;
    }

    if (method === 'GET' && url === '/api/knowledge-assets/swm/share-jobs/share-job-1') {
      record({ method, url });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jobId: 'share-job-1',
        state: 'queued',
        contextGraphId: 'research',
        assertionName: 'paper',
        entities: 'all',
        enqueuedAt: '2026-07-02T00:00:00.000Z',
        updatedAt: '2026-07-02T00:00:00.000Z',
        attempts: 0,
        maxAttempts: 3,
      }));
      return;
    }

    if (method === 'DELETE' && url === '/api/knowledge-assets/swm/share-jobs/share-job-1') {
      record({ method, url });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jobId: 'share-job-1', state: 'failed' }));
      return;
    }

    if (method === 'POST' && url === '/api/knowledge-assets/swm/share-jobs/share-job-1/recover') {
      record({ method, url, body: await readJsonBody(req) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jobId: 'share-job-1', state: 'queued' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
}

export function testInvocation(dkgHome: string, apiPort: string, onFinished: (cleanup: () => void) => void = onTestFinished): CliInvocation {
  const env = { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: apiPort };
  const lifetime = new AbortController();
  // A timed-out sequence must neither keep its child alive nor issue the
  // remaining commands against the following test's HTTP request collector.
  onFinished(() => lifetime.abort());
  return { env, signal: lifetime.signal };
}

export async function runCli(args: string[], { env, signal }: CliInvocation): Promise<{ stdout: string; stderr: string }> {
  signal.throwIfAborted();
  return execFileAsync(process.execPath, [CLI_ENTRY, ...args], { env, signal });
}

async function readJsonBody(req: Parameters<Parameters<typeof createServer>[0]>[0]): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : {};
}
