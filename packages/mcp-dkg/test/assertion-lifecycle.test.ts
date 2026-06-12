/**
 * Assertion tool family — surface-shape + pre-network guard tests.
 *
 * NO MOCKS. The retired version of this file drove the full CRUD lifecycle
 * against an in-memory `FakeClient` whose canned answers could (and did)
 * drift from real daemon semantics. The behavioural lifecycle now lives in
 * `mcp-tool-surface.integration.test.ts` (gated, real daemon): create →
 * write(@en) → query → promote → history → import-file → discard, plus the
 * imported-artifact trio (resolve / read-markdown / semantic-enrichment)
 * round-tripping real stored bytes, plus the daemon-409 idempotency of
 * create. MIME inference for imports is proven there too (a text/markdown
 * import whose bytes read back from the content-addressed store).
 *
 * What stays HERE is everything that is real WITHOUT a daemon:
 *   - tool registration (the register fn runs for real; the REAL `DkgClient`
 *     it binds is never invoked),
 *   - zod schema contracts via `FakeServer.parse` (schema-only — no handler,
 *     no network),
 *   - handler guards that return BEFORE any client call (missing project,
 *     unreadable file path, empty `entities`), asserted by invoking the REAL
 *     handler wired to a REAL client that the guard prevents from ever being
 *     reached — if the guard regresses, the test fails with a connection
 *     error instead of silently passing against a double.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerAssertionTools } from '../src/tools/assertions.js';
import { FakeServer, liveSurface, liveConfig } from './live.js';
import { DkgClient } from '../src/client.js';

describe('assertion tool family — registration + schema surface', () => {
  let server: FakeServer;

  beforeEach(() => {
    ({ server } = liveSurface([
      (mcp, client, config) => registerAssertionTools(mcp as never, client, config),
    ]));
  });

  it('registers all ten assertion-family tools', () => {
    const expected = [
      'dkg_assertion_create',
      'dkg_assertion_write',
      'dkg_assertion_promote',
      'dkg_assertion_discard',
      'dkg_assertion_query',
      'dkg_import_artifact_resolve',
      'dkg_import_artifact_read_markdown',
      'dkg_semantic_enrichment_write',
      'dkg_assertion_import_file',
      'dkg_assertion_history',
    ];
    for (const name of expected) {
      expect(server.tools.has(name)).toBe(true);
    }
  });

  it('documents canonical context graph ids for assertion write tools', () => {
    for (const name of [
      'dkg_assertion_create',
      'dkg_assertion_write',
      'dkg_assertion_promote',
      'dkg_assertion_discard',
      'dkg_assertion_query',
    ]) {
      const projectId = server.get(name).config.inputSchema?.projectId;
      expect(projectId?.description).toContain('dkg_list_context_graphs');
      expect(projectId?.description).toContain('local-notes');
      expect(projectId?.description).toContain('<curatorAddress>/<slug>');
      expect(projectId?.description).toContain('Do not guess');
    }
  });

  it('does not expose a target assertion name on the semantic enrichment schema', () => {
    const tool = server.tools.get('dkg_semantic_enrichment_write');
    expect(tool).toBeTruthy();
    expect(tool!.config.description).toMatch(/Append model-derived semantic triples/);
    expect(tool!.config.description).not.toMatch(/separate Working Memory assertion/);
    expect(tool!.config.inputSchema).not.toHaveProperty('name');
  });

  // ── zod-layer contracts (schema-only via FakeServer.parse: the REAL
  // declared inputSchema runs, no handler / no network) ───────────────
  it('zod rejects semantic enrichment quads that try to set a graph (.strict())', () => {
    expect(() =>
      server.parse('dkg_semantic_enrichment_write', {
        assertionUri: 'did:dkg:context-graph:x/assertion/a/doc',
        semanticQuads: [
          { subject: 'urn:s', predicate: 'urn:p', object: '"v"', graph: 'urn:dkg:graph:forged' },
        ],
      }),
    ).toThrow();
  });

  it('zod rejects bad assertion-name slugs on create', () => {
    expect(() => server.parse('dkg_assertion_create', { name: 'Invalid Name With Spaces' })).toThrow();
  });

  it('zod requires a non-empty quads array on write', () => {
    expect(() => server.parse('dkg_assertion_write', { name: 'empty', quads: [] })).toThrow();
  });
});

describe('assertion tool family — pre-network handler guards (real handler, real client, guard fires first)', () => {
  it('promote rejects an empty entities array before any client call', async () => {
    const { server } = liveSurface([
      (mcp, client, config) => registerAssertionTools(mcp as never, client, config),
    ]);
    const result = await server.call('dkg_assertion_promote', {
      name: 'rollback',
      entities: [],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/non-empty array/);
  });

  it('query without a project returns the canonical "no project specified" hint', async () => {
    const config = liveConfig({ defaultProject: null });
    const client = new DkgClient({ config });
    const server = new FakeServer();
    registerAssertionTools(server.asMcpServer(), client, config);
    const result = await server.call('dkg_assertion_query', { name: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No project specified/);
  });

  it('import-file surfaces a tool error when the file path does not exist', async () => {
    const { server } = liveSurface([
      (mcp, client, config) => registerAssertionTools(mcp as never, client, config),
    ]);
    const tempDir = await mkdtemp(path.join(tmpdir(), 'dkg-mcp-test-'));
    try {
      const result = await server.call('dkg_assertion_import_file', {
        name: 'missing',
        filePath: path.join(tempDir, 'no-such-file.md'),
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/Failed to read file/);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
