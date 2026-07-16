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
      // Most handler tests assume the node identity has resolved (e.g.
      // memory_search routes WM reads by the node's agent identity). Inject a
      // placeholder address so tests don't have to mock the daemon /api/status
      // probe end-to-end. Pass `skipNodeIdInjection: true` to exercise the
      // unresolved-identity branch.
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

  });
});
