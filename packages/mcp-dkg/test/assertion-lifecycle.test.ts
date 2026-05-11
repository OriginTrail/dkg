import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerAssertionTools } from '../src/tools/assertions.js';
import { FakeServer, FakeClient, makeConfig } from './harness.js';

describe('assertion CRUD quintet — round-trip with @en literal preservation', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    registerAssertionTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
  });

  it('registers all seven assertion-family tools', () => {
    const expected = [
      'dkg_assertion_create',
      'dkg_assertion_write',
      'dkg_assertion_promote',
      'dkg_assertion_discard',
      'dkg_assertion_query',
      'dkg_assertion_import_file',
      'dkg_assertion_history',
    ];
    for (const name of expected) {
      expect(server.tools.has(name)).toBe(true);
    }
  });

  it('round-trips create → write → promote → query, preserving @en language tags on literals', async () => {
    const created = await server.call('dkg_assertion_create', { name: 'session-2026' });
    expect(created.isError).toBeFalsy();
    expect(created.content[0].text).toMatch(/Created assertion 'session-2026'/);

    const langTagged = '"hello world"@en';
    const written = await server.call('dkg_assertion_write', {
      name: 'session-2026',
      quads: [
        { subject: 'urn:x:1', predicate: 'urn:p:label', object: langTagged },
        { subject: 'urn:x:1', predicate: 'urn:p:type', object: 'urn:Note' },
      ],
    });
    expect(written.isError).toBeFalsy();
    expect(written.content[0].text).toMatch(/Wrote 2 quad\(s\)/);

    const promoted = await server.call('dkg_assertion_promote', {
      name: 'session-2026',
      entities: ['urn:x:1'],
    });
    expect(promoted.isError).toBeFalsy();
    expect(promoted.content[0].text).toMatch(/Promoted 1 entity/);

    const queried = await server.call('dkg_assertion_query', { name: 'session-2026' });
    expect(queried.isError).toBeFalsy();
    expect(queried.content[0].text).toMatch(/2 quad\(s\)/);
    // @en lang-tag must round-trip byte-for-byte through the JSON dump.
    // The dump uses JSON.stringify so inner double-quotes are escaped to
    // \" — assert against the encoded form here, and against the
    // unescaped form on the raw stored quad below.
    expect(queried.content[0].text).toContain('\\"hello world\\"@en');

    const cell = client.assertions.get('test-cg::session-2026');
    expect(cell).toBeDefined();
    expect(cell!.quads).toHaveLength(2);
    expect(cell!.promotedRoots.has('urn:x:1')).toBe(true);
    // Object stored verbatim — language-tagged literal is preserved on
    // both the wire and in the memory fixture.
    expect(cell!.quads[0].object).toBe(langTagged);
  });

  it('create is idempotent: a duplicate name reports alreadyExists rather than erroring', async () => {
    await server.call('dkg_assertion_create', { name: 'dupe' });
    const second = await server.call('dkg_assertion_create', { name: 'dupe' });
    expect(second.isError).toBeFalsy();
    expect(second.content[0].text).toMatch(/already exists/);
  });

  it('rejects bad assertion-name slugs at the schema layer (zod regex)', async () => {
    await expect(
      server.call('dkg_assertion_create', { name: 'Invalid Name With Spaces' }),
    ).rejects.toThrow();
  });

  it('write requires a non-empty quads array', async () => {
    await server.call('dkg_assertion_create', { name: 'empty' });
    await expect(
      server.call('dkg_assertion_write', { name: 'empty', quads: [] }),
    ).rejects.toThrow();
  });

  it('promote rejects an empty entities array (must be omitted or non-empty)', async () => {
    await server.call('dkg_assertion_create', { name: 'rollback' });
    await server.call('dkg_assertion_write', {
      name: 'rollback',
      quads: [{ subject: 'urn:r', predicate: 'urn:p', object: '"v"' }],
    });
    const result = await server.call('dkg_assertion_promote', {
      name: 'rollback',
      entities: [],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/non-empty array/);
  });

  it('discard marks the assertion discarded; subsequent writes fail', async () => {
    await server.call('dkg_assertion_create', { name: 'rollback' });
    await server.call('dkg_assertion_discard', { name: 'rollback' });
    expect(client.assertions.get('test-cg::rollback')!.discarded).toBe(true);
    const writeAfterDiscard = await server.call('dkg_assertion_write', {
      name: 'rollback',
      quads: [{ subject: 'urn:r', predicate: 'urn:p', object: '"v"' }],
    });
    expect(writeAfterDiscard.isError).toBe(true);
  });

  it('query without a project returns the canonical "no project specified" hint', async () => {
    const noProjectServer = new FakeServer();
    const noProjectClient = new FakeClient();
    registerAssertionTools(
      noProjectServer.asMcpServer(),
      noProjectClient.asDkgClient(),
      makeConfig({ defaultProject: null }),
    );
    const result = await noProjectServer.call('dkg_assertion_query', { name: 'x' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/No project specified/);
  });
});

describe('dkg_assertion_import_file — wave-2 P1 add', () => {
  let server: FakeServer;
  let client: FakeClient;
  let tempDir: string;

  beforeEach(async () => {
    server = new FakeServer();
    client = new FakeClient();
    registerAssertionTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
    tempDir = await mkdtemp(path.join(tmpdir(), 'dkg-mcp-test-'));
  });

  it('reads a local markdown file and forwards it to the daemon with inferred MIME', async () => {
    const filePath = path.join(tempDir, 'notes.md');
    await writeFile(filePath, '# Hello\n\nA short markdown doc.\n', 'utf-8');

    const captured: Record<string, unknown> = {};
    client = new FakeClient({
      importAssertionFile: async (args) => {
        captured.assertionName = args.assertionName;
        captured.contentType = args.contentType;
        captured.fileName = args.fileName;
        captured.bytes = args.fileBuffer.byteLength;
        return { extraction: { status: 'completed', tripleCount: 3 } };
      },
    });
    const localServer = new FakeServer();
    registerAssertionTools(localServer.asMcpServer(), client.asDkgClient(), makeConfig());

    const result = await localServer.call('dkg_assertion_import_file', {
      name: 'imported',
      filePath,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Imported 'notes\.md'/);
    expect(result.content[0].text).toMatch(/3 triple\(s\)/);
    expect(captured.contentType).toBe('text/markdown');
    expect(captured.fileName).toBe('notes.md');

    await rm(tempDir, { recursive: true, force: true });
  });

  it('surfaces a tool error when the file path does not exist', async () => {
    const result = await server.call('dkg_assertion_import_file', {
      name: 'missing',
      filePath: path.join(tempDir, 'no-such-file.md'),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Failed to read file/);

    await rm(tempDir, { recursive: true, force: true });
  });
});

describe('dkg_assertion_history — wave-2 P3 add', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    registerAssertionTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
  });

  it('returns the lifecycle JSON block for a known assertion', async () => {
    const result = await server.call('dkg_assertion_history', { name: 'session-2026' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/History for assertion 'session-2026'/);
    expect(result.content[0].text).toContain('"author": "urn:dkg:agent:test"');
  });
});
