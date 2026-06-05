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


    it('dkg_share falls back to an anonymous unique subject when node identity is unresolved', async () => {
      // Without an injected nodePeerId, ensureNodeAgentAddress/ensureNodePeerId
      // both no-op (no memoryResolverApi). The direct /api/agent/identity
      // probe returns the default mock payload which lacks agentAddress and
      // peerId. The handler must NOT refuse the share — /api/shared-memory/write
      // doesn't require identity preflight. Mint a unique-per-call anonymous
      // subject so the upsert problem is still avoided and authorship just
      // degrades to anon attribution.
      const { fetchMock, byName } = setupPluginWithFetch(
        { shareOperationId: 'op-noid' },
        { skipNodeIdInjection: true },
      );
      const result = await byName.get('dkg_share')!.execute('tc', {
        content: 'hello',
        context_graph_id: 'ctx',
      });
      const body = JSON.parse(result.content[0].text);
      expect(body.shareOperationId).toBe('op-noid');
      expect(body.subject).toMatch(/^urn:openclaw:anon:shared:\d+-[a-z0-9]+$/);
      expect(body.root_entities).toEqual([body.subject]);
      // The actual share write must have happened.
      const shareCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('/api/shared-memory/write'));
      expect(shareCalls.length).toBe(1);
    });


    it('dkg_share UCHAR-encodes non-ECHAR control bytes (NUL, VT, DEL) the canonical escaper leaves raw', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-uchar' });
      // escapeDkgRdfLiteral covers \b, \t, \n, \f, \r — but leaves NUL (0x00),
      // VT (0x0B), DEL (0x7F), etc. untouched. Those would produce invalid
      // N-Triples at the storage layer. Defensive post-pass UCHAR-encodes them.
      const NUL = String.fromCharCode(0x00);
      const VT = String.fromCharCode(0x0B);
      const DEL = String.fromCharCode(0x7F);
      await byName.get('dkg_share')!.execute('tc', {
        content: `a${NUL}b${VT}c${DEL}d`,
        context_graph_id: 'ctx',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.quads[0].object).toBe('"a\\u0000b\\u000Bc\\u007Fd"');
    });


    it('dkg_share plumbs sub_graph_name through to subGraphName for sub-graph-scoped writes', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ shareOperationId: 'op-4' });
      await byName.get('dkg_share')!.execute('tc', {
        content: 'hello',
        context_graph_id: 'ctx',
        sub_graph_name: 'protocols',
      });
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.subGraphName).toBe('protocols');
    });


    it('dkg_share surfaces daemon-offline failures via the standard daemonError helper', async () => {
      const fetchMock = vi.fn(async () => { throw new Error('fetch failed: ECONNREFUSED'); });
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
      // Mirror setupPluginWithFetch's identity injection so the handler
      // gets past the unresolved-identity guard and reaches the fetch.
      (plugin as any).nodePeerId = '12D3KooTestPeerId';
      const byName = new Map(tools.map((t) => [t.name, t] as const));
      const result = await byName.get('dkg_share')!.execute('tc', {
        content: 'hello',
        context_graph_id: 'ctx',
      });
      expect(result.content[0].text).toContain('DKG daemon is not reachable');
    });


    it('dkg_query explicitly rejects the v9 contextGraph_id field with a clear error', async () => {
      // V10-rc is the first product release; there is no v9 back-compat on the
      // public tool surface. Silently ignoring `contextGraph_id` would let stale v9
      // agent code run unscoped queries thinking it was scoping them — a
      // dangerous failure mode. The handler rejects the field explicitly so
      // the caller's wrong assumption surfaces instead of producing garbage.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        contextGraph_id: 'my-cg',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('contextGraph_id');
      expect(result.content[0].text).toContain('context_graph_id');
    });


    it('dkg_query rejects the legacy include_shared_memory field with a hint that names the union-semantics break', async () => {
      // The boolean was removed in favor of `view`. There is NO
      // one-line replacement: legacy `true` unioned the data graph with
      // SWM (engine wraps sparql in both and merges), which no single
      // `view` reproduces. `view: "shared-working-memory"` reads only
      // SWM and silently drops data-graph triples for `true` callers.
      // The hint must surface this break explicitly and name the HTTP
      // escape hatch for callers who need the exact union.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        include_shared_memory: true,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const msg = result.content[0].text;
      expect(msg).toContain('include_shared_memory');
      expect(msg).toContain('view');
      // Surface the non-equivalence.
      expect(msg).toMatch(/no exact|no single `view`/i);
      // Name the HTTP escape hatch for callers who need the original
      // union semantics — otherwise they have no migration path at all.
      expect(msg).toContain('/api/query');
      expect(msg).toContain('includeSharedMemory');
      // Also name the SWM closest-intent replacement + the omit path.
      expect(msg).toContain('shared-working-memory');
      expect(msg).toMatch(/omit/i);
    });


    it('dkg_query forwards an explicit agent_address to the daemon body for WM reads (T65 — checksums eth)', async () => {
      // WM reads are agent-scoped; the daemon requires an agentAddress.
      // T65 — Eth-shaped values are normalized to EIP-55 checksum form
      // before forwarding so they match the daemon's checksum-case graph
      // URI prefix. Caller-supplied lowercase wallet input → checksum on
      // the wire.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const ethLowercase = '0x26c9b05a30138b35e84e60a5b778d580065ffbb8';
      const ethChecksum = '0x26c9B05a30138b35e84e60A5B778d580065Ffbb8';
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: ethLowercase,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.view).toBe('working-memory');
      expect(body.agentAddress).toBe(ethChecksum);
    });


    it('dkg_query rejects a whitespace-only agent_address (same silent-namespace-swap risk as non-string)', async () => {
      // An explicitly-supplied whitespace string is still "caller meant
      // something here" — treating `"   "` as "missing" and defaulting
      // to `this.nodePeerId` would silently swap a cross-agent read for
      // a self-read, same failure mode as the non-string case.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: '   ',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('agent_address');
      expect(result.content[0].text).toMatch(/non-empty|empty/i);
    });


    it('dkg_query `view` validation uses the shared GET_VIEWS from dkg-core (no local mirror)', async () => {
      // Guard against the local VALID_VIEWS mirror being reintroduced.
      // When a view is added to core's GET_VIEWS but the adapter
      // maintains its own list, the tool silently rejects the new
      // view before the daemon can serve it. The handler must use
      // the shared constant so this class of drift can't happen.
      //
      // We verify behavior (not import graph): the error message lists
      // exactly the three views core publishes today, and a v9-removed
      // view is rejected.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        view: 'authoritative', // a REMOVED_VIEWS entry from core
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const text = result.content[0].text;
      expect(text).toContain('working-memory');
      expect(text).toContain('shared-working-memory');
      expect(text).toContain('verified-memory');
    });


    it('dkg_query rejects a non-string agent_address instead of silently falling back to the node peerId', async () => {
      // Permissive hosts can pass through non-string values. If the
      // handler treated those as "missing", `view: "working-memory"`
      // would default to this node's peerId — a caller intending a
      // cross-agent WM read with a malformed value would silently get
      // the node's own WM back. Surface the bug instead: reject with
      // a clear type-error, don't leak namespaces.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: 12345,
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.content[0].text).toContain('agent_address');
      expect(result.content[0].text).toContain('string');
    });


    it('dkg_query normalizes DID-prefixed eth agent_address for WM reads (T31/T48)', async () => {
      // T48 — Post-PR-264 WM is scoped by the daemon's eth address.
      // T65 — DID-prefixed eth values: prefix stripped THEN checksummed
      // (operator may supply lowercase under the DID wrapper; canonical
      // EIP-55 must reach the daemon).
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const ethLowercase = '0x26c9b05a30138b35e84e60a5b778d580065ffbb8';
      const ethChecksum = '0x26c9B05a30138b35e84e60A5B778d580065Ffbb8';
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: `did:dkg:agent:${ethLowercase}`,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.agentAddress).toBe(ethChecksum);
      // DID prefix gone.
      expect(body.agentAddress).not.toContain('did:dkg:agent:');
    });


    it('dkg_query falls back to nodePeerId when agent_address is omitted before identity resolves', async () => {
      // Handler default for omitted agent_address must mirror the
      // daemon's writer-side `defaultAgentAddress ?? peerId` priority.
      const { fetchMock, byName, plugin } = setupPluginWithFetch({ ok: true });
      (plugin as any).nodeAgentAddress = undefined;
      (plugin as any).nodePeerId = '12D3KooWNoKeystorePeer';
      (plugin as any).ensureNodeAgentAddress = vi.fn().mockResolvedValue(undefined);
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        // agent_address intentionally omitted
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.view).toBe('working-memory');
      expect(body.agentAddress).toBe('12D3KooWNoKeystorePeer');
    });


    it('dkg_query errors when neither daemon identity nor peerId fallback is available', async () => {
      const { fetchMock, byName, plugin } = setupPluginWithFetch({ ok: true });
      (plugin as any).nodeAgentAddress = undefined;
      (plugin as any).nodePeerId = undefined;
      (plugin as any).ensureNodeAgentAddress = vi.fn().mockResolvedValue(undefined);
      (plugin as any).ensureNodePeerId = vi.fn().mockResolvedValue(undefined);
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const text = result.content[0].text;
      expect(text).toContain('working-memory');
      expect(text).toContain('agent identity');
      expect(text).not.toContain('DKG_AGENT_ADDRESS');
      expect(text).not.toContain('dkgHome');
    });


    it('dkg_query forwards peerId-form WM agent_address verbatim (T48/T53 — daemon accepts as self-alias on no-keystore nodes)', async () => {
      // T53 supersedes T48's hard-rejection. The daemon's `/api/query`
      // accepts peerId as a valid self-alias for the default agent
      // when no keystore identity exists (writes go to peerId in that
      // case via `defaultAgentAddress ?? peerId`). Adapter-side hard-
      // rejection broke a legitimate read path. Forward the value
      // verbatim and let the daemon's scope rules decide.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      // DID-wrapped peerId: legacy DID prefix stripped, peerId forwarded.
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: 'did:dkg:agent:12D3KooWExamplePeerId',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      let body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.agentAddress).toBe('12D3KooWExamplePeerId');

      // Bare peerId: passes through unchanged.
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'working-memory',
        agent_address: '12D3KooWExamplePeerId',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      body = JSON.parse(fetchMock.mock.calls[1][1]?.body as string);
      expect(body.agentAddress).toBe('12D3KooWExamplePeerId');
    });


    it('dkg_query does NOT normalize agent_address on non-WM views (it only matters for WM routing)', async () => {
      // Non-WM views don't use `agentAddress` for graph resolution —
      // leave the value untouched so other downstream uses (e.g. audit
      // logging at the daemon) see the caller's original input.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        context_graph_id: 'my-cg',
        view: 'shared-working-memory',
        agent_address: 'did:dkg:agent:12D3KooWExamplePeerId',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
      expect(body.agentAddress).toBe('did:dkg:agent:12D3KooWExamplePeerId');
    });


    it('dkg_query rejects an invalid `view` string with the list of valid layers', async () => {
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        view: 'long-term-memory', // a v9 view name, removed in v10
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const text = result.content[0].text;
      expect(text).toContain('view');
      expect(text).toContain('working-memory');
      expect(text).toContain('shared-working-memory');
      expect(text).toContain('verified-memory');
    });


    it('dkg_query rejects a `view` without `context_graph_id` locally (no daemon round-trip)', async () => {
      // Engine throws "view '…' requires a contextGraphId" — catch it at
      // the tool boundary so callers see a clean, tool-shaped error
      // instead of a cryptic 500 from a round-trip.
      const { fetchMock, byName } = setupPluginWithFetch({ ok: true });
      const result = await byName.get('dkg_query')!.execute('tc', {
        sparql: 'SELECT * WHERE { ?s ?p ?o } LIMIT 1',
        view: 'shared-working-memory',
        // context_graph_id intentionally omitted
      });
      expect(fetchMock).not.toHaveBeenCalled();
      const msg = result.content[0].text;
      expect(msg).toContain('context_graph_id');
      expect(msg).toContain('shared-working-memory');
    });


    it('dkg_query description accurately describes the no-`view` routing (legacy path, not WM)', () => {
      // Documented-vs-actual: when `view` is omitted, the daemon +
      // DKGQueryEngine route through the legacy V9 data-graph path
      // (`DKGQueryEngine.query` → the `if (options?.view)` branch is
      // SKIPPED and falls through to "Legacy routing (V9 compat)"). It
      // is NOT implicit working-memory semantics, despite some stale
      // comments in the daemon hinting otherwise. This test guards the
      // tool description against re-introducing the misleading "omit
      // for WM" claim.
      const plugin = new DkgNodePlugin();
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const query = tools.find((t) => t.name === 'dkg_query')!;
      // Positive: description must call out the legacy routing for the omit case.
      expect(query.description).toMatch(/legacy/i);
      // Negative: specifically guard against re-introducing the misleading
      // "omit → WM default" phrasing. Use targeted substrings that would
      // only appear in the wrong claim, not the correct HTTP escape-hatch
      // sentence that mentions working-memory by name.
      expect(query.description).not.toMatch(/omit[^.]*default[^.]*working-memory/i);
      expect(query.description).not.toMatch(/default[^.]*WM semantics/i);
      expect(query.description).not.toMatch(/Omit `?view`? for the default/i);
    });


    it('dkg_query description steers WM reads toward current_agent_address and retries identity variants', () => {
      const plugin = new DkgNodePlugin();
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const query = tools.find((t) => t.name === 'dkg_query')!;
      const agentAddress = query.parameters.properties.agent_address as { description?: string };

      expect(query.description).toContain('current_agent_address');
      expect(query.description).toMatch(/retry alternate identity forms/i);
      expect(agentAddress.description).toContain('current_agent_address');
      // T48/T49/T53 — schema names eth-address shape as the recommended
      // form, accepts peerId as self-alias on no-keystore nodes,
      // documents the legacy `did:dkg:agent:` strip.
      expect(agentAddress.description).toMatch(/0x-prefixed eth address/i);
      expect(agentAddress.description).toMatch(/peer ID/i);
      expect(agentAddress.description).toMatch(/did:dkg:agent:/);
    });


    it('share-flow tool descriptions prefer invite code output for friend-sharing requests', () => {
      const plugin = new DkgNodePlugin();
      const tools: OpenClawTool[] = [];
      plugin.register({
        config: {},
        registerTool: (t) => tools.push(t),
        registerHook: () => {},
        on: () => {},
        logger: {},
      });
      const byName = new Map(tools.map((t) => [t.name, t] as const));

      expect(byName.get('dkg_context_graph_invite')!.description).toContain('ready-to-share invite code');
      expect(byName.get('dkg_context_graph_invite')!.description).toContain('paste into Join');
      expect(byName.get('dkg_participant_add')!.description).toContain('allowlisting alone is not the full UI join flow');
    });
  });
});
