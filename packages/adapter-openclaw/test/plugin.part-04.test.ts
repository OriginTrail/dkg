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


    it('dkg_query forwards the `view` field to the daemon body verbatim', async () => {
      // Handler-level drift guard: the daemon's /api/query route destructures
      // `view` from the body. If we renamed the field in the handler, this
      // test catches the drift.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'verifiable-memory',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.view).toBe('verifiable-memory');
      expect(body.contextGraphId).toBe('my-cg');
      expect(body).not.toHaveProperty('includeSharedMemory');
    });


    it('dkg_subscribe rejects a stringified include_shared_memory (same rationale as dkg_query)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_subscribe')!.execute('tc', {
        context_graph_id: 'ctx',
        include_shared_memory: 'true',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('include_shared_memory');
      expect(result.content[0].text).toContain('boolean');
    });


    it('dkg_knowledge_asset_share description points to dkg_knowledge_asset_publish as the next step', () => {
      // rc.17 (CONTRACT §2 promote→share, §1 Stage5): after a FULL share the
      // draft auto-seals best-effort and the publish-ready finalizer is the
      // per-KA dkg_knowledge_asset_publish. The share description must steer the
      // agent to it and explain the subset-is-not-publishable rule (§5).
      const plugin = new DkgNodePlugin();
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const share = tools.find((t) => t.name === 'dkg_knowledge_asset_share')!;
      expect(share.description).toContain('dkg_knowledge_asset_publish');
      expect(share.description).toMatch(/auto-seal/i);
      // §5 subset-vs-full language must be present.
      expect(share.description).toMatch(/NOT publishable to Verifiable Memory/i);
    });


    it('dkg_knowledge_asset_write escapes every N-Triples ECHAR control character in literal objects', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ written: 1 });
      await byName.get('dkg_knowledge_asset_write')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        quads: [
          {
            subject: 'https://example.org/a',
            predicate: 'https://schema.org/text',
            // Includes: \n, \t, \r, ", \, \f (form-feed), \b (backspace).
            // Missing \f / \b escapes would leave raw 0x0C / 0x08 bytes in
            // the JSON body and cause strict triple-store parsers to reject
            // the literal.
            object: 'line1\nline2\tcol\rend"with quote\\and backslash\fff\bbb',
          },
        ],
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.quads[0].object).toBe(
        '"line1\\nline2\\tcol\\rend\\"with quote\\\\and backslash\\fff\\bbb"',
      );
    });
  });
});
