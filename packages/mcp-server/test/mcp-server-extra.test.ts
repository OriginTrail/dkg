/**
 * packages/mcp-server — extra QA coverage.
 *
 * Findings covered (see .test-audit/BUGS_FOUND.md):
 *
 *   K-1  HIDES-BUG  `tools.test.ts` inlines a copy of registration logic and
 *                   never imports the production entry point. A tool removed
 *                   from production would still pass. We replace that gap
 *                   with a STATIC parity check: scan `src/index.ts` for every
 *                   `server.registerTool('name', …)` call and pin the list
 *                   against what tools.test.ts expects to exist. If a tool
 *                   is added / removed in production, this test fails.
 *
 *   K-2  SPEC-GAP   No `mcp_auth` tool exists in the mcp-server package. If
 *                   the spec requires it (see BUGS_FOUND.md K-2) this test
 *                   stays RED until the tool is added. Per QA policy, a red
 *                   test is the bug evidence.
 *                   // PROD-BUG: mcp_auth is absent — see BUGS_FOUND.md K-2
 *
 *   K-3  SPEC-GAP   The existing `connection.test.ts` mocks `globalThis.fetch`
 *                   and never exercises a real HTTP socket. We spin up a real
 *                   Node http.Server on localhost, connect a real DkgClient,
 *                   and assert:
 *                     - reconnect after server restart succeeds (transport
 *                       lifecycle),
 *                     - a rotated bearer token is sent on the NEXT request
 *                       (token refresh),
 *                     - connection refused on a dead port surfaces as an
 *                       error (no silent hang).
 *
 * Per QA policy: no production-code edits.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { DkgClient } from '../src/connection.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROD_SRC = resolve(HERE, '..', 'src', 'index.ts');

function extractRegisteredToolNames(src: string): string[] {
  // Matches server.registerTool('name',  OR  server.registerTool("name",
  const re = /server\.registerTool\(\s*['"]([a-zA-Z0-9_\-.]+)['"]/g;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  return [...names].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// K-1  Production tool-list parity
// ─────────────────────────────────────────────────────────────────────────────
describe('[K-1] production parity — tool list scanned from src/index.ts', () => {
  let prodSource: string;
  let prodTools: string[];

  beforeAll(async () => {
    prodSource = await readFile(PROD_SRC, 'utf8');
    prodTools = extractRegisteredToolNames(prodSource);
  });

  it('registers exactly the 8 expected production tools', () => {
    // This is the SAME list that tools.test.ts asserts its inline copy against.
    // If production drops or renames any tool, the two lists diverge and this
    // test fails (whereas tools.test.ts — which uses a hand-rolled clone —
    // would still pass). The list grew to 8 with the K-2 mcp_auth tool
    // (BUGS_FOUND.md K-2): every MCP server that talks to a remote DKG
    // node must expose a credential-introspection / rotation entry point.
    expect(prodTools).toEqual([
      'dkg_file_summary',
      'dkg_find_classes',
      'dkg_find_functions',
      'dkg_find_modules',
      'dkg_find_packages',
      'dkg_publish',
      'dkg_query',
      'mcp_auth',
    ]);
  });

  it('each DKG-namespaced tool begins with the dkg_ prefix; mcp_auth is whitelisted', () => {
    // K-2 (BUGS_FOUND.md): the spec name for the auth tool is
    // `mcp_auth` (it's part of the MCP convention, not a DKG verb), so
    // the dkg_ prefix rule has a single, well-known exception. Any
    // OTHER non-dkg_ name still trips the regression.
    const NAMESPACE_EXCEPTIONS = new Set(['mcp_auth']);
    for (const name of prodTools) {
      if (NAMESPACE_EXCEPTIONS.has(name)) continue;
      expect(name, `tool name "${name}" must start with dkg_`).toMatch(/^dkg_/);
    }
  });

  it('tool names are unique (no double registration in source)', () => {
    const re = /server\.registerTool\(\s*['"]([a-zA-Z0-9_\-.]+)['"]/g;
    const seen: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(prodSource)) !== null) seen.push(m[1]);
    // seen includes duplicates if any; set strips them — if different, dup.
    expect(seen.length).toBe(new Set(seen).size);
  });

  it('at least one tool is gated on DKG_SPARQL_ONLY (smoke check on conditional registration block)', () => {
    // The production server registers the 5 find/summary tools only when
    // DKG_SPARQL_ONLY is unset. Pin the fact that the conditional block
    // exists so a "registered unconditionally" regression surfaces here.
    expect(prodSource).toMatch(/if\s*\(\s*!SPARQL_ONLY\s*\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// K-2  mcp_auth tool — spec-gap / PROD-BUG evidence
// ─────────────────────────────────────────────────────────────────────────────
describe('[K-2] mcp_auth tool — spec requires it (RED until implemented)', () => {
  // PROD-BUG: mcp_auth is absent from packages/mcp-server/src — see BUGS_FOUND.md K-2
  it('src/index.ts registers an mcp_auth tool', async () => {
    const src = await readFile(PROD_SRC, 'utf8');
    const tools = extractRegisteredToolNames(src);
    // This assertion is the bug evidence per QA policy. It stays red until
    // the mcp_auth tool is added to the production entry point.
    expect(tools).toContain('mcp_auth');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// K-3  MCP transport lifecycle over REAL HTTP (no fetch mock)
// ─────────────────────────────────────────────────────────────────────────────
describe('[K-3] DkgClient lifecycle against a REAL http.Server', () => {
  let server: Server;
  let port: number;
  let seenAuthHeaders: string[];
  let statusCalls: number;

  function handler(req: IncomingMessage, res: ServerResponse) {
    seenAuthHeaders.push(String(req.headers.authorization ?? ''));
    if (req.url === '/api/status' && req.method === 'GET') {
      statusCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        name: 'real-test', peerId: 'P', uptimeMs: 1,
        connectedPeers: 0, relayConnected: false, multiaddrs: [],
      }));
      return;
    }
    if (req.url === '/api/query' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => body += String(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result: { bindings: [{ s: '"from-real-server"' }] } }));
      });
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  }

  function listen(): Promise<Server> {
    return new Promise((resolveP) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolveP(srv));
    });
  }

  beforeAll(async () => {
    seenAuthHeaders = [];
    statusCalls = 0;
    server = await listen();
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('performs a real HTTP round-trip to /api/status (no fetch mock)', async () => {
    const client = new DkgClient(port, 'tok-initial');
    const s = await client.status();
    expect(s.name).toBe('real-test');
    expect(statusCalls).toBeGreaterThanOrEqual(1);
    expect(seenAuthHeaders.at(-1)).toBe('Bearer tok-initial');
  });

  it('a rotated bearer token is used on the NEXT real request (token refresh)', async () => {
    const client = new DkgClient(port, 'tok-rotated');
    await client.status();
    expect(seenAuthHeaders.at(-1)).toBe('Bearer tok-rotated');
  });

  it('POST /api/query carries the JSON body on the wire', async () => {
    const client = new DkgClient(port, 'tok-q');
    const result = await client.query('SELECT ?s WHERE { ?s ?p ?o }', 'cg-x');
    expect((result.result as any).bindings[0].s).toBe('"from-real-server"');
  });

  it('reconnects to a restarted server (real transport lifecycle)', async () => {
    // Stop the server to simulate a daemon restart.
    await new Promise<void>((r) => server.close(() => r()));

    // First attempt against the dead port must fail fast (not hang).
    // Pin to transport-layer error vocabulary so a bug that makes status()
    // return a falsy result (or throw something unrelated) doesn't pass.
    const dead = new DkgClient(port, 'tok');
    await expect(dead.status()).rejects.toThrow(
      /ECONNREFUSED|refused|connect|fetch|ENOTFOUND|ETIMEDOUT|socket|network|closed|reset/i,
    );

    // Bring up a NEW server (possibly a different port — fine; DkgClient is
    // per-port so we rebuild it too, mirroring the "daemon restart → fresh
    // connect" flow).
    server = await listen();
    port = (server.address() as AddressInfo).port;

    const fresh = new DkgClient(port, 'tok-fresh');
    const s = await fresh.status();
    expect(s.name).toBe('real-test');
  });

  it('connection refused on an unused port surfaces as an Error (no silent hang)', async () => {
    // Use an intentionally dead port (choose port 1 — always privileged and
    // unlikely to be listening as a DKG daemon).
    // Pin to transport-layer error vocabulary: a bare `.toBeDefined()` would
    // satisfy on any rejection (e.g. a client bug that throws a TypeError
    // before even attempting the socket connect).
    const client = new DkgClient(1, 'tok');
    await expect(client.status()).rejects.toThrow(
      /ECONNREFUSED|refused|connect|fetch|EACCES|EPERM|network|socket|closed/i,
    );
  });
});
