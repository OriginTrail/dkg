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

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });


    it('dkg_assertion_create forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ assertionUri: 'urn:x' });
      await byName.get('dkg_assertion_create')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'chat-turns',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/create');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        name: 'chat-turns',
        subGraphName: 'protocols',
      });
    });


    it('dkg_import_artifact_resolve forwards snake_case to the resolver route', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ artifact: { assertionUri: 'urn:x' } });
      await byName.get('dkg_import_artifact_resolve')!.execute('tc', {
        context_graph_id: 'ctx',
        assertion_uri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
        file_hash: `sha256:${'a'.repeat(64)}`,
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/import-artifact/resolve');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        assertionUri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
        fileHash: `sha256:${'a'.repeat(64)}`,
        subGraphName: 'protocols',
      });
    });


    it('dkg_import_artifact_read_markdown forwards max_bytes to the safe read route', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ markdown: '# Doc' });
      await byName.get('dkg_import_artifact_read_markdown')!.execute('tc', {
        context_graph_id: 'ctx',
        assertion_uri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
        max_bytes: 4096,
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/import-artifact/read-markdown');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        assertionUri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
        maxBytes: 4096,
      });
    });


    it('dkg_import_artifact_read_markdown coerces quoted max_bytes integers and rejects fractions', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ markdown: '# Doc' });
      await byName.get('dkg_import_artifact_read_markdown')!.execute('tc', {
        context_graph_id: 'ctx',
        assertion_uri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
        max_bytes: '4096',
      });
      expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toMatchObject({
        maxBytes: 4096,
      });

      const invalid = await byName.get('dkg_import_artifact_read_markdown')!.execute('tc', {
        context_graph_id: 'ctx',
        assertion_uri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
        max_bytes: 1.5,
      });
      expect(invalid.details?.error).toMatch(/positive integer/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });


    it('dkg_semantic_enrichment_write normalizes plain semantic objects without promotion flags', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ promoted: false, published: false });
      await byName.get('dkg_semantic_enrichment_write')!.execute('tc', {
        context_graph_id: 'ctx',
        assertion_uri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
        semantic_quads: [
          { subject: 'urn:doc:1', predicate: 'http://schema.org/about', object: 'Topic' },
          { subject: 'urn:doc:1', predicate: 'http://schema.org/author', object: 'mailto:alice@example.org' },
        ],
        generation_method: 'test-model',
        agent_identity: 'did:dkg:agent:test',
        generated_at: '2026-05-11T00:00:00.000Z',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/semantic-enrichment/write');
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        contextGraphId: 'ctx',
        assertionUri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
        semanticQuads: [
          { subject: 'urn:doc:1', predicate: 'http://schema.org/about', object: '"Topic"' },
          { subject: 'urn:doc:1', predicate: 'http://schema.org/author', object: 'mailto:alice@example.org' },
        ],
        generationMethod: 'test-model',
        agentIdentity: 'did:dkg:agent:test',
        generatedAt: '2026-05-11T00:00:00.000Z',
      });
      expect(body).not.toHaveProperty('name');
      expect(body).not.toHaveProperty('semanticAssertionName');
      expect(body).not.toHaveProperty('promote');
      expect(body).not.toHaveProperty('publish');
    });


    it('dkg_semantic_enrichment_write rejects legacy target assertion names at the adapter boundary', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ promoted: false, published: false });
      const result = await byName.get('dkg_semantic_enrichment_write')!.execute('tc', {
        context_graph_id: 'ctx',
        assertion_uri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
        semanticAssertionName: 'semantic-imported',
        semantic_quads: [
          { subject: 'urn:doc:1', predicate: 'http://schema.org/about', object: 'Topic' },
        ],
      });

      expect(result.content[0].text).toMatch(/target assertion names are not supported/);
      expect(fetchMock).not.toHaveBeenCalled();
    });


    it('dkg_semantic_enrichment_write rejects semantic graph placement at the adapter boundary', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ promoted: false, published: false });
      const result = await byName.get('dkg_semantic_enrichment_write')!.execute('tc', {
        context_graph_id: 'ctx',
        assertion_uri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
        semantic_quads: [
          { subject: 'urn:doc:1', predicate: 'http://schema.org/about', object: 'Topic', graph: 'urn:graph:forged' },
        ],
      });

      expect(result.content[0].text).toMatch(/graph.*not supported/);
      expect(result.details).toEqual(expect.objectContaining({ error: expect.stringMatching(/graph.*not supported/) }));
      expect(fetchMock).not.toHaveBeenCalled();
    });


    it('dkg_context_graph_invite forwards snake_case → camelCase body', async () => {
      const statusResponse = {
        peerId: '12D3Kooself',
        multiaddrs: [
          '/ip4/127.0.0.1/tcp/9201/p2p/12D3Kooself',
          '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSrelay/p2p-circuit/p2p/12D3Kooself',
        ],
      };
      const fetchMock = vi.fn(async (url: string) => {
        if (url === 'http://localhost:9200/api/status') {
          return new Response(JSON.stringify(statusResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ invited: '12D3KooWfriend', contextGraphId: 'ctx' }), {
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
      const result = await byName.get('dkg_context_graph_invite')!.execute('tc', {
        context_graph_id: 'ctx',
        peer_id: '12D3KooWfriend',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/invite');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        peerId: '12D3KooWfriend',
      });
      const body = JSON.parse(result.content[0].text);
      expect(body.peerId).toBe('12D3KooWfriend');
      expect(body.curatorMultiaddr).toBe('/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSrelay/p2p-circuit/p2p/12D3Kooself');
      expect(body.inviteCode).toBe('ctx\n/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSrelay/p2p-circuit/p2p/12D3Kooself');
    });


    it('dkg_participant_add forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true, contextGraphId: 'ctx', agentAddress: '0xabc' });
      await byName.get('dkg_participant_add')!.execute('tc', {
        context_graph_id: 'ctx',
        agent_address: '0xabc',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/add-participant');
      expect(JSON.parse(init.body as string)).toEqual({ agentAddress: '0xabc' });
    });


    it('dkg_participant_remove forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true, contextGraphId: 'ctx', agentAddress: '0xabc' });
      await byName.get('dkg_participant_remove')!.execute('tc', {
        context_graph_id: 'ctx',
        agent_address: '0xabc',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/remove-participant');
      expect(JSON.parse(init.body as string)).toEqual({ agentAddress: '0xabc' });
    });


    it('dkg_participant_list forwards the context-graph path', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ contextGraphId: 'ctx', allowedAgents: ['0xabc'] });
      await byName.get('dkg_participant_list')!.execute('tc', {
        context_graph_id: 'ctx',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/participants');
      expect(init.method).toBe('GET');
    });


    it('dkg_join_request_list forwards the context-graph path', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ contextGraphId: 'ctx', requests: [] });
      await byName.get('dkg_join_request_list')!.execute('tc', {
        context_graph_id: 'ctx',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/join-requests');
      expect(init.method).toBe('GET');
    });


    it('dkg_join_request_approve forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true, status: 'approved', agentAddress: '0xabc' });
      await byName.get('dkg_join_request_approve')!.execute('tc', {
        context_graph_id: 'ctx',
        agent_address: '0xabc',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/approve-join');
      expect(JSON.parse(init.body as string)).toEqual({ agentAddress: '0xabc' });
    });


    it('dkg_join_request_reject forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true, status: 'rejected', agentAddress: '0xabc' });
      await byName.get('dkg_join_request_reject')!.execute('tc', {
        context_graph_id: 'ctx',
        agent_address: '0xabc',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/context-graph/ctx/reject-join');
      expect(JSON.parse(init.body as string)).toEqual({ agentAddress: '0xabc' });
    });


    it('dkg_assertion_write forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ written: 1 });
      await byName.get('dkg_assertion_write')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        quads: [{ subject: 'urn:a', predicate: 'urn:b', object: 'urn:c' }],
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/knowledge-assets/notes/wm/write');
      const body = JSON.parse(init.body as string);
      expect(body.contextGraphId).toBe('ctx');
      expect(body.subGraphName).toBe('protocols');
      expect(body.quads).toHaveLength(1);
    });


    it('dkg_assertion_promote forwards snake_case → camelCase body and rejects stray string "all"', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ promoted: 1 });
      await byName.get('dkg_assertion_promote')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        entities: ['urn:root-1', 'urn:root-2'],
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/knowledge-assets/notes/swm/share');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        entities: ['urn:root-1', 'urn:root-2'],
        subGraphName: 'protocols',
      });

      // Blocker guard: the previous string-"all" shortcut is gone from the public
      // tool surface. The handler now returns an error result instead of sending.
      fetchMock.mockClear();
      const bad = await byName.get('dkg_assertion_promote')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        entities: 'all',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(bad.content[0].text).toContain('entities');
      expect(bad.content[0].text).toContain('non-empty array');
    });


    it('dkg_assertion_promote omits entities when not supplied (daemon default kicks in)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ promoted: 1 });
      await byName.get('dkg_assertion_promote')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.contextGraphId).toBe('ctx');
      expect(body.entities).toBeUndefined();
    });


    it('dkg_assertion_discard forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ discarded: true });
      await byName.get('dkg_assertion_discard')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'draft',
        sub_graph_name: 'scratch',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/knowledge-assets/draft/wm/discard');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        subGraphName: 'scratch',
      });
    });


    it('dkg_assertion_query forwards snake_case → camelCase body (no sparql)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ quads: [], count: 0 });
      await byName.get('dkg_assertion_query')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/notes/query');
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ contextGraphId: 'ctx', subGraphName: 'protocols' });
      expect(body).not.toHaveProperty('sparql');
    });


    it('dkg_assertion_history forwards snake_case → camelCase query params (GET, no body)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ createdAt: 't' });
      await byName.get('dkg_assertion_history')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        agent_address: '0xabc',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(String(url));
      // Read stays on the legacy assertion route to keep author scoping.
      expect(parsed.pathname).toBe('/api/assertion/notes/history');
      expect(parsed.searchParams.get('contextGraphId')).toBe('ctx');
      expect(parsed.searchParams.get('agentAddress')).toBe('0xabc');
      expect(parsed.searchParams.get('subGraphName')).toBe('protocols');
      expect(init.body).toBeUndefined();
    });


    it('dkg_assertion_import_file reads the file and forwards camelCase multipart fields (.md → text/markdown)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ assertionUri: 'urn:x' });
      const { writeFileSync, mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const tmpDir = mkdtempSync(join(tmpdir(), 'dkg-test-'));
      const filePath = join(tmpDir, 'doc.md');
      writeFileSync(filePath, '# Hello\n');

      await byName.get('dkg_assertion_import_file')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        file_path: filePath,
        ontology_ref: 'urn:onto',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/assertion/notes/import-file');
      expect(init.method).toBe('POST');
      const form = init.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get('contextGraphId')).toBe('ctx');
      // content_type was omitted but file has .md extension — handler should infer text/markdown
      expect(form.get('contentType')).toBe('text/markdown');
      expect(form.get('ontologyRef')).toBe('urn:onto');
      expect(form.get('subGraphName')).toBe('protocols');
      expect((form.get('file') as File).name).toBe('doc.md');
    });
  });
});
