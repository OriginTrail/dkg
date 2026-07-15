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

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });


    it('dkg_knowledge_asset_create forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ assertionUri: 'urn:x' });
      await byName.get('dkg_knowledge_asset_create')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'chat-turns',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/knowledge-assets');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        name: 'chat-turns',
        subGraphName: 'protocols',
      });
    });

    it('dkg_knowledge_asset_create accepts any valid (IRI-safe) name, not just a slug (FIX P)', async () => {
      // The daemon's real rule (validateAssertionName) accepts mixed-case, dots,
      // and underscores — the description no longer claims a lowercase-hyphen slug.
      const { fetchMock, byName } = setupPluginWithFetch({ assertionUri: 'urn:x' });
      const res = await byName.get('dkg_knowledge_asset_create')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'My_Asset.v2',
      });
      expect(res.details).not.toHaveProperty('error');
      expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string).name).toBe('My_Asset.v2');
    });

    it('dkg_knowledge_asset_create rejects IRI-unsafe names at the adapter boundary (FIX P)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ assertionUri: 'urn:x' });
      for (const bad of ['has/slash', 'has space', 'a'.repeat(257)]) {
        const res = await byName.get('dkg_knowledge_asset_create')!.execute('tc', {
          context_graph_id: 'ctx',
          name: bad,
        });
        expect(res.details?.error).toMatch(/"name" is invalid/);
      }
      // Nothing reached the daemon — all rejected at the boundary.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    // ── [D3] one-shot create→write→seal→share via dkg_knowledge_asset_create ──
    it('[D3] create with quads (no also_share_swm) seals a WM draft and forwards alsoShareSwm:false EXPLICITLY', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ status: 'wm-sealed', sealed: true, publishReady: false });
      await byName.get('dkg_knowledge_asset_create')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'one-shot',
        quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'hello world' }],
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/knowledge-assets');
      const body = JSON.parse(init.body as string);
      expect(body.name).toBe('one-shot');
      expect(body.contextGraphId).toBe('ctx');
      // Regression guard: the tool MUST forward an explicit alsoShareSwm:false so the
      // client helper's internal seal-true default can't leak and silently auto-share.
      expect(body.alsoShareSwm).toBe(false);
      expect(body).toHaveProperty('alsoShareSwm');
      // No VM-mint bypass — never forward alsoPublishVm.
      expect(body).not.toHaveProperty('alsoPublishVm');
      // Object auto-typed to a literal; per-KA graph pinned to ''.
      expect(body.quads).toEqual([{ subject: 'urn:s', predicate: 'urn:p', object: '"hello world"', graph: '' }]);
    });

    it('[D3] create with quads + also_share_swm:true runs the full one-shot to SWM', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ status: 'swm-shared', sealed: true, publishReady: true });
      await byName.get('dkg_knowledge_asset_create')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'one-shot-share',
        quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
        also_share_swm: true,
      });
      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.alsoShareSwm).toBe(true);
      expect(body).not.toHaveProperty('alsoPublishVm');
      // URI object passes through un-quoted; per-KA graph pinned to ''.
      expect(body.quads).toEqual([{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o', graph: '' }]);
    });

    it('[D3] create strips <…> on subject/predicate/object + auto-types objects (parity with MCP/Hermes)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ status: 'wm-sealed', sealed: true });
      await byName.get('dkg_knowledge_asset_create')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'brackets',
        quads: [
          { subject: '<urn:s>', predicate: '<urn:p>', object: '<urn:o>' },
          { subject: 'urn:s2', predicate: 'urn:p2', object: 'HTTP://EXAMPLE.ORG' },
          { subject: 'urn:s3', predicate: 'urn:p3', object: '_:b0' },
          { subject: 'urn:s4', predicate: 'urn:p4', object: 'hello world' },
        ],
      });
      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.quads).toEqual([
        // bracketed URI stays a URI (stripped), not a quoted literal
        { subject: 'urn:s', predicate: 'urn:p', object: 'urn:o', graph: '' },
        // case-insensitive scheme + blank node pass through as terms (shared core normalizer)
        { subject: 'urn:s2', predicate: 'urn:p2', object: 'HTTP://EXAMPLE.ORG', graph: '' },
        { subject: 'urn:s3', predicate: 'urn:p3', object: '_:b0', graph: '' },
        // bare literal is quoted
        { subject: 'urn:s4', predicate: 'urn:p4', object: '"hello world"', graph: '' },
      ]);
    });

    it('[D3] create with also_share_swm:true surfaces a 207 share failure as an ERROR (not publish-ready)', async () => {
      // The daemon returns 207 + errors:[{phase:'swm-share'}] when create+seal lands but
      // the opt-in share fails; the client treats 207 as success, so the tool must judge
      // from the OUTCOME (parity with MCP) — not the requested flag — or it would send the
      // agent to publish an asset that never reached SWM.
      const { byName } = setupPluginWithFetch({
        status: 'wm-sealed',
        sealed: true,
        errors: [{ phase: 'swm-share', error: 'shared memory write rejected' }],
      });
      const res = await byName.get('dkg_knowledge_asset_create')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'share-failed',
        quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' }],
        also_share_swm: true,
      });
      expect(res.details?.error).toMatch(/Shared Working Memory share FAILED/);
      expect(res.details?.error).toContain('shared memory write rejected');
      expect(res.details?.error).toContain('NOT publish-ready');
      expect(res.details?.error).toContain('dkg_knowledge_asset_share');
    });

    it('[D3] create with NO quads stays on the bare create path (no quads/alsoShareSwm in body)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ assertionUri: 'urn:x' });
      await byName.get('dkg_knowledge_asset_create')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'draft-only',
      });
      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body).not.toHaveProperty('quads');
      expect(body).not.toHaveProperty('alsoShareSwm');
    });

    it('[D3] create rejects an empty quads array and a non-boolean also_share_swm at the boundary', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({});
      const emptyQuads = await byName.get('dkg_knowledge_asset_create')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'bad',
        quads: [],
      });
      expect(emptyQuads.details?.error).toMatch(/"quads" must be a non-empty array/);
      const badShare = await byName.get('dkg_knowledge_asset_create')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'bad',
        quads: [{ subject: 'urn:s', predicate: 'urn:p', object: 'x' }],
        also_share_swm: 'yes',
      });
      expect(badShare.details?.error).toMatch(/"also_share_swm" must be a boolean/);
      // Parity with MCP + Hermes: the also_share_swm shape is validated even on the
      // bare-create (no quads) path where it is IGNORED.
      const badShareNoQuads = await byName.get('dkg_knowledge_asset_create')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'bad',
        also_share_swm: 'yes',
      });
      expect(badShareNoQuads.details?.error).toMatch(/"also_share_swm" must be a boolean/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('[D3] create does NOT expose also_share_swm on the bare-create schema as a VM path (no alsoPublishVm/also_publish_vm)', () => {
      const { byName } = setupPluginWithFetch({});
      const props = byName.get('dkg_knowledge_asset_create')!.parameters.properties;
      expect(props).toHaveProperty('quads');
      expect(props).toHaveProperty('also_share_swm');
      expect(props).not.toHaveProperty('also_publish_vm');
      expect(props).not.toHaveProperty('alsoPublishVm');
    });


    // ── rc.17 new lifecycle verbs (CONTRACT §1 Stage3/Stage5 + side-verbs) ────

    it('dkg_knowledge_asset_finalize POSTs to /wm/finalize with camelCase body (whole-draft seal)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ merkleRoot: '0xroot', eip712Digest: '0xdig' });
      const res = await byName.get('dkg_knowledge_asset_finalize')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        author_agent_address: '0xabc',
        scheme_version: 1,
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/knowledge-assets/notes/wm/finalize');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      // No subset/entities param on finalize — it always seals the whole draft.
      expect(body).toEqual({
        contextGraphId: 'ctx',
        authorAgentAddress: '0xabc',
        schemeVersion: 1,
        subGraphName: 'protocols',
      });
      expect(body).not.toHaveProperty('entities');
      // The token-resolved author is surfaced; the raw pre-signed attestation is not.
      expect(body).not.toHaveProperty('preSignedAuthorAttestation');
      expect(res.details).toMatchObject({ merkleRoot: '0xroot' });
    });


    it('dkg_knowledge_asset_finalize rejects a non-integer scheme_version at the adapter boundary', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({});
      const res = await byName.get('dkg_knowledge_asset_finalize')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        scheme_version: 1.5,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.details?.error).toMatch(/scheme_version.*integer/);
    });


    it('dkg_knowledge_asset_finalize rejects a zero/negative scheme_version (CONTRACT §C — must be >= 1)', async () => {
      // The daemon rule is Number.isInteger && >= 1, so `0` (and negatives) are
      // present-but-invalid and must be a tool error, never silent-dropped.
      const { fetchMock, byName } = setupPluginWithFetch({});
      for (const bad of [0, -1]) {
        fetchMock.mockClear();
        const res = await byName.get('dkg_knowledge_asset_finalize')!.execute('tc', {
          context_graph_id: 'ctx',
          name: 'notes',
          scheme_version: bad,
        });
        expect(fetchMock, `scheme_version: ${bad}`).not.toHaveBeenCalled();
        expect(res.details?.error).toMatch(/scheme_version.*positive integer/);
      }
    });


    it('dkg_knowledge_asset_publish POSTs to /vm/publish with options nested and NO author/selection overrides', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ual: 'did:dkg:1/0xauthor/7', kaId: 'kc-1', status: 'confirmed' });
      const res = await byName.get('dkg_knowledge_asset_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        publish_epochs: 2,
        // CONTRACT §D: clear-after is NOT a param on the per-asset publish tool;
        // a stray arg must never reach the wire (it is graph-wide destructive).
        clear_shared_memory_after: true,
        publisher_node_identity_id_override: '12',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/knowledge-assets/notes/vm/publish');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      // The seal selects author + the whole asset (CONTRACT §1 Stage5 / §3) —
      // never send author/selection. publish controls are normalized into the
      // nested `options` object with the canonical daemon keys (CONTRACT §6).
      // clearSharedMemoryAfter is DROPPED from the per-asset publish (CONTRACT §D).
      expect(body).toEqual({
        contextGraphId: 'ctx',
        subGraphName: 'protocols',
        options: {
          publishEpochs: 2,
          publisherNodeIdentityIdOverride: '12',
        },
      });
      expect(body).not.toHaveProperty('authorAgentAddress');
      expect(body).not.toHaveProperty('preSignedAuthorAttestation');
      expect(body).not.toHaveProperty('selection');
      // CONTRACT §D: neither the canonical key nor its SDK alias is ever sent on
      // the per-asset publish path, even when a clear-after arg is passed.
      expect(body.options).not.toHaveProperty('clearSharedMemoryAfter');
      expect(body.options).not.toHaveProperty('clearAfter');
      // The returned UAL flows through to the agent.
      expect(res.details).toMatchObject({ ual: 'did:dkg:1/0xauthor/7' });
    });


    it('dkg_knowledge_asset_publish rejects a non-positive publish_epochs at the adapter boundary', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({});
      const res = await byName.get('dkg_knowledge_asset_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        publish_epochs: 0,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.details?.error).toMatch(/publish_epochs.*positive integer/);
    });


    it('dkg_knowledge_asset_publish rejects a non-numeric publish_epochs (CONTRACT §C)', async () => {
      // A present-but-non-numeric string (Number("x") → NaN) is invalid and must
      // be a tool error, not silently dropped.
      const { fetchMock, byName } = setupPluginWithFetch({});
      const res = await byName.get('dkg_knowledge_asset_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        publish_epochs: 'x',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.details?.error).toMatch(/publish_epochs.*positive integer/);
    });


    it('dkg_knowledge_asset_publish rejects a negative publisher_node_identity_id_override (CONTRACT §C)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({});
      // Regression: BigInt("-1") parses fine, so the daemon /^\d+$/ rule must be
      // enforced at the adapter boundary — a negative override is a tool error,
      // never sent on the wire.
      const res = await byName.get('dkg_knowledge_asset_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        publisher_node_identity_id_override: '-1',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.details?.error).toMatch(/publisher_node_identity_id_override.*non-negative integer/);
    });


    it('dkg_knowledge_asset_publish surfaces 409 VM_PUBLISH_PRECONDITION verbatim (finalize + share first)', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({ error: 'VM_PUBLISH_PRECONDITION', message: 'assertion is not finalized' }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({ config: {}, registerTool: (t) => tools.push(t), registerHook: () => {}, on: () => {}, logger: {} });
      const byName = new Map(tools.map((t) => [t.name, t] as const));

      const res = await byName.get('dkg_knowledge_asset_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
      });
      expect(res.details?.error).toContain('409');
      expect(res.details?.error).toContain('VM_PUBLISH_PRECONDITION');
    });


    it('dkg_knowledge_asset_publish surfaces a 207 partial (KA minted, CG bind failed) as a WARNING, not plain success', async () => {
      // HTTP 207: status confirmed but contextGraphError present (the HTTP client
      // treats 207 as success and returns the body). The UAL/kaId are valid and the
      // asset IS published — the result must flag the partial AND tell the agent NOT
      // to re-publish (a confirmed publish cleared SWM → a retry 409s the VM
      // precondition without re-binding the CG; operator follows up).
      const { byName } = setupPluginWithFetch({
        ual: 'did:dkg:1/0xauthor/7',
        kaId: 'kc-1',
        status: 'confirmed',
        contextGraphError: 'context-graph binding timed out',
      });
      const res = await byName.get('dkg_knowledge_asset_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
      });
      const details = res.details as Record<string, unknown>;
      expect(details.partial).toBe(true);
      expect(details.ual).toBe('did:dkg:1/0xauthor/7'); // mint succeeded — UAL still valid
      expect(String(details.warning)).toContain('context-graph binding timed out');
      expect(String(details.warning)).toMatch(/do not re-publish/i);
      expect(String(details.warning)).not.toMatch(/retry the publish/i); // FIX I: harmful advice removed
      expect(res.content[0].text).toMatch(/partial/i);
    });

    it('dkg_knowledge_asset_publish reports plain success on a 200 (no contextGraphError)', async () => {
      const { byName } = setupPluginWithFetch({
        ual: 'did:dkg:1/0xauthor/7',
        kaId: 'kc-1',
        status: 'confirmed',
      });
      const res = await byName.get('dkg_knowledge_asset_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
      });
      const details = res.details as Record<string, unknown>;
      expect(details).not.toHaveProperty('partial');
      expect(details).not.toHaveProperty('warning');
      expect(details.ual).toBe('did:dkg:1/0xauthor/7');
    });


    // ── CONTRACT §G — register_if_needed on per-KA publish ──────────────────
    // A URL-routed fetch mock so register (POST /api/context-graph/register) and
    // publish (POST /api/knowledge-assets/<name>/vm/publish) can be asserted +
    // failed independently.
    const setupPublishWithRoutedFetch = (
      handlers: { register?: () => Response; publish?: () => Response } = {},
    ) => {
      const calls: string[] = [];
      const fetchMock = vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).includes('/api/context-graph/register')) {
          return handlers.register?.() ?? new Response(JSON.stringify({ registered: 'ctx' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (String(url).includes('/vm/publish')) {
          return handlers.publish?.() ?? new Response(JSON.stringify({ ual: 'did:dkg:1/0xauthor/7', status: 'confirmed' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({ config: {}, registerTool: (t) => tools.push(t), registerHook: () => {}, on: () => {}, logger: {} });
      const byName = new Map(tools.map((t) => [t.name, t] as const));
      return { fetchMock, byName, calls };
    };

    it('dkg_knowledge_asset_publish with register_if_needed=true registers THEN publishes', async () => {
      const { byName, calls } = setupPublishWithRoutedFetch();
      const res = await byName.get('dkg_knowledge_asset_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        register_if_needed: true,
        access_policy: 1,
      });
      expect(res.details).toMatchObject({ ual: 'did:dkg:1/0xauthor/7' });
      // register first, then vm/publish.
      expect(calls.some((u) => u.includes('/api/context-graph/register'))).toBe(true);
      expect(calls.filter((u) => u.includes('/api/context-graph/register'))).toHaveLength(1);
      const regIdx = calls.findIndex((u) => u.includes('/api/context-graph/register'));
      const pubIdx = calls.findIndex((u) => u.includes('/vm/publish'));
      expect(regIdx).toBeGreaterThanOrEqual(0);
      expect(pubIdx).toBeGreaterThan(regIdx);
    });

    it('dkg_knowledge_asset_publish does NOT register when register_if_needed is omitted', async () => {
      const { byName, calls } = setupPublishWithRoutedFetch();
      await byName.get('dkg_knowledge_asset_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
      });
      expect(calls.some((u) => u.includes('/api/context-graph/register'))).toBe(false);
      expect(calls.some((u) => u.includes('/vm/publish'))).toBe(true);
    });

    it('dkg_knowledge_asset_publish treats "already registered" as success and still publishes', async () => {
      const { byName, calls } = setupPublishWithRoutedFetch({
        register: () => new Response(JSON.stringify({ error: 'context graph already registered' }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
      });
      const res = await byName.get('dkg_knowledge_asset_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        register_if_needed: true,
      });
      expect(res.details).toMatchObject({ ual: 'did:dkg:1/0xauthor/7' });
      expect(calls.some((u) => u.includes('/vm/publish'))).toBe(true);
    });

    it('dkg_knowledge_asset_publish surfaces a register HARD failure and does NOT publish', async () => {
      const { byName, calls } = setupPublishWithRoutedFetch({
        register: () => new Response(JSON.stringify({ error: 'rpc unreachable' }), { status: 500, headers: { 'Content-Type': 'application/json' } }),
      });
      const res = await byName.get('dkg_knowledge_asset_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        register_if_needed: true,
      });
      expect(res.details?.error).toBeTruthy();
      // CONTRACT §G: a hard registration failure is a tool error — publish NOT attempted.
      expect(calls.some((u) => u.includes('/vm/publish'))).toBe(false);
    });

    it('dkg_knowledge_asset_publish rejects a non-boolean register_if_needed', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({});
      const res = await byName.get('dkg_knowledge_asset_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        register_if_needed: 'yes',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.details?.error).toMatch(/register_if_needed.*boolean/);
    });

    it('dkg_knowledge_asset_publish rejects access_policy without register_if_needed (FIX S)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({});
      const res = await byName.get('dkg_knowledge_asset_publish')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        access_policy: 1, // valid 0|1 but no register_if_needed
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.details?.error).toMatch(/access_policy.*requires.*register_if_needed/i);
    });


    it('dkg_knowledge_asset_pull_from POSTs to /wm/pull-from with layer + onConflict (camelCase body)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ wmDraft: 'open', seededFrom: { layer: 'swm' } });
      const res = await byName.get('dkg_knowledge_asset_pull_from')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        layer: 'swm',
        on_conflict: 'replace',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/knowledge-assets/notes/wm/pull-from');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        layer: 'swm',
        onConflict: 'replace',
        subGraphName: 'protocols',
      });
      expect(res.details).toMatchObject({ wmDraft: 'open' });
    });


    it('dkg_knowledge_asset_pull_from rejects a missing/invalid layer at the adapter boundary', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({});
      const res = await byName.get('dkg_knowledge_asset_pull_from')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        layer: 'wm',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.details?.error).toMatch(/layer.*"swm".*"vm"/);
    });


    it('dkg_knowledge_asset_pull_from surfaces 409 WM_DRAFT_CONFLICT verbatim (dirty draft)', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({ error: 'WM_DRAFT_CONFLICT', message: 'an open draft already exists' }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({ config: {}, registerTool: (t) => tools.push(t), registerHook: () => {}, on: () => {}, logger: {} });
      const byName = new Map(tools.map((t) => [t.name, t] as const));

      const res = await byName.get('dkg_knowledge_asset_pull_from')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        layer: 'vm',
      });
      expect(res.details?.error).toContain('409');
      expect(res.details?.error).toContain('WM_DRAFT_CONFLICT');
    });


    // Negative (CONTRACT §0 invariant 2): the `dkg_knowledge_asset_write` tool
    // schema declares NO per-quad `graph` prop, so a well-behaved agent cannot
    // supply one. (The schema-level guard is pinned in plugin.part-06.) The
    // daemon additionally re-pins every quad to the per-KA WM graph, so any stray
    // `graph` is ignored/overridden server-side. We pin the agent-facing surface
    // here: the canonical write tool never advertises a `graph` field.
    it('dkg_knowledge_asset_write schema exposes no per-quad graph field', () => {
      const { byName } = setupPluginWithFetch({ written: 1 });
      const writeTool = byName.get('dkg_knowledge_asset_write')!;
      const itemProps = (writeTool.parameters.properties.quads as any).items.properties;
      expect(itemProps).not.toHaveProperty('graph');
      expect(itemProps).toHaveProperty('subject');
      expect(itemProps).toHaveProperty('predicate');
      expect(itemProps).toHaveProperty('object');
    });


    it('dkg_knowledge_asset_import_artifact_resolve forwards snake_case to the resolver route', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ artifact: { assertionUri: 'urn:x' } });
      await byName.get('dkg_knowledge_asset_import_artifact_resolve')!.execute('tc', {
        context_graph_id: 'ctx',
        assertion_uri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
        file_hash: `sha256:${'a'.repeat(64)}`,
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/knowledge-assets/import-artifact/resolve');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        assertionUri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
        fileHash: `sha256:${'a'.repeat(64)}`,
        subGraphName: 'protocols',
      });
    });


    it('dkg_knowledge_asset_import_artifact_read_markdown forwards max_bytes to the safe read route', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ markdown: '# Doc' });
      await byName.get('dkg_knowledge_asset_import_artifact_read_markdown')!.execute('tc', {
        context_graph_id: 'ctx',
        assertion_uri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
        max_bytes: 4096,
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/knowledge-assets/import-artifact/read-markdown');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        assertionUri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
        maxBytes: 4096,
      });
    });


    it('dkg_knowledge_asset_import_artifact_read_markdown coerces quoted max_bytes integers and rejects fractions', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ markdown: '# Doc' });
      await byName.get('dkg_knowledge_asset_import_artifact_read_markdown')!.execute('tc', {
        context_graph_id: 'ctx',
        assertion_uri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
        max_bytes: '4096',
      });
      expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)).toMatchObject({
        maxBytes: 4096,
      });

      const invalid = await byName.get('dkg_knowledge_asset_import_artifact_read_markdown')!.execute('tc', {
        context_graph_id: 'ctx',
        assertion_uri: 'did:dkg:context-graph:ctx/assertion/peer/imported',
        max_bytes: 1.5,
      });
      expect(invalid.details?.error).toMatch(/positive integer/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });


    it('dkg_knowledge_asset_semantic_enrichment_write normalizes plain semantic objects without promotion flags', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ promoted: false, published: false });
      await byName.get('dkg_knowledge_asset_semantic_enrichment_write')!.execute('tc', {
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
      expect(url).toBe('http://localhost:9200/api/knowledge-assets/semantic-enrichment/write');
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


    it('dkg_knowledge_asset_semantic_enrichment_write rejects legacy target assertion names at the adapter boundary', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ promoted: false, published: false });
      const result = await byName.get('dkg_knowledge_asset_semantic_enrichment_write')!.execute('tc', {
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


    it('dkg_knowledge_asset_semantic_enrichment_write rejects semantic graph placement at the adapter boundary', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ promoted: false, published: false });
      const result = await byName.get('dkg_knowledge_asset_semantic_enrichment_write')!.execute('tc', {
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


    it('dkg_knowledge_asset_write forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ written: 1 });
      await byName.get('dkg_knowledge_asset_write')!.execute('tc', {
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


    it('dkg_knowledge_asset_share sends only the atomic KA scope and rejects root selection', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ promoted: 1 });
      await byName.get('dkg_knowledge_asset_share')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/knowledge-assets/notes/swm/share');
      expect(JSON.parse(init.body as string)).toEqual({
        contextGraphId: 'ctx',
        subGraphName: 'protocols',
      });

      // Compatibility-only "all" is accepted but never serialized.
      fetchMock.mockClear();
      await byName.get('dkg_knowledge_asset_share')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        entities: 'all',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, allInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(allInit.body as string)).toEqual({
        contextGraphId: 'ctx',
      });

      // Any array is rejected before HTTP so an old subset request can never
      // silently widen into a complete-KA share.
      fetchMock.mockClear();
      const bad = await byName.get('dkg_knowledge_asset_share')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        entities: [],
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(bad.content[0].text).toContain('shared atomically');
    });

    it('dkg_knowledge_asset_share rejects root-selection arrays before the wire', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ promoted: 1 });
      const res = await byName.get('dkg_knowledge_asset_share')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        entities: [' urn:root-1 ', '\turn:root-2\n'],
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.details?.error).toContain('shared atomically');
    });


    it('dkg_knowledge_asset_share omits entities when not supplied (daemon default kicks in)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ promoted: 1 });
      await byName.get('dkg_knowledge_asset_share')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.contextGraphId).toBe('ctx');
      expect(body.entities).toBeUndefined();
    });


    // ── Atomic-share boundary + defensive mixed-version warnings ──

    it('dkg_knowledge_asset_share rejects skip_seal:true before the wire', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ swmShared: true, promotedCount: 1, sealed: false, publishReady: false });
      const res = await byName.get('dkg_knowledge_asset_share')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        skip_seal: true,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.details?.error).toContain('always sealed');
    });

    it('dkg_knowledge_asset_share rejects a non-boolean skip_seal at the boundary (#1116)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ swmShared: true });
      const res = await byName.get('dkg_knowledge_asset_share')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        skip_seal: 'yes',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.details?.error).toMatch(/skip_seal.*boolean/);
    });

    it('dkg_knowledge_asset_share with publishReady:false emits the atomic retry warning', async () => {
      const { byName } = setupPluginWithFetch({ swmShared: true, promotedCount: 2, sealed: false, publishReady: false });
      const res = await byName.get('dkg_knowledge_asset_share')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
      });
      expect(res.details?.warning).toContain('did not become publish-ready (sealed:false)');
      expect(res.details?.warning).toContain('retry the complete Knowledge Asset share');
    });

    it('dkg_knowledge_asset_share rejects a legacy subset request without widening it', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ swmShared: true, promotedCount: 1, sealed: false, publishReady: false });
      const res = await byName.get('dkg_knowledge_asset_share')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        entities: ['urn:a'],
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.details?.error).toContain('shared atomically');
    });

    it('dkg_knowledge_asset_share with publishReady:true emits NO warning (#1116)', async () => {
      const { byName } = setupPluginWithFetch({ swmShared: true, promotedCount: 2, sealed: true, publishReady: true });
      const res = await byName.get('dkg_knowledge_asset_share')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
      });
      expect(res.details).not.toHaveProperty('warning');
      expect((res.details as { publishReady?: boolean }).publishReady).toBe(true);
    });

    it('dkg_knowledge_asset_share with sealed:true + publishReady:false warns NOT to finalize layer:swm (#1116)', async () => {
      // A FULL share that sealed but did NOT promote every root (foreign-owned roots
      // skipped) → swmShareComplete marker NOT set → finalize layer:swm would REJECT.
      const { byName } = setupPluginWithFetch({ swmShared: true, promotedCount: 1, sealed: true, publishReady: false });
      const res = await byName.get('dkg_knowledge_asset_share')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
      });
      expect(res.details?.warning).toContain('complete sealed Knowledge Asset did not reach SWM');
      expect(res.details?.warning).toContain('retry the atomic share');
    });

    it('dkg_knowledge_asset_share surfaces a 409 UNSEALED_SHARE_BLOCKED recovery verbatim (#1116)', async () => {
      const recovery = 'No local signing key; pass skip_seal:true to share unsealed.';
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ code: 'UNSEALED_SHARE_BLOCKED', recovery }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({ config: {}, registerTool: (t) => tools.push(t), registerHook: () => {}, on: () => {}, logger: {} });
      const byName = new Map(tools.map((t) => [t.name, t] as const));
      const res = await byName.get('dkg_knowledge_asset_share')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
      });
      // The handler surfaces the daemon's recovery hint verbatim as the tool error.
      expect(res.details?.error).toBe(recovery);
    });

    it('dkg_knowledge_asset_share falls back to the generic error for a non-matching 409 (#1116)', async () => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ code: 'SOMETHING_ELSE', message: 'nope' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const plugin = new DkgNodePlugin({ daemonUrl: 'http://localhost:9200' });
      const tools: OpenClawTool[] = [];
      plugin.register({ config: {}, registerTool: (t) => tools.push(t), registerHook: () => {}, on: () => {}, logger: {} });
      const byName = new Map(tools.map((t) => [t.name, t] as const));
      const res = await byName.get('dkg_knowledge_asset_share')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
      });
      // Not the UNSEALED_SHARE_BLOCKED shape → generic daemon error, not a bare recovery.
      expect(res.details?.error).toBeDefined();
      expect(res.details?.error).toMatch(/responded 409/);
    });

    // ── #1116 finalize layer ──────────────────────────────────────────────

    it('dkg_knowledge_asset_finalize rejects legacy SWM finalization before the wire', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ merkleRoot: '0xroot', eip712Digest: '0xdig' });
      const res = await byName.get('dkg_knowledge_asset_finalize')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        layer: 'swm',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.details?.error).toContain('read-only');
    });

    it('dkg_knowledge_asset_finalize rejects an invalid layer at the boundary (#1116)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ merkleRoot: '0xroot' });
      const res = await byName.get('dkg_knowledge_asset_finalize')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        layer: 'vm',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.details?.error).toContain('Only Working Memory finalization');
    });

    it('dkg_knowledge_asset_finalize rejects a NON-STRING layer, nothing on the wire (#1116)', async () => {
      // A present non-string (['swm'] / true / a number) must NOT be String()-coerced
      // to "swm" and forwarded — it is a tool-boundary error (parity with Hermes/MCP).
      const { fetchMock, byName } = setupPluginWithFetch({ merkleRoot: '0xroot' });
      for (const bad of [['swm'], true, 1, { l: 'swm' }] as unknown[]) {
        fetchMock.mockClear();
        const res = await byName.get('dkg_knowledge_asset_finalize')!.execute('tc', {
          context_graph_id: 'ctx',
          name: 'notes',
          layer: bad as never,
        });
        expect(fetchMock, `layer: ${JSON.stringify(bad)}`).not.toHaveBeenCalled();
        expect(res.details?.error).toContain('Only Working Memory finalization');
      }
    });


    it('dkg_knowledge_asset_discard forwards snake_case → camelCase body', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ discarded: true });
      await byName.get('dkg_knowledge_asset_discard')!.execute('tc', {
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


    it('dkg_knowledge_asset_query forwards snake_case → camelCase query params (GET wm/quads, no sparql)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ quads: [], count: 0 });
      await byName.get('dkg_knowledge_asset_query')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      // rc.17 KA-routes-unification: ad-hoc assertion reads moved to the unified
      // GET /api/knowledge-assets/{name}/wm/quads, with args as camelCase query
      // params (was POST /api/assertion/{name}/query with a JSON body).
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe('/api/knowledge-assets/notes/wm/quads');
      expect(parsed.searchParams.get('contextGraphId')).toBe('ctx');
      expect(parsed.searchParams.get('subGraphName')).toBe('protocols');
      expect(parsed.searchParams.has('sparql')).toBe(false);
      expect(init.body).toBeUndefined();
    });


    it('dkg_knowledge_asset_history forwards snake_case → camelCase query params (GET, no body)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ createdAt: 't' });
      await byName.get('dkg_knowledge_asset_history')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        agent_address: '0xabc',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const parsed = new URL(String(url));
      // rc.17 KA-routes-unification: history reads moved to the unified KA route;
      // author scoping is preserved via the agentAddress query param.
      expect(parsed.pathname).toBe('/api/knowledge-assets/notes');
      expect(parsed.searchParams.get('contextGraphId')).toBe('ctx');
      expect(parsed.searchParams.get('agentAddress')).toBe('0xabc');
      expect(parsed.searchParams.get('subGraphName')).toBe('protocols');
      expect(init.body).toBeUndefined();
    });


    it('dkg_knowledge_asset_import_file reads the file and forwards camelCase multipart fields (.md → text/markdown)', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ assertionUri: 'urn:x' });
      const { writeFileSync, mkdtempSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { tmpdir } = await import('node:os');
      const tmpDir = mkdtempSync(join(tmpdir(), 'dkg-test-'));
      const filePath = join(tmpDir, 'doc.md');
      writeFileSync(filePath, '# Hello\n');

      await byName.get('dkg_knowledge_asset_import_file')!.execute('tc', {
        context_graph_id: 'ctx',
        name: 'notes',
        file_path: filePath,
        ontology_ref: 'urn:onto',
        sub_graph_name: 'protocols',
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9200/api/knowledge-assets/notes/wm/import-file');
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
