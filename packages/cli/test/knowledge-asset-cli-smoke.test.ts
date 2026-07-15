import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const TSX_LOADER = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');
const CLI_SOURCE = join(__dirname, '..', 'src', 'cli.ts');
const TSX_LOADER_URL = pathToFileURL(TSX_LOADER).href;
const AUTHOR_AGENT_ADDRESS = `0x${'11'.repeat(20)}`;
const PRE_SIGNED_AUTHOR_ATTESTATION = {
  address: `0x${'22'.repeat(20)}`,
  reservedKaId: '1948668849774537224271579776955044026207910057309515413017665',
  signature: { r: `0x${'33'.repeat(32)}`, vs: `0x${'44'.repeat(32)}` },
};

describe.sequential('knowledge-asset CLI smoke', () => {
  let dkgHome: string;
  let server: ReturnType<typeof createServer> | undefined;
  let smokeApiPort: string;
  let calls: Array<{ method: string; url: string; body?: any; contentType?: string }> = [];

  beforeAll(async () => {
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-ka-cli-'));
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
    await writeFile(
      join(dkgHome, 'attestation.json'),
      JSON.stringify(PRE_SIGNED_AUTHOR_ATTESTATION),
    );

    server = createServer(async (req, res) => {
      const method = req.method ?? '';
      const url = req.url ?? '';

      if (method === 'POST' && url === '/api/knowledge-assets') {
        const body = await readJsonBody(req);
        calls.push({ method, url, body });
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
        calls.push({ method, url, body });
        const isSharePartial = lifecycle[1] === 'swm/share' && body.contextGraphId === 'partial-share';
        const isPublishPartial = lifecycle[1] === 'vm/publish' && body.contextGraphId === 'partial-binding';
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
        calls.push({
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
        calls.push({ method, url });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'completed', tripleCount: 3, fileHash: 'keccak256:filehash' }));
        return;
      }

      if (method === 'GET' && url === '/api/knowledge-assets/paper/wm/quads?contextGraphId=research') {
        calls.push({ method, url });
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
        calls.push({ method, url });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'paper', state: 'swm-shared', wmCurrentAssertion: 'wm-1', swmCurrentAssertion: 'swm-1' }));
        return;
      }

      if (method === 'GET' && url === '/api/knowledge-assets/swm/share-jobs?contextGraphId=research&state=queued&limit=5') {
        calls.push({ method, url });
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
        calls.push({ method, url });
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
        calls.push({ method, url });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId: 'share-job-1', state: 'failed' }));
        return;
      }

      if (method === 'POST' && url === '/api/knowledge-assets/swm/share-jobs/share-job-1/recover') {
        calls.push({ method, url, body: await readJsonBody(req) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId: 'share-job-1', state: 'queued' }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    const smokeServer = server;
    if (!smokeServer) throw new Error('Smoke API server was not initialized');
    await new Promise<void>((resolve, reject) => {
      smokeServer.once('error', reject);
      smokeServer.listen(0, '127.0.0.1', () => {
        const addr = smokeServer.address();
        smokeApiPort = typeof addr === 'object' && addr ? String(addr.port) : '0';
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (dkgHome) await rm(dkgHome, { recursive: true, force: true });
  });

  it('registers canonical command and ka alias help', async () => {
    const env = testEnv(dkgHome, smokeApiPort);
    const top = await runCli(['--help'], env);
    expect(top.stdout).toContain('knowledge-asset');

    const canonical = await runCli(['knowledge-asset', '--help'], env);
    expect(canonical.stdout).toContain('Knowledge Asset lifecycle commands');
    expect(canonical.stdout).toContain('publish-async');

    const alias = await runCli(['ka', 'create', '--help'], env);
    expect(alias.stdout).toContain('--input-file <path>');
    expect(alias.stdout).toContain('--share');
    expect(alias.stdout).not.toContain('alsoPublishVm');

    const publish = await runCli(['ka', 'publish', '--help'], env);
    expect(publish.stdout).toContain('--publish-epochs <count>');
    expect(publish.stdout).not.toContain('--clear-after');

    const publishAsync = await runCli(['ka', 'publish-async', '--help'], env);
    expect(publishAsync.stdout).toContain('--publish-epochs <count>');
    expect(publishAsync.stdout).not.toContain('--clear-after');
  }, 30000);

  it('rejects one-shot share without payload before contacting the daemon', async () => {
    calls = [];
    const env = testEnv(dkgHome, smokeApiPort);

    await expect(runCli(['ka', 'create', 'paper', '-c', 'research', '--share'], env))
      .rejects.toMatchObject({
        stderr: expect.stringContaining('--share requires non-empty payload quads and finalize enabled'),
      });
    expect(calls).toEqual([]);
  }, 30000);

  it('maps file-backed one-shot create/share into the KA lifecycle request body', async () => {
    calls = [];
    const env = testEnv(dkgHome, smokeApiPort);

    const created = await runCli([
      'ka',
      'create',
      'paper-file',
      '--context-graph-id',
      'research',
      '--input-file',
      join(dkgHome, 'paper.nt'),
      '--share',
    ], env);

    expect(created.stdout).toContain('Parsed 1 quad(s)');
    expect(created.stdout).toContain('Knowledge asset create complete:');

    const createCall = calls.find((call) => call.url === '/api/knowledge-assets');
    expect(createCall?.body).toMatchObject({
      contextGraphId: 'research',
      name: 'paper-file',
      alsoShareSwm: true,
    });
    expect(createCall?.body.alsoPublishVm).toBeUndefined();
    expect(createCall?.body.quads).toEqual([
      expect.objectContaining({
        subject: 'urn:company:acme',
        predicate: 'http://schema.org/name',
        object: '"Acme"',
        graph: '',
      }),
    ]);
  }, 30000);

  it('preserves named graph metadata when the first parsed quad is default graph', async () => {
    calls = [];
    const env = testEnv(dkgHome, smokeApiPort);

    await runCli([
      'ka',
      'create',
      'paper-graphs',
      '--context-graph-id',
      'research',
      '--input-file',
      join(dkgHome, 'mixed-graphs.nq'),
      '--no-finalize',
    ], env);

    const createCall = calls.find((call) => call.url === '/api/knowledge-assets');
    expect(createCall?.body.quads).toEqual([
      {
        subject: 'urn:company:default',
        predicate: 'http://schema.org/name',
        object: '"Default"',
        graph: '',
      },
      {
        subject: 'urn:company:named',
        predicate: 'http://schema.org/name',
        object: '"Named"',
        graph: 'urn:graph:named',
      },
    ]);
  }, 30000);

  it('treats an idempotent zero-promote one-shot create/share as successful no-op guidance', async () => {
    calls = [];
    const env = testEnv(dkgHome, smokeApiPort);

    const created = await runCli([
      'ka',
      'create',
      'already-shared-create',
      '-c',
      'research',
      '--input-file',
      join(dkgHome, 'paper.nt'),
      '--share',
    ], env);

    expect(created.stdout).toContain('Knowledge asset create complete:');
    expect(created.stdout).toContain('No new triples promoted');
    expect(calls.find((call) => call.url === '/api/knowledge-assets')?.body)
      .toMatchObject({ name: 'already-shared-create', alsoShareSwm: true });
  }, 30000);

  it('maps draft-only create and rejects incompatible draft share before contacting the daemon', async () => {
    calls = [];
    const env = testEnv(dkgHome, smokeApiPort);
    const triples = JSON.stringify([{ subject: 'urn:company:acme', predicate: 'http://schema.org/name', object: '"Acme"' }]);

    await runCli(['ka', 'create', 'draft', '-c', 'research', '--triples', triples, '--no-finalize'], env);

    expect(calls.find((call) => call.url === '/api/knowledge-assets')?.body)
      .toMatchObject({ name: 'draft', finalize: false });
    expect(calls.find((call) => call.url === '/api/knowledge-assets')?.body.alsoShareSwm)
      .toBeUndefined();

    calls = [];
    await expect(runCli(['ka', 'create', 'draft-share', '-c', 'research', '--triples', triples, '--share', '--no-finalize'], env))
      .rejects.toMatchObject({
        stderr: expect.stringContaining('--share requires non-empty payload quads and finalize enabled'),
      });
    expect(calls).toEqual([]);
  }, 30000);

  it('rejects malformed positive integer flags before daemon requests', async () => {
    calls = [];
    const env = testEnv(dkgHome, smokeApiPort);

    await expect(runCli(['ka', 'publish', 'paper', '-c', 'research', '--publish-epochs', '1e6'], env))
      .rejects.toMatchObject({
        stderr: expect.stringContaining('--publish-epochs must be a positive integer'),
      });
    await expect(runCli(['ka', 'publish-async', 'paper', '-c', 'research', '--publish-epochs', '3abc'], env))
      .rejects.toMatchObject({
        stderr: expect.stringContaining('--publish-epochs must be a positive integer'),
      });
    await expect(runCli(['ka', 'finalize', 'paper', '-c', 'research', '--scheme-version', '2.5'], env))
      .rejects.toMatchObject({
        stderr: expect.stringContaining('--scheme-version must be a positive integer'),
      });
    expect(calls).toEqual([]);
  }, 30000);

  it('maps author attestation flags through CLI parsing and rejects conflicts', async () => {
    calls = [];
    const env = testEnv(dkgHome, smokeApiPort);
    const triples = JSON.stringify([{ subject: 'urn:company:acme', predicate: 'http://schema.org/name', object: '"Acme"' }]);

    await runCli([
      'ka',
      'create',
      'author-inline',
      '-c',
      'research',
      '--triples',
      triples,
      '--pre-signed-author-attestation',
      JSON.stringify(PRE_SIGNED_AUTHOR_ATTESTATION),
      '--scheme-version',
      '2',
    ], env);

    const createCall = calls.find((call) => call.url === '/api/knowledge-assets');
    expect(createCall?.body).toMatchObject({
      name: 'author-inline',
      preSignedAuthorAttestation: PRE_SIGNED_AUTHOR_ATTESTATION,
      schemeVersion: 2,
    });
    expect(createCall?.body.authorAgentAddress).toBeUndefined();

    calls = [];
    await runCli([
      'ka',
      'finalize',
      'paper',
      '-c',
      'research',
      '--pre-signed-author-attestation',
      join(dkgHome, 'attestation.json'),
      '--scheme-version',
      '2',
    ], env);
    const fileBackedFinalize = calls.find((call) => call.url === '/api/knowledge-assets/paper/wm/finalize');
    expect(fileBackedFinalize?.body).toMatchObject({
      contextGraphId: 'research',
      preSignedAuthorAttestation: PRE_SIGNED_AUTHOR_ATTESTATION,
      schemeVersion: 2,
    });

    calls = [];
    await runCli([
      'ka',
      'finalize',
      'paper',
      '-c',
      'research',
      '--author-agent-address',
      AUTHOR_AGENT_ADDRESS,
      '--scheme-version',
      '1',
    ], env);
    const authorAddressFinalize = calls.find((call) => call.url === '/api/knowledge-assets/paper/wm/finalize');
    expect(authorAddressFinalize?.body).toMatchObject({
      contextGraphId: 'research',
      authorAgentAddress: AUTHOR_AGENT_ADDRESS,
      schemeVersion: 1,
    });
    expect(authorAddressFinalize?.body.preSignedAuthorAttestation).toBeUndefined();

    calls = [];
    await expect(runCli([
      'ka',
      'finalize',
      'paper',
      '-c',
      'research',
      '--author-agent-address',
      AUTHOR_AGENT_ADDRESS,
      '--pre-signed-author-attestation',
      join(dkgHome, 'attestation.json'),
    ], env))
      .rejects.toMatchObject({
        stderr: expect.stringContaining('--author-agent-address and --pre-signed-author-attestation are mutually exclusive'),
      });
    expect(calls).toEqual([]);
  }, 60000);

  it('treats an idempotent zero-promote sync share as successful no-op guidance', async () => {
    calls = [];
    const env = testEnv(dkgHome, smokeApiPort);

    const shared = await runCli(['ka', 'share', 'paper', '-c', 'already-shared'], env);

    expect(shared.stdout).toContain('Knowledge asset shared to SWM:');
    expect(shared.stdout).toContain('Triples:        0');
    expect(shared.stdout).toContain('No new triples promoted');
    expect(shared.stdout).toContain('Next:');
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/swm/share')?.body)
      .toMatchObject({ contextGraphId: 'already-shared' });
  }, 30000);

  it('exits non-zero for partial create/share and sync share lifecycle responses', async () => {
    calls = [];
    const env = testEnv(dkgHome, smokeApiPort);

    await expect(runCli([
      'ka',
      'create',
      'partial-create',
      '-c',
      'research',
      '--input-file',
      join(dkgHome, 'paper.nt'),
      '--share',
    ], env))
      .rejects.toMatchObject({
        stdout: expect.not.stringContaining('Knowledge asset create complete:'),
        stderr: expect.stringMatching(/create\/share completed partially.*curator acknowledgement timed out/),
      });

    await expect(runCli(['ka', 'share', 'paper', '-c', 'partial-share'], env))
      .rejects.toMatchObject({
        stdout: expect.not.stringContaining('Knowledge asset shared to SWM:'),
        stderr: expect.stringMatching(/share completed partially.*curator acknowledgement timed out/),
      });

    expect(calls.find((call) => call.url === '/api/knowledge-assets' && call.body?.name === 'partial-create')?.body)
      .toMatchObject({ alsoShareSwm: true });
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/swm/share')?.body)
      .toMatchObject({ contextGraphId: 'partial-share' });
  }, 60000);

  it('reports VM publish partial context-graph binding and keeps named publish cleanup out of KA commands', async () => {
    calls = [];
    const env = testEnv(dkgHome, smokeApiPort);

    await expect(runCli(['ka', 'publish', 'paper', '-c', 'partial-binding'], env))
      .rejects.toMatchObject({
        stdout: expect.not.stringContaining('Knowledge asset VM publish complete:'),
        stderr: expect.stringContaining('context graph binding failed'),
      });

    await expect(runCli(['ka', 'publish', 'paper', '-c', 'research', '--clear-after'], env))
      .rejects.toMatchObject({
        stderr: expect.stringContaining("unknown option '--clear-after'"),
      });

    await expect(runCli(['ka', 'publish-async', 'paper', '-c', 'research', '--clear-after'], env))
      .rejects.toMatchObject({
        stderr: expect.stringContaining("unknown option '--clear-after'"),
      });

    const publishCalls = calls.filter((call) => call.url === '/api/knowledge-assets/paper/vm/publish');
    expect(publishCalls.find((call) => call.body?.contextGraphId === 'partial-binding')?.body.options)
      .toBeUndefined();
    expect(publishCalls.find((call) => call.body?.contextGraphId === 'research'))
      .toBeUndefined();
  }, 60000);

  it('creates, writes, finalizes, shares, and publishes through lifecycle-native KA commands', async () => {
    calls = [];
    const env = testEnv(dkgHome, smokeApiPort);
    const triples = JSON.stringify([{ subject: 'urn:company:acme', predicate: 'http://schema.org/name', object: '"Acme"' }]);

    const created = await runCli(['ka', 'create', 'paper', '--context-graph-id', 'research', '--triples', triples, '--share', '--await-curator-ack'], env);
    expect(created.stdout).toContain('Knowledge asset create complete:');

    const createCall = calls.find((call) => call.url === '/api/knowledge-assets');
    expect(createCall?.body).toMatchObject({
      contextGraphId: 'research',
      name: 'paper',
      alsoShareSwm: true,
      awaitCuratorAck: true,
    });
    expect(createCall?.body.alsoPublishVm).toBeUndefined();

    await runCli(['knowledge-asset', 'write', 'paper', '-c', 'research', '--subject', 'urn:company:acme', '--predicate', 'http://schema.org/description', '--object', 'Logistics'], env);
    await runCli(['ka', 'finalize', 'paper', '-c', 'research'], env);
    await runCli(['ka', 'finalize', 'paper', '-c', 'research', '--layer', 'wm'], env);
    await expect(runCli(['ka', 'finalize', 'paper', '-c', 'research', '--layer', 'swm'], env))
      .rejects.toMatchObject({ stderr: expect.stringContaining('Legacy root-scoped Knowledge Assets are read-only') });
    await expect(runCli(['ka', 'share', 'paper', '-c', 'research', '--entity', 'urn:company:acme'], env))
      .rejects.toMatchObject({ stderr: expect.stringContaining("unknown option '--entity'") });
    await expect(runCli(['ka', 'share', 'paper', '-c', 'research', '--skip-seal'], env))
      .rejects.toMatchObject({ stderr: expect.stringContaining("unknown option '--skip-seal'") });
    const shared = await runCli(['ka', 'share', 'paper', '-c', 'research', '--await-curator-ack'], env);
    expect(shared.stdout).toContain('Next:');
    await runCli(['ka', 'publish', 'paper', '-c', 'research', '--publish-epochs', '3', '--publisher-node-identity-id', '7'], env);
    await runCli(['ka', 'publish-async', 'paper', '-c', 'research', '--publish-epochs', '4', '--json'], env);
    await runCli(['ka', 'pull-from', 'paper', '-c', 'research', '--layer', 'swm', '--on-conflict', 'replace', '--json'], env);
    await runCli(['ka', 'discard', 'paper', '-c', 'research'], env);
    await runCli(['ka', 'query', 'paper', '-c', 'research'], env);
    await runCli(['ka', 'history', 'paper', '-c', 'research'], env);

    expect(calls.map((call) => call.url)).toContain('/api/knowledge-assets/paper/wm/write');
    expect(calls.map((call) => call.url)).toContain('/api/knowledge-assets/paper/wm/finalize');
    expect(calls.filter((call) => call.url === '/api/knowledge-assets/paper/wm/finalize'))
      .toHaveLength(2);
    expect(calls.map((call) => call.url)).toContain('/api/knowledge-assets/paper/swm/share');
    expect(calls.map((call) => call.url)).toContain('/api/knowledge-assets/paper/vm/publish');
    expect(calls.map((call) => call.url)).toContain('/api/knowledge-assets/paper/vm/publish-async');
    expect(calls.map((call) => call.url)).not.toContain('/api/knowledge-assets/publish');
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/wm/write')?.body.quads).toEqual([
      expect.objectContaining({
        subject: 'urn:company:acme',
        predicate: 'http://schema.org/description',
        object: '"Logistics"',
      }),
    ]);
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/wm/finalize')?.body.layer).toBeUndefined();
    const shareCalls = calls.filter((call) => call.url === '/api/knowledge-assets/paper/swm/share');
    expect(shareCalls[0]?.body).toMatchObject({
      contextGraphId: 'research',
      awaitCuratorAck: true,
    });
    expect(shareCalls[0]?.body.entities).toBeUndefined();
    expect(shareCalls[0]?.body.skipSeal).toBeUndefined();
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/vm/publish')?.body.options).toMatchObject({
      publishEpochs: 3,
      publisherNodeIdentityIdOverride: '7',
    });
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/vm/publish')?.body.options)
      .not.toHaveProperty('clearSharedMemoryAfter');
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/vm/publish-async')?.body.options).toMatchObject({
      publishEpochs: 4,
    });
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/vm/publish-async')?.body.options)
      .not.toHaveProperty('clearSharedMemoryAfter');
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/wm/pull-from')?.body).toMatchObject({
      layer: 'swm',
      onConflict: 'replace',
    });
  }, 60000);

  it('wraps document import, extraction status, and async SWM share job routes', async () => {
    calls = [];
    const env = testEnv(dkgHome, smokeApiPort);

    await runCli(['ka', 'import-file', 'paper-doc', '-c', 'research', '--input-file', join(dkgHome, 'paper.md')], env);
    await runCli(['ka', 'extraction-status', 'paper-doc', '-c', 'research'], env);
    await runCli(['ka', 'share-async', 'paper', '-c', 'research'], env);
    await expect(runCli(['ka', 'share-async', 'paper', '-c', 'research', '--entity', 'urn:company:acme'], env))
      .rejects.toMatchObject({ stderr: expect.stringContaining("unknown option '--entity'") });
    await runCli(['ka', 'share-jobs', '-c', 'research', '--state', 'queued', '--limit', '5'], env);
    await runCli(['ka', 'share-job', 'share-job-1'], env);
    await runCli(['ka', 'cancel-share-job', 'share-job-1'], env);
    await runCli(['ka', 'recover-share-job', 'share-job-1'], env);

    const importCall = calls.find((call) => call.url === '/api/knowledge-assets/paper-doc/wm/import-file');
    expect(importCall?.contentType).toContain('multipart/form-data; boundary=');
    expect(String(importCall?.body)).toContain('name="contextGraphId"');
    expect(String(importCall?.body)).toContain('research');
    expect(calls.find((call) => call.url === '/api/knowledge-assets/paper/swm/share-async')?.body)
      .toMatchObject({ contextGraphId: 'research' });
    const shareAsyncCalls = calls.filter((call) => call.url === '/api/knowledge-assets/paper/swm/share-async');
    expect(shareAsyncCalls[0]?.body.entities).toBeUndefined();
    expect(calls.map((call) => call.url)).toContain('/api/knowledge-assets/swm/share-jobs?contextGraphId=research&state=queued&limit=5');
    expect(calls.map((call) => call.url)).toContain('/api/knowledge-assets/swm/share-jobs/share-job-1');
    expect(calls.map((call) => `${call.method} ${call.url}`)).toContain('DELETE /api/knowledge-assets/swm/share-jobs/share-job-1');
    expect(calls.map((call) => call.url)).toContain('/api/knowledge-assets/swm/share-jobs/share-job-1/recover');
  }, 60000);
});

function testEnv(dkgHome: string, apiPort: string): NodeJS.ProcessEnv {
  return { ...process.env, DKG_HOME: dkgHome, DKG_API_PORT: apiPort };
}

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('node', ['--import', TSX_LOADER_URL, CLI_SOURCE, ...args], { env });
}

async function readJsonBody(req: Parameters<Parameters<typeof createServer>[0]>[0]): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : {};
}
