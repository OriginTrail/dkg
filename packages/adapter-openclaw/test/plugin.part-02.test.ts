import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { homedir, tmpdir } from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { toEip55Checksum } from '@origintrail-official/dkg-core';
import { DkgNodePlugin } from '../src/DkgNodePlugin.js';
import { DkgChannelPlugin } from '../src/DkgChannelPlugin.js';
import { ChatTurnWriter } from '../src/ChatTurnWriter.js';
import { INTERNAL_HOOK_SYMBOL } from '../src/HookSurface.js';
import type { OpenClawPluginApi, OpenClawTool } from '../src/types.js';

describe("DkgNodePlugin", () => {
  describe("handler-level drift guards: snake_case args → camelCase daemon body", () => {

    const setupPluginWithFetch = (
      response: unknown = {},
      opts: { skipNodeIdInjection?: boolean } = {},
    ) => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      // Most handler tests assume the node identity has resolved (e.g. dkg_share
      // builds canned-quad subjects from it). Inject a placeholder address so
      // tests don't have to mock the daemon /api/status probe end-to-end. Pass
      // `skipNodeIdInjection: true` to exercise the unresolved-identity branch.
      if (!opts.skipNodeIdInjection) {
        (plugin as any).nodePeerId = '12D3KooTestPeerId';
      }
      const byName = new Map(tools.map((t) => [t.name, t] as const));
      return { fetchMock, plugin, byName };
    };


    const originalFetch = globalThis.fetch;


    it('dkg_knowledge_asset_import_file infers content-type for common formats (kept in sync with CLI UPLOAD_CONTENT_TYPES)', async () => {
      const { writeFileSync, mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');

      const cases: Array<[string, string]> = [
        ['doc.pdf', 'application/pdf'],
        ['doc.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
        ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        ['page.html', 'text/html'],
        ['page.htm', 'text/html'],
        ['feed.xml', 'application/xml'],
        ['book.epub', 'application/epub+zip'],
        ['notes.txt', 'text/plain'],
        ['data.csv', 'text/csv'],
        ['config.json', 'application/json'],
      ];

      for (const [fileName, expectedMime] of cases) {
        const { fetchMock, byName } = setupPluginWithFetch({ assertionUri: 'urn:x' });
        const tmpDir = mkdtempSync(join(tmpdir(), 'dkg-mime-'));
        const filePath = join(tmpDir, fileName);
        writeFileSync(filePath, 'dummy');
        await byName.get('dkg_knowledge_asset_import_file')!.execute('tc', {
          context_graph_id: 'ctx',
          name: 'notes',
          file_path: filePath,
        });
        const form = fetchMock.mock.calls[0][1]?.body as FormData;
        expect(form.get('contentType'), `${fileName} should infer ${expectedMime}`).toBe(expectedMime);
      }
    });


    it('dkg_knowledge_asset_import_file falls through to octet-stream for unknown extensions (no contentType form field)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ assertionUri: 'urn:x' });
      const { writeFileSync, mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const tmpDir = mkdtempSync(join(tmpdir(), 'dkg-unknown-'));
      const filePath = join(tmpDir, 'blob.xyz');
      writeFileSync(filePath, 'dummy');
      await byName.get('dkg_knowledge_asset_import_file')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        file_path: filePath,
      });
      const form = fetchMock.mock.calls[0][1]?.body as FormData;
      // Handler left contentType undefined → client does NOT append the form field,
      // daemon falls through to the Blob's default 'application/octet-stream' type.
      expect(form.has('contentType')).toBe(false);
    });


    it('dkg_sub_graph_create forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ created: 'protocols', contextGraphId: 'ctx' });
      await byName.get('dkg_sub_graph_create')!.execute('tc', {
        context_graph_id: 'ctx',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/sub-graph/create');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        subGraphName: 'protocols',
      });
    });


    it('dkg_sub_graph_list forwards snake_case → camelCase query param (GET, no body)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ contextGraphId: 'ctx', subGraphs: [] });
      await byName.get('dkg_sub_graph_list')!.execute('tc', { context_graph_id: 'ctx' });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/sub-graph/list');
      expect(parsed.searchParams.get('contextGraphId')).toBe('ctx');
      expect(init.body).toBeUndefined();
    });


    it('dkg_shared_memory_publish forwards snake_case → camelCase body with selection="all" when omitted', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ kaId: 'kc-1', status: 'ok', kas: [] });
      await byName.get('dkg_shared_memory_publish')!.execute('tc', { context_graph_id: 'ctx' });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/shared-memory/publish');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ contextGraphId: 'ctx', selection: 'all', clearAfter: true });
    });


    it('dkg_shared_memory_publish forwards explicit root_entities as selection array with clearAfter=false (subset safety default)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ kaId: 'kc-2', status: 'ok', kas: [] });
      await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        root_entities: ['urn:a', 'urn:b'],
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      // Subset publishes default to clearAfter=false so roots NOT in `selection`
      // aren't clobbered as a side-effect of publishing a subset.
      expect(body).toEqual({ contextGraphId: 'ctx', selection: ['urn:a', 'urn:b'], clearAfter: false });
    });


    it('dkg_shared_memory_publish plumbs sub_graph_name through to subGraphName for sub-graph-scoped publishes', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ kaId: 'kc-5', status: 'ok', kas: [] });
      await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        sub_graph_name: 'protocols',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      // Without this, an agent that created/wrote/promoted into a sub-graph
      // would publish to the root shared-memory graph instead of the sub-graph.
      expect(body.subGraphName).toBe('protocols');
      expect(body.contextGraphId).toBe('ctx');
    });


    it('dkg_shared_memory_publish can register the context graph before publish when requested', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url === 'http://localhost:9200/api/context-graph/register') {
          return new Response(JSON.stringify({ registered: 'ctx', onChainId: '42', txHash: '0xabc' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ kaId: 'kc-7', status: 'ok', kas: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const byName = new Map(tools.map((t) => [t.name, t] as const));

      const result = await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        register_if_needed: true,
        reveal_on_chain: true,
        access_policy: 1,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:9200/api/context-graph/register');
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({
        id: 'ctx',
        accessPolicy: 1,
      });
      expect(fetchMock.mock.calls[1]?.[0]).toBe('http://localhost:9200/api/shared-memory/publish');
      const body = JSON.parse(result.content[0].text);
      expect(body.registration).toEqual({ registered: 'ctx', onChainId: '42', txHash: '0xabc' });
      expect(body.kaId).toBe('kc-7');
    });


    it('dkg_shared_memory_publish ignores already-registered conflicts and still publishes', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url === 'http://localhost:9200/api/context-graph/register') {
          return new Response(JSON.stringify({ error: 'Context graph "ctx" is already registered on-chain (42)' }), {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ kaId: 'kc-8', status: 'ok', kas: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const byName = new Map(tools.map((t) => [t.name, t] as const));

      const result = await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        register_if_needed: true,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const body = JSON.parse(result.content[0].text);
      expect(body.registration).toBeUndefined();
      expect(body.kaId).toBe('kc-8');
    });


    it('dkg_shared_memory_publish validates register_if_needed and registration options locally', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({});
      const bad = await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        register_if_needed: 'yes',
        reveal_on_chain: 'yes',
        access_policy: 3,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(bad.content[0].text).toContain('register_if_needed');

      const badReveal = await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        reveal_on_chain: 'yes',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(badReveal.content[0].text).toContain('reveal_on_chain');
    });


    it('dkg_shared_memory_publish rejects non-array / empty / non-string root_entities locally', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({});
      const bad = await byName.get('dkg_shared_memory_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        root_entities: 'all', // Agents must send an array, never a bare string.
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(bad.content[0].text).toContain('root_entities');
      expect(bad.content[0].text).toContain('non-empty array');
    });


    it('dkg_share is registered with required content and context_graph_id', () => {
      const { byName } = setupPluginWithFetch({});
      const tool = byName.get('dkg_share');
      expect(tool).toBeDefined();
      expect(tool!.parameters.required).toEqual(['content', 'context_graph_id']);
      const props = tool!.parameters.properties;
      expect(props.content?.type).toBe('string');
      expect(props.context_graph_id?.type).toBe('string');
      expect(props.sub_graph_name?.type).toBe('string');
    });


    it('dkg_share rejects non-string content/context_graph_id/sub_graph_name without coercing', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-types' });
      // Without explicit type checks, `String(args.content ?? '')` would coerce
      // {} → "[object Object]" and false → "false" — silently polluting SWM
      // with garbage. Validate at the runtime boundary instead.
      const objContent = await byName.get('dkg_share')!.execute('tc', { content: {}, context_graph_id: 'ctx' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(objContent.content[0].text).toContain('content');

      const boolContent = await byName.get('dkg_share')!.execute('tc', { content: false, context_graph_id: 'ctx' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(boolContent.content[0].text).toContain('content');

      const objCg = await byName.get('dkg_share')!.execute('tc', { content: 'x', context_graph_id: { id: 'ctx' } });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(objCg.content[0].text).toContain('context_graph_id');

      const numSub = await byName.get('dkg_share')!.execute('tc', {
        content: 'x', context_graph_id: 'ctx', sub_graph_name: 42,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(numSub.content[0].text).toContain('sub_graph_name');
    });


    it('dkg_share rejects missing/empty content without making a daemon call', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-1' });
      const result = await byName.get('dkg_share')!.execute('tc', { context_graph_id: 'ctx' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('content');

      const blank = await byName.get('dkg_share')!.execute('tc', { content: '   ', context_graph_id: 'ctx' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(blank.content[0].text).toContain('content');
    });


    it('dkg_share rejects missing/empty context_graph_id without making a daemon call', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-2' });
      const result = await byName.get('dkg_share')!.execute('tc', { content: 'fact' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('context_graph_id');
    });


    it('dkg_share forwards content as a canned quad to /api/shared-memory/write with localOnly=false', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-3' });
      await byName.get('dkg_share')!.execute('tc', {
        content: 'hello',
        context_graph_id: 'ctx',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/shared-memory/write');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.contextGraphId).toBe('ctx');
      expect(body.localOnly).toBe(false);
      expect(body.subGraphName).toBeUndefined();
      expect(body.quads).toHaveLength(1);
      const [quad] = body.quads;
      // Subject ends with a unique shareId suffix so the publisher's
      // delete-then-insert upsert doesn't replace prior shares.
      expect(quad.subject).toMatch(/^urn:openclaw:.+:shared:\d+-[a-z0-9]+$/);
      expect(quad.predicate).toBe('urn:openclaw:sharedContent');
      // Object is N-Triples-quoted so the storage formatTerm doesn't
      // IRI-encode the unquoted text.
      expect(quad.object).toBe('"hello"');
    });


    it('dkg_share returns the minted subject and snake_case root_entities in the tool response', async () => {
      // Field name is snake_case to match the consuming tool's argument
      // shape — agents chaining dkg_share → dkg_shared_memory_publish
      // ({ root_entities: ... }) can pass the value through unchanged.
      const { byName } = setupPluginWithFetch({ shareOperationId: 'op-resp' });
      const result = await byName.get('dkg_share')!.execute('tc', {
        content: 'targetable',
        context_graph_id: 'ctx',
      });
      const body = JSON.parse(result.content[0].text);
      expect(body.shareOperationId).toBe('op-resp');
      expect(body.subject).toMatch(/^urn:openclaw:.+:shared:\d+-[a-z0-9]+$/);
      expect(body.root_entities).toEqual([body.subject]);
      expect(body.rootEntities).toBeUndefined();
    });


    it('dkg_share mints a unique subject per call so successive shares do not upsert', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-multi' });
      await byName.get('dkg_share')!.execute('tc', { content: 'one', context_graph_id: 'ctx' });
      await byName.get('dkg_share')!.execute('tc', { content: 'two', context_graph_id: 'ctx' });
      const subjA = JSON.parse(fetchMock.mock.calls[0][1]?.body as string).quads[0].subject;
      const subjB = JSON.parse(fetchMock.mock.calls[1][1]?.body as string).quads[0].subject;
      expect(subjA).not.toBe(subjB);
      expect(subjA).toMatch(/^urn:openclaw:.+:shared:\d+-[a-z0-9]+$/);
      expect(subjB).toMatch(/^urn:openclaw:.+:shared:\d+-[a-z0-9]+$/);
    });


    it('dkg_share escapes the full N-Triples control-char set when building the literal', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-escape' });
      // Cover \\, ", \n, \r, \t, \f, \b — the canonical escaper from
      // @origintrail-official/dkg-core handles all seven.
      await byName.get('dkg_share')!.execute('tc', {
        content: 'a\nb\rc\td\fe\bf "q" \\ end',
        context_graph_id: 'ctx',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.quads[0].object).toBe('"a\\nb\\rc\\td\\fe\\bf \\"q\\" \\\\ end"');
    });


    it('dkg_share preserves leading/trailing whitespace in content (no silent trim)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-ws' });
      // Agents sharing code snippets or exact transcripts must get byte-for-byte
      // round-tripping. Trimming for serialization would silently drop terminal
      // newlines and indentation. Validation still rejects whitespace-only.
      await byName.get('dkg_share')!.execute('tc', {
        content: '  function f() {\n  return 1;\n}\n',
        context_graph_id: 'ctx',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      // Quoted, with the leading two spaces, embedded newlines, and trailing newline preserved.
      expect(body.quads[0].object).toBe('"  function f() {\\n  return 1;\\n}\\n"');

      const blank = await byName.get('dkg_share')!.execute('tc', {
        content: '   \n   ',
        context_graph_id: 'ctx',
      });
      expect(blank.content[0].text).toContain('content');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });


    it('dkg_share falls back to direct /api/agent/identity probe when the memory resolver is disabled', async () => {
      // With `memory.enabled: false` the memory resolver API never registers,
      // so ensureNodeAgentAddress/ensureNodePeerId both no-op (memoryResolverApi
      // stays null). dkg_share writes to /api/shared-memory/write directly and
      // must not go dark in that config — fall through to a direct daemon
      // /api/agent/identity probe.
      const fetchMock = vi.fn(async (url: string) => {
        if (url === 'http://localhost:9200/api/agent/identity') {
          return new Response(JSON.stringify({
            agentAddress: '0xprobed',
            peerId: '12D3KooProbed',
            agentDid: 'did:dkg:agent:probed',
            name: 'probed',
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ shareOperationId: 'op-mem-off' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      // Deliberately do NOT inject nodePeerId — memory module disabled scenario.
      const byName = new Map(tools.map((t) => [t.name, t] as const));
      const result = await byName.get('dkg_share')!.execute('tc', {
        content: 'works without memory module',
        context_graph_id: 'ctx',
      });
      const body = JSON.parse(result.content[0].text);
      expect(body.shareOperationId).toBe('op-mem-off');
      // Subject should incorporate the address surfaced by the direct probe.
      expect(body.subject).toMatch(/^urn:openclaw:0xprobed:shared:\d+-[a-z0-9]+$/);
      const identityCalls = fetchMock.mock.calls.filter(c => c[0] === 'http://localhost:9200/api/agent/identity');
      expect(identityCalls.length).toBe(1);
    });
  });
});
