import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

// CLI subcommand smoke tests for `dkg epcis {capture,status,query}`.
// These tests boot a tiny in-process HTTP server that mimics the daemon's
// /api/epcis/* contract just enough to:
//   - assert the CLI sends the right method, path, query string, body, and
//     auth header for each subcommand and flag combination
//   - assert the CLI maps HTTP status codes to the documented exit codes
//     (0 / 1 / 2 / 3 / 4 — see slice 05 spec, "Exit codes")
// The CLI talks to the stub via the standard `DKG_API_PORT` + auth-token
// channel that ApiClient.connect() reads, so this is end-to-end against
// the compiled CLI binary without booting the full daemon.

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, '..', 'dist', 'cli.js');

interface StubHandler {
  (req: IncomingMessage, body: string): {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  };
}

interface StubCall {
  method: string;
  url: string;
  authorization?: string;
  body: string;
}

/**
 * Tiny stub daemon. Each test installs a handler with `setHandler`; the
 * server records what it received in `calls` so the test can assert
 * about the exact request the CLI sent.
 */
function startStub(): Promise<{
  server: Server;
  port: number;
  setHandler: (h: StubHandler) => void;
  calls: StubCall[];
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    let handler: StubHandler = () => ({ status: 500, body: { error: 'No handler installed' } });
    const calls: StubCall[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        calls.push({
          method: req.method ?? '',
          url: req.url ?? '',
          authorization: req.headers.authorization,
          body: raw,
        });
        const result = handler(req, raw);
        const headers = { 'Content-Type': 'application/json', ...(result.headers ?? {}) };
        res.writeHead(result.status, headers);
        res.end(JSON.stringify(result.body));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        setHandler: (h) => {
          handler = h;
        },
        calls,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });
}

interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Invoke the compiled CLI with `DKG_API_PORT` + a fake auth token pointing
 * at the stub server. We bypass the auth-token file by using `DKG_HOME`
 * pointing at a fresh temp dir that contains the bearer token Honest-CLI
 * expects — that mirrors the `auth.ts` token-loading path.
 */
async function runCli(
  args: string[],
  env: { DKG_API_PORT: string; DKG_HOME: string } & NodeJS.ProcessEnv,
): Promise<CliRunResult> {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI_ENTRY, ...args], {
      env: { ...process.env, ...env },
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const child = err as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    const exitCode = typeof child.code === 'number' ? child.code : 1;
    return {
      exitCode,
      stdout: child.stdout ?? '',
      stderr: child.stderr ?? '',
    };
  }
}

describe.sequential('dkg epcis subcommands', { timeout: 240_000 }, () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  let dkgHome: string;

  beforeAll(async () => {
    if (!existsSync(CLI_ENTRY)) {
      // Mirrors publisher-cli-smoke.test.ts: build the CLI on demand if a
      // contributor runs this test before the package's own build step.
      await execFileAsync('pnpm', ['build'], { cwd: join(__dirname, '..') });
    }
    stub = await startStub();
    dkgHome = await mkdtemp(join(tmpdir(), 'dkg-epcis-cli-'));
    // The CLI's `ApiClient.connect()` reads `<DKG_HOME>/auth.token` (plain
    // text, one token per line — see `auth.ts: loadTokens`). Write a known
    // bearer so the stub server can assert on it.
    await writeFile(join(dkgHome, 'config.json'), JSON.stringify({
      name: 'epcis-cli-stub',
      apiPort: stub.port,
      listenPort: 0,
      nodeRole: 'edge',
      paranets: [],
    }));
    await writeFile(join(dkgHome, 'auth.token'), 'stub-token\n', { mode: 0o600 });
  }, 240_000);

  afterAll(async () => {
    if (stub) await stub.close();
    if (dkgHome) await rm(dkgHome, { recursive: true, force: true });
  });

  function clearCalls() {
    stub.calls.length = 0;
  }

  function env(): { DKG_API_PORT: string; DKG_HOME: string } {
    return { DKG_API_PORT: String(stub.port), DKG_HOME: dkgHome };
  }

  describe('capture', () => {
    it('reads file, POSTs to /api/epcis/capture, prints captureID JSON, exits 0', async () => {
      clearCalls();
      stub.setHandler((req) => {
        if (req.method !== 'POST' || req.url !== '/api/epcis/capture') {
          return { status: 404, body: { error: 'NotFound' } };
        }
        return {
          status: 202,
          body: { captureID: 'cap-abc', receivedAt: '2026-05-05T00:00:00Z', eventCount: 1, status: 'accepted' },
        };
      });

      const docPath = join(dkgHome, 'cap.json');
      const doc = {
        '@context': 'https://gs1.github.io/EPCIS/',
        type: 'EPCISDocument',
        schemaVersion: '2.0',
        creationDate: '2026-05-05T00:00:00Z',
        epcisBody: {
          eventList: [
            { type: 'ObjectEvent', eventTime: '2026-05-05T00:00:00Z', action: 'ADD' },
          ],
        },
      };
      await writeFile(docPath, JSON.stringify(doc));

      const result = await runCli(
        ['epcis', 'capture', docPath, '--context-graph-id', 'cg-1'],
        env(),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"captureID": "cap-abc"');
      expect(stub.calls).toHaveLength(1);
      const call = stub.calls[0];
      expect(call.method).toBe('POST');
      expect(call.url).toBe('/api/epcis/capture');
      expect(call.authorization).toBe('Bearer stub-token');
      const body = JSON.parse(call.body);
      expect(body.epcisDocument).toEqual(doc);
      expect(body.contextGraphId).toBe('cg-1');
    });

    it('threads --sub-graph-name, --access-policy, and repeated --allowed-peer into the body', async () => {
      clearCalls();
      stub.setHandler(() => ({ status: 202, body: { captureID: 'cap-xyz', status: 'accepted', receivedAt: 't', eventCount: 1 } }));

      const docPath = join(dkgHome, 'cap2.json');
      await writeFile(docPath, JSON.stringify({ type: 'EPCISDocument' }));

      const result = await runCli(
        [
          'epcis', 'capture', docPath,
          '--context-graph-id', 'cg-1',
          '--sub-graph-name', 'research',
          '--access-policy', 'allowList',
          '--allowed-peer', 'peerA',
          '--allowed-peer', 'peerB',
        ],
        env(),
      );

      expect(result.exitCode).toBe(0);
      const body = JSON.parse(stub.calls[0].body);
      expect(body.contextGraphId).toBe('cg-1');
      expect(body.subGraphName).toBe('research');
      expect(body.publishOptions).toEqual({
        accessPolicy: 'allowList',
        allowedPeers: ['peerA', 'peerB'],
      });
    });

    it('accepts an envelope file ({ epcisDocument, publishOptions, contextGraphId, subGraphName })', async () => {
      clearCalls();
      stub.setHandler(() => ({ status: 202, body: { captureID: 'cap-env', status: 'accepted', receivedAt: 't', eventCount: 1 } }));
      const envelope = {
        contextGraphId: 'cg-from-file',
        subGraphName: 'sub-from-file',
        epcisDocument: { type: 'EPCISDocument' },
        publishOptions: { accessPolicy: 'public' },
      };
      const docPath = join(dkgHome, 'envelope.json');
      await writeFile(docPath, JSON.stringify(envelope));
      const result = await runCli(['epcis', 'capture', docPath], env());
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(stub.calls[0].body);
      expect(body.contextGraphId).toBe('cg-from-file');
      expect(body.subGraphName).toBe('sub-from-file');
      expect(body.publishOptions).toEqual({ accessPolicy: 'public' });
      expect(body.epcisDocument).toEqual({ type: 'EPCISDocument' });
    });

    it('CLI flag --context-graph-id overrides the envelope file value', async () => {
      clearCalls();
      stub.setHandler(() => ({ status: 202, body: { captureID: 'cap-ovr', status: 'accepted', receivedAt: 't', eventCount: 1 } }));
      const envelope = { contextGraphId: 'cg-from-file', epcisDocument: { type: 'EPCISDocument' } };
      const docPath = join(dkgHome, 'envelope2.json');
      await writeFile(docPath, JSON.stringify(envelope));
      const result = await runCli(
        ['epcis', 'capture', docPath, '--context-graph-id', 'cg-from-flag'],
        env(),
      );
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(stub.calls[0].body);
      expect(body.contextGraphId).toBe('cg-from-flag');
    });

    it('rejects --allowed-peer without --access-policy allowList (exit 1)', async () => {
      const docPath = join(dkgHome, 'cap-bad.json');
      await writeFile(docPath, JSON.stringify({ type: 'EPCISDocument' }));
      const result = await runCli(
        ['epcis', 'capture', docPath, '--allowed-peer', 'peerA'],
        env(),
      );
      expect(result.exitCode).toBe(1);
      // CLI flags are merged into publishOptions before validation runs
      // (cli.ts:2841 unified envelope-validator), so the failure surfaces in
      // envelope-field terms even when the input came from CLI flags only.
      // See commit 8e5071dd ("validate merged publishOptions from envelope +
      // CLI flags") — the dedicated CLI-flag check was consolidated into the
      // single validator, so both this test and the envelope-file test below
      // assert the same message but exercise different input shapes.
      expect(result.stderr).toContain('publishOptions.allowedPeers requires accessPolicy "allowList"');
    });

    it('rejects CLI --access-policy ownerOnly when envelope file carries allowedPeers (exit 1)', async () => {
      const envelope = {
        epcisDocument: { type: 'EPCISDocument' },
        publishOptions: { accessPolicy: 'allowList', allowedPeers: ['peerA'] },
      };
      const docPath = join(dkgHome, 'cap-stale-peers.json');
      await writeFile(docPath, JSON.stringify(envelope));
      const result = await runCli(
        ['epcis', 'capture', docPath, '--access-policy', 'ownerOnly'],
        env(),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('publishOptions.allowedPeers requires accessPolicy "allowList"');
    });

    it('rejects envelope file with invalid publishOptions.accessPolicy (exit 1)', async () => {
      const envelope = {
        epcisDocument: { type: 'EPCISDocument' },
        publishOptions: { accessPolicy: 'bogus' },
      };
      const docPath = join(dkgHome, 'cap-bad-policy.json');
      await writeFile(docPath, JSON.stringify(envelope));
      const result = await runCli(['epcis', 'capture', docPath], env());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid publishOptions.accessPolicy');
    });

    it('maps 503 PublisherDisabled to exit code 3', async () => {
      clearCalls();
      stub.setHandler(() => ({
        status: 503,
        body: { error: 'PublisherDisabled', message: 'Async EPCIS capture requires publisher.enabled=true' },
      }));
      const docPath = join(dkgHome, 'cap-503.json');
      await writeFile(docPath, JSON.stringify({ type: 'EPCISDocument' }));
      const result = await runCli(['epcis', 'capture', docPath], env());
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain('PublisherDisabled');
    });

    it('maps 400 InvalidContent to exit code 2', async () => {
      clearCalls();
      stub.setHandler(() => ({
        status: 400,
        body: { error: 'InvalidContent', message: 'Missing "epcisDocument"' },
      }));
      const docPath = join(dkgHome, 'cap-400.json');
      await writeFile(docPath, JSON.stringify({ type: 'EPCISDocument' }));
      const result = await runCli(['epcis', 'capture', docPath], env());
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('InvalidContent');
    });

    it('maps 404 ContextGraphNotFound to exit code 4', async () => {
      clearCalls();
      stub.setHandler(() => ({
        status: 404,
        body: { error: 'ContextGraphNotFound', message: 'unknown cg' },
      }));
      const docPath = join(dkgHome, 'cap-404.json');
      await writeFile(docPath, JSON.stringify({ type: 'EPCISDocument' }));
      const result = await runCli(['epcis', 'capture', docPath], env());
      expect(result.exitCode).toBe(4);
      expect(result.stderr).toContain('ContextGraphNotFound');
    });

    it('exits 1 on missing input file', async () => {
      const result = await runCli(['epcis', 'capture', join(dkgHome, 'does-not-exist.json')], env());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Failed to read');
    });

    it('exits 1 on invalid JSON in input file', async () => {
      const docPath = join(dkgHome, 'bad.json');
      await writeFile(docPath, '{not valid json');
      const result = await runCli(['epcis', 'capture', docPath], env());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid JSON');
    });
  });

  describe('status', () => {
    it('GETs /api/epcis/capture/:id, prints JSON, exits 0', async () => {
      clearCalls();
      const captureID = 'cap-abc';
      stub.setHandler((req) => {
        if (req.method !== 'GET' || !req.url?.startsWith('/api/epcis/capture/')) {
          return { status: 404, body: { error: 'NotFound' } };
        }
        return {
          status: 200,
          body: {
            captureID,
            state: 'finalized',
            receivedAt: '2026-05-05T00:00:00Z',
            finalizedAt: '2026-05-05T00:00:30Z',
            error: null,
          },
        };
      });
      const result = await runCli(['epcis', 'status', captureID], env());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('"state": "finalized"');
      expect(stub.calls[0].method).toBe('GET');
      expect(stub.calls[0].url).toBe(`/api/epcis/capture/${captureID}`);
    });

    it('URL-encodes captureIDs that contain reserved characters', async () => {
      clearCalls();
      stub.setHandler(() => ({
        status: 200,
        body: { captureID: 'a/b', state: 'accepted', receivedAt: 't', finalizedAt: null, error: null },
      }));
      const result = await runCli(['epcis', 'status', 'a/b'], env());
      expect(result.exitCode).toBe(0);
      expect(stub.calls[0].url).toBe('/api/epcis/capture/a%2Fb');
    });

    it('maps 404 CaptureNotFound to exit code 4', async () => {
      clearCalls();
      stub.setHandler(() => ({ status: 404, body: { error: 'CaptureNotFound' } }));
      const result = await runCli(['epcis', 'status', 'cap-missing'], env());
      expect(result.exitCode).toBe(4);
      expect(result.stderr).toContain('CaptureNotFound');
    });
  });

  describe('query', () => {
    it('builds query string from flags, GETs /api/epcis/events, prints JSON', async () => {
      clearCalls();
      const responseBody = {
        '@context': [],
        type: 'EPCISQueryDocument',
        schemaVersion: '2.0',
        epcisBody: {
          queryResults: {
            queryName: 'SimpleEventQuery',
            resultsBody: {
              eventList: [{ type: 'ObjectEvent', eventTime: '2026-05-05T11:00:00Z' }],
            },
          },
        },
      };
      stub.setHandler(() => ({ status: 200, body: responseBody }));
      const result = await runCli(
        [
          'epcis', 'query',
          '--context-graph-id', 'cg-1',
          '--sub-graph-name', 'research',
          '--finalized', 'false',
          '--epc', 'urn:epc:id:sgtin:1.2.3',
          '--biz-step', 'https://ref.gs1.org/cbv/BizStep-receiving',
          '--from', '2026-05-01T00:00:00Z',
          '--to', '2026-05-31T00:00:00Z',
          '--event-type', 'ObjectEvent',
          '--action', 'ADD',
          '--per-page', '10',
        ],
        env(),
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('ObjectEvent');
      expect(stub.calls[0].method).toBe('GET');
      const url = new URL(`http://x${stub.calls[0].url}`);
      expect(url.pathname).toBe('/api/epcis/events');
      expect(url.searchParams.get('contextGraphId')).toBe('cg-1');
      expect(url.searchParams.get('subGraphName')).toBe('research');
      expect(url.searchParams.get('finalized')).toBe('false');
      expect(url.searchParams.get('epc')).toBe('urn:epc:id:sgtin:1.2.3');
      expect(url.searchParams.get('bizStep')).toBe('https://ref.gs1.org/cbv/BizStep-receiving');
      expect(url.searchParams.get('eventType')).toBe('ObjectEvent');
      expect(url.searchParams.get('action')).toBe('ADD');
      expect(url.searchParams.get('perPage')).toBe('10');
    });

    it('rejects --finalized with non-boolean values (exit 1)', async () => {
      const result = await runCli(['epcis', 'query', '--finalized', 'yeah'], env());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid --finalized');
    });

    it('rejects --per-page with non-positive integers (exit 1)', async () => {
      const result = await runCli(['epcis', 'query', '--per-page', '0'], env());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid --per-page');
    });

    it('without --all: prints first page + nextPageUrl when Link is present', async () => {
      clearCalls();
      const linkValue =
        '</api/epcis/events?contextGraphId=cg-1&perPage=1&nextPageToken=b2Zmc2V0OjE=>; rel="next"';
      stub.setHandler(() => ({
        status: 200,
        body: {
          '@context': [],
          type: 'EPCISQueryDocument',
          schemaVersion: '2.0',
          epcisBody: { queryResults: { queryName: 'SimpleEventQuery', resultsBody: { eventList: [{ type: 'ObjectEvent' }] } } },
        },
        headers: { Link: linkValue },
      }));
      const result = await runCli(
        ['epcis', 'query', '--context-graph-id', 'cg-1', '--per-page', '1'],
        env(),
      );
      expect(result.exitCode).toBe(0);
      expect(stub.calls).toHaveLength(1);
      const out = JSON.parse(result.stdout);
      expect(out.nextPageUrl).toBe('/api/epcis/events?contextGraphId=cg-1&perPage=1&nextPageToken=b2Zmc2V0OjE=');
      expect(out.epcisBody.queryResults.resultsBody.eventList).toHaveLength(1);
    });

    it('with --all: follows Link: rel="next" pages and merges eventList', async () => {
      clearCalls();
      let pageIdx = 0;
      stub.setHandler(() => {
        pageIdx += 1;
        if (pageIdx === 1) {
          return {
            status: 200,
            body: {
              '@context': [],
              type: 'EPCISQueryDocument',
              schemaVersion: '2.0',
              epcisBody: {
                queryResults: { queryName: 'SimpleEventQuery', resultsBody: { eventList: [{ id: 1 }] } },
              },
            },
            headers: { Link: '</api/epcis/events?cursor=2>; rel="next"' },
          };
        }
        if (pageIdx === 2) {
          return {
            status: 200,
            body: {
              '@context': [],
              type: 'EPCISQueryDocument',
              schemaVersion: '2.0',
              epcisBody: {
                queryResults: { queryName: 'SimpleEventQuery', resultsBody: { eventList: [{ id: 2 }] } },
              },
            },
            headers: { Link: '</api/epcis/events?cursor=3>; rel="next"' },
          };
        }
        return {
          status: 200,
          body: {
            '@context': [],
            type: 'EPCISQueryDocument',
            schemaVersion: '2.0',
            epcisBody: {
              queryResults: { queryName: 'SimpleEventQuery', resultsBody: { eventList: [{ id: 3 }] } },
            },
          },
        };
      });
      const result = await runCli(
        ['epcis', 'query', '--context-graph-id', 'cg-1', '--all'],
        env(),
      );
      expect(result.exitCode).toBe(0);
      expect(stub.calls).toHaveLength(3);
      expect(stub.calls[1].url).toBe('/api/epcis/events?cursor=2');
      expect(stub.calls[2].url).toBe('/api/epcis/events?cursor=3');
      const out = JSON.parse(result.stdout);
      expect(out.epcisBody.queryResults.resultsBody.eventList).toEqual([
        { id: 1 }, { id: 2 }, { id: 3 },
      ]);
    });

    it('with --all: fails fast on a malformed follow-up page instead of silently dropping it', async () => {
      clearCalls();
      let pageIdx = 0;
      stub.setHandler(() => {
        pageIdx += 1;
        if (pageIdx === 1) {
          return {
            status: 200,
            body: {
              '@context': [],
              type: 'EPCISQueryDocument',
              schemaVersion: '2.0',
              epcisBody: {
                queryResults: { queryName: 'SimpleEventQuery', resultsBody: { eventList: [{ id: 1 }] } },
              },
            },
            headers: { Link: '</api/epcis/events?cursor=2>; rel="next"' },
          };
        }
        return {
          status: 200,
          body: { type: 'EPCISQueryDocument', epcisBody: { queryResults: { resultsBody: {} } } },
        };
      });
      const result = await runCli(
        ['epcis', 'query', '--context-graph-id', 'cg-1', '--all'],
        env(),
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('page 2 response shape unexpected');
    });

    it('maps 400 InvalidContent to exit code 2', async () => {
      clearCalls();
      stub.setHandler(() => ({ status: 400, body: { error: 'Bad bizStep' } }));
      const result = await runCli(
        ['epcis', 'query', '--context-graph-id', 'cg-1', '--biz-step', 'https://example.com'],
        env(),
      );
      expect(result.exitCode).toBe(2);
    });
  });
});
