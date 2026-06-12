/**
 * Live MCP tool-surface ↔ daemon coverage (opt-in, real node, NO mocks).
 *
 * Why this file exists
 * --------------------
 * The per-PR unit tests in this package are mock-free (the in-memory
 * `FakeClient` daemon double was retired): they cover registration, zod
 * schemas, and pre-network guards — but by design they never perform a
 * daemon round-trip, so they are structurally blind to the failure mode a
 * teammate hit in rc.17: "the agent tool surface wasn't updated all the way
 * with the new API and KA logic." A renamed endpoint, a reshaped response,
 * a tightened `view` enum, or a renamed body field is only caught by a
 * real round-trip.
 *
 * This suite is that round-trip. It wires the REAL `DkgClient`
 * (real global `fetch` → real daemon) plus the REAL `register*Tools()`
 * surface (the exact registration sequence from `src/index.ts`) and
 * exercises EVERY MCP tool end-to-end against a RUNNING devnet node —
 * read, setup, the full Knowledge-Asset lifecycle, publish (incl. the
 * finalized-publish option plumbing), health, agent-to-agent chat
 * (a genuine two-node encrypted round-trip), and memory search. Anything
 * the daemon renames/reshapes makes the corresponding tool call fail here.
 *
 * It complements:
 *   - `mcp-daemon-contract.integration.test.ts` — the client-method KA
 *     lifecycle contract (write→finalize→share→publish at the client layer).
 *   - `client-daemon-endpoint-contract.test.ts` — the static, every-PR
 *     path/verb drift net (no daemon).
 * This file is the broad TOOL-HANDLER net: every `server.call(tool, …)`
 * actually hits the daemon.
 *
 * Why it's opt-in
 * ---------------
 * It needs a real DKG daemon (and a funded node on a chain for the
 * VM-publish legs) plus a SECOND node for the chat round-trip. That's too
 * heavy for the per-PR unit lane, so it is gated behind
 * `MCP_INTEGRATION_TEST=1` and SKIPS otherwise (mirroring
 * `cli/test/blazegraph-integration.test.ts`). Run it against a devnet:
 *
 *   MCP_INTEGRATION_TEST=1 \
 *   DKG_API=http://127.0.0.1:9201 \
 *   DKG_API2=http://127.0.0.1:9202 \        # second node, for the chat leg
 *   DKG_TOKEN=<node-token> \                 # 2nd line of .devnet/nodeN/auth.token
 *   DKG_PROJECT=devnet-test \                # an on-chain-registered CG
 *     npx vitest run test/mcp-tool-surface.integration.test.ts
 *
 * (or `pnpm --filter @origintrail-official/dkg-mcp test:integration`).
 * The chat round-trip is skipped (not failed) when DKG_API2 is unset, so a
 * single-node operator still gets the rest of the coverage.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DkgClient } from '../src/client.js';
import { registerReadTools } from '../src/tools.js';
import { registerAssertionTools } from '../src/tools/assertions.js';
import { registerMemorySearchTool } from '../src/tools/memory-search.js';
import { registerSetupTools } from '../src/tools/setup.js';
import { registerHealthTools } from '../src/tools/health.js';
import { registerPublishTools } from '../src/tools/publish.js';
import { registerChatTools } from '../src/tools/chat.js';
import { FakeServer, makeConfig } from './harness.js';
import type { DkgConfig } from '../src/config.js';
import type { ToolResult } from './harness.js';

const ENABLED = process.env.MCP_INTEGRATION_TEST === '1';

const API = process.env.DKG_API ?? 'http://127.0.0.1:9201';
const API2 = process.env.DKG_API2 ?? process.env.DKG_API_2 ?? '';
const TOKEN = process.env.DKG_TOKEN ?? '';
const TOKEN2 = process.env.DKG_TOKEN2 ?? process.env.DKG_TOKEN ?? '';
const CG = process.env.DKG_PROJECT ?? process.env.DKG_CG ?? 'devnet-test';

const RUN = `mcpts-${Date.now().toString(36)}`;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PUBLISH_TIMEOUT_MS = 180_000;

/**
 * `FakeServer` here is NOT a daemon mock — it is the in-process MCP
 * transport shell (it records `registerTool` calls and invokes the real
 * handler with zod-parsed input, exactly like the production MCP SDK
 * does). The handlers it invokes call the REAL `DkgClient` against the
 * REAL daemon, so every `server.call(...)` below is a true round-trip.
 */
function buildSurface(config: DkgConfig): { server: FakeServer; client: DkgClient } {
  const client = new DkgClient({ config }); // real global fetch → real daemon
  const server = new FakeServer();
  const mcp = server.asMcpServer();
  registerReadTools(mcp, client, config);
  registerAssertionTools(mcp, client, config);
  registerMemorySearchTool(mcp, client, config);
  registerSetupTools(mcp, client, config);
  registerHealthTools(mcp, client, config);
  registerPublishTools(mcp, client, config);
  registerChatTools(mcp, client, config);
  return { server, client };
}

function notError(res: ToolResult, label: string): string {
  expect(res.isError, `${label} returned a tool error: ${res.content?.[0]?.text}`).not.toBe(true);
  const text = res.content?.[0]?.text ?? '';
  expect(text, `${label} returned empty text`).toBeTruthy();
  return text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!ENABLED)('MCP tool surface ↔ live daemon (no mocks)', () => {
  let server: FakeServer;
  let client: DkgClient;
  let peerId: string;
  let agentDid: string;
  let tempDir: string;

  beforeAll(async () => {
    if (!TOKEN) {
      throw new Error(
        'MCP_INTEGRATION_TEST=1 but DKG_TOKEN is empty. Export the daemon API token ' +
          '(2nd line of .devnet/nodeN/auth.token) or unset MCP_INTEGRATION_TEST to skip.',
      );
    }
    const config = makeConfig({
      api: API,
      token: TOKEN,
      defaultProject: CG,
      agentUri: 'urn:dkg:agent:mcp-tool-surface-test',
    });
    ({ server, client } = buildSurface(config));

    let identity: Awaited<ReturnType<DkgClient['getAgentIdentity']>>;
    try {
      identity = await client.getAgentIdentity();
    } catch (e) {
      throw new Error(
        `Could not reach the DKG daemon at ${API} (GET /api/agent/identity failed: ${
          e instanceof Error ? e.message : String(e)
        }). Is the node running and is DKG_TOKEN correct?`,
      );
    }
    peerId = String(identity.peerId ?? '');
    agentDid = String(identity.agentDid ?? identity.agentAddress ?? '');
    expect(peerId, 'daemon /api/agent/identity returned no peerId').toBeTruthy();

    // Idempotent provisioning so the suite is self-contained.
    await client.createContextGraph({ id: CG, name: CG });
    await client.registerContextGraph({ id: CG });

    tempDir = await mkdtemp(path.join(tmpdir(), 'mcp-ts-'));
  }, 120_000);

  // ── Read tools ────────────────────────────────────────────────────
  describe('read tools', () => {
    it('dkg_list_context_graphs (mine) lists the target CG', async () => {
      const text = notError(await server.call('dkg_list_context_graphs', { scope: 'mine' }), 'list_context_graphs(mine)');
      expect(text).toContain(CG);
    });

    it('dkg_list_context_graphs (all) round-trips', async () => {
      notError(await server.call('dkg_list_context_graphs', { scope: 'all' }), 'list_context_graphs(all)');
    });

    it('dkg_sub_graph_list round-trips', async () => {
      notError(await server.call('dkg_sub_graph_list', { projectId: CG }), 'sub_graph_list');
    });

    it('dkg_query (SELECT, working-memory) renders a result table', async () => {
      notError(
        await server.call('dkg_query', {
          sparql: 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 3',
          projectId: CG,
          view: 'working-memory',
        }),
        'query(wm)',
      );
    });

    it('dkg_query (shared-working-memory) round-trips', async () => {
      notError(
        await server.call('dkg_query', {
          sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
          projectId: CG,
          view: 'shared-working-memory',
        }),
        'query(swm)',
      );
    });

    it('dkg_query (verifiable-memory) round-trips', async () => {
      notError(
        await server.call('dkg_query', {
          sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
          projectId: CG,
          view: 'verifiable-memory',
        }),
        'query(vm)',
      );
    });

    it('dkg_get_entity round-trips for an arbitrary URI', async () => {
      notError(
        await server.call('dkg_get_entity', { uri: agentDid || `urn:dkg:agent:${peerId}`, projectId: CG }),
        'get_entity',
      );
    });

    it('dkg_list_activity round-trips', async () => {
      notError(await server.call('dkg_list_activity', { projectId: CG, limit: 5 }), 'list_activity');
    });

    it('dkg_get_agent round-trips for this node\'s agent', async () => {
      notError(await server.call('dkg_get_agent', { projectId: CG, agentUri: agentDid }), 'get_agent');
    });

    // DID-form contextGraphId normalization, validated END-TO-END against
    // the real daemon (replaces the retired fake-fetcher URL-capture unit
    // tests in setup-publish-health.test.ts). If the client's
    // `normalizeContextGraphId` stripping/encoding produced something the
    // daemon doesn't understand, these calls would 400/throw.
    it('accepts a full did:dkg:context-graph CG id on query', async () => {
      const r = await client.query({
        sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
        contextGraphId: `did:dkg:context-graph:${CG}`,
        view: 'shared-working-memory',
      });
      expect(Array.isArray(r.bindings)).toBe(true);
    });

    it('accepts a full did:dkg:context-graph CG id on listSubGraphs', async () => {
      const rows = await client.listSubGraphs(`did:dkg:context-graph:${CG}`);
      expect(Array.isArray(rows)).toBe(true);
    });

    it('accepts a full did:dkg:context-graph CG id on subscribe', async () => {
      const res = await client.subscribe({ contextGraphId: `did:dkg:context-graph:${CG}` });
      expect(res).toBeTypeOf('object');
    });
  });

  // ── Setup tools ───────────────────────────────────────────────────
  describe('setup tools', () => {
    it('dkg_context_graph_create is idempotent on the existing CG', async () => {
      // Re-creating the registered CG must surface the already-exists path,
      // proving the daemon's idempotency signal survives the round-trip.
      const text = notError(
        await server.call('dkg_context_graph_create', { name: CG, id: CG }),
        'context_graph_create(existing)',
      );
      expect(text).toMatch(/already exists/i);
    });

    it('dkg_context_graph_create creates a fresh CG', async () => {
      const fresh = `${RUN}-cg`;
      const text = notError(
        await server.call('dkg_context_graph_create', { name: fresh, id: fresh }),
        'context_graph_create(new)',
      );
      expect(text).toMatch(/Created context graph/i);
    });

    it('dkg_sub_graph_create is wrapper-idempotent against the daemon 409', async () => {
      notError(await server.call('dkg_sub_graph_create', { contextGraphId: CG, subGraphName: 'meta' }), 'sub_graph_create#1');
      // Second identical create must still succeed (ensureSubGraph swallows
      // the real daemon-side 409) — this is the contract the FakeClient
      // *simulated*; here it is the daemon's actual 409 being handled.
      notError(await server.call('dkg_sub_graph_create', { contextGraphId: CG, subGraphName: 'meta' }), 'sub_graph_create#2');
    });

    it('dkg_subscribe round-trips against the daemon', async () => {
      notError(await server.call('dkg_subscribe', { contextGraphId: CG }), 'subscribe');
    });
  });

  // ── Assertion lifecycle tools (ordered) ───────────────────────────
  describe('assertion lifecycle tools', () => {
    const aName = `${RUN}-anno`;
    const root = `urn:mcpts:${RUN}:s1`;
    const langTagged = '"hello world"@en';

    it('dkg_knowledge_asset_create opens a WM draft', async () => {
      const text = notError(await server.call('dkg_knowledge_asset_create', { name: aName, projectId: CG }), 'assertion_create');
      expect(text).toMatch(/Created assertion|already exists/);
    });

    it('dkg_knowledge_asset_create is idempotent (already exists on re-create)', async () => {
      const text = notError(await server.call('dkg_knowledge_asset_create', { name: aName, projectId: CG }), 'assertion_create#2');
      expect(text).toMatch(/already exists/i);
    });

    it('dkg_knowledge_asset_write appends quads (incl. an @en literal)', async () => {
      const text = notError(
        await server.call('dkg_knowledge_asset_write', {
          name: aName,
          projectId: CG,
          quads: [
            { subject: root, predicate: 'urn:p:label', object: langTagged },
            { subject: root, predicate: RDF_TYPE, object: 'urn:mcpts:Note' },
          ],
        }),
        'assertion_write',
      );
      expect(text).toMatch(/Wrote 2 quad/);
    });

    it('dkg_knowledge_asset_query dumps the draft and preserves the @en tag', async () => {
      const text = notError(await server.call('dkg_knowledge_asset_query', { name: aName, projectId: CG }), 'assertion_query');
      expect(text).toMatch(/2 quad/);
      // The @en lang-tag must round-trip through the real daemon + JSON dump.
      expect(text).toContain('@en');
    });

    it('dkg_knowledge_asset_share promotes a root entity to SWM', async () => {
      const text = notError(
        await server.call('dkg_knowledge_asset_share', { name: aName, projectId: CG, entities: [root] }),
        'assertion_share',
      );
      expect(text).toMatch(/Shared 1 entity/);
    });

    it('share MOVES the promoted quads WM → SWM (the real daemon empties the draft)', async () => {
      // rc.17 contract: promote/share deletes the shared subset from the WM
      // draft (production `store.delete(... graph: wmGraphUri)`). Both quads
      // above share the promoted root, so the post-share WM dump must be
      // empty — proven against the REAL store, not a hand-model of it.
      const text = notError(await server.call('dkg_knowledge_asset_query', { name: aName, projectId: CG }), 'post-share query');
      expect(text).toMatch(/0 quad/);
    });

    it('dkg_knowledge_asset_history returns a lifecycle descriptor', async () => {
      notError(await server.call('dkg_knowledge_asset_history', { name: aName, projectId: CG }), 'assertion_history');
    });

    // ── rc.17 seal contract + the 3 new lifecycle verbs, end-to-end ──
    // finalize seals the WHOLE draft; a SUBSET share does NOT auto-seal;
    // vm/publish reconstructs the seal's root set so it must hard-fail on
    // an unsealed draft. All proven by the REAL daemon's responses (the
    // retired FakeClient hand-modeled exactly these rules — and could
    // silently diverge from them).
    describe('seal contract: subset-share → publish blocked → finalize → publish → pull_from', () => {
      const sName = `${RUN}-seal`;
      const sRoot = `urn:mcpts:${RUN}:seal1`;
      const sOther = `urn:mcpts:${RUN}:seal2`;

      it('create + write a two-root draft', async () => {
        notError(await server.call('dkg_knowledge_asset_create', { name: sName, projectId: CG }), 'seal:create');
        const text = notError(
          await server.call('dkg_knowledge_asset_write', {
            name: sName,
            projectId: CG,
            quads: [
              { subject: sRoot, predicate: RDF_TYPE, object: 'urn:mcpts:Note' },
              { subject: sOther, predicate: RDF_TYPE, object: 'urn:mcpts:Note' },
            ],
          }),
          'seal:write',
        );
        expect(text).toMatch(/Wrote 2 quad/);
      });

      it('a SUBSET share does not auto-seal, and leaves the unshared root in WM', async () => {
        notError(
          await server.call('dkg_knowledge_asset_share', { name: sName, projectId: CG, entities: [sRoot] }),
          'seal:subset-share',
        );
        // Only sRoot's quad moved out of the WM draft; sOther's stays.
        const text = notError(await server.call('dkg_knowledge_asset_query', { name: sName, projectId: CG }), 'seal:post-subset-query');
        expect(text).toMatch(/1 quad/);
        expect(text).toContain(sOther);
      });

      it('publish on the UNSEALED draft is rejected by the real daemon', async () => {
        const res = await server.call('dkg_knowledge_asset_publish', { name: sName, projectId: CG });
        expect(res.isError, 'publish must fail on an unsealed draft (subset share does not auto-seal)').toBe(true);
        expect(res.content[0].text).toMatch(/seal|finaliz|precondition/i);
      });

      it('dkg_knowledge_asset_finalize seals the draft', async () => {
        notError(await server.call('dkg_knowledge_asset_finalize', { name: sName, projectId: CG }), 'seal:finalize');
      });

      it('dkg_knowledge_asset_pull_from plumbs the route and surfaces the daemon seal-requirement verbatim (GH #1094 live)', async () => {
        // Verified against the REAL daemon (every reachable path probed:
        // wm/finalize-then-share, share-all auto-seal, and even the default
        // atomic create that returns a merkleRoot): the route's "sealed
        // entity list" store is never populated, so pull-from 500s with
        // "No sealed entity list … pull-from requires a finalized assertion"
        // on ALL paths — the GH #1094 bug (red repro in the devnet
        // issue-liveness suite; fix tracked on PR #1107). What the TOOL
        // SURFACE owns — reaching the right route and rendering the daemon's
        // response verbatim — is exactly what this asserts. The moment the
        // #1094 fix lands and the route starts seeding drafts, this test goes
        // red and MUST be upgraded to the positive leg:
        //   share(all) → pull_from {layer:"swm"/"vm", onConflict:"replace"}
        //   → expect(/Seeded a WM draft/).
        notError(
          await server.call('dkg_knowledge_asset_share', { name: sName, projectId: CG }),
          'seal:share-all',
        );
        const res = await server.call('dkg_knowledge_asset_pull_from', { name: sName, projectId: CG, layer: 'swm', onConflict: 'replace' });
        expect(res.isError, 'pull_from unexpectedly succeeded — #1094 fix landed? Upgrade this test to the positive seeding leg.').toBe(true);
        expect(res.content[0].text).toMatch(/No sealed entity list|requires a finalized assertion/);
      });

      it(
        'finalize → share(all) → publish mints the sealed asset on-chain (canonical order)',
        async () => {
          // The real daemon's publish reconstructs the seal's root set OUT OF
          // SWM — the earlier subset share only moved sRoot there, so the
          // sealed remainder had to be shared too (done above) before publish
          // can select it. (Verified live: publishing without that share 409s
          // with "No quads in shared memory … matching selection".)
          const text = notError(
            await server.call('dkg_knowledge_asset_publish', { name: sName, projectId: CG }),
            'seal:publish',
          );
          expect(text).toMatch(/did:dkg:/);
        },
        PUBLISH_TIMEOUT_MS,
      );
    });

    it('write accepts (and the client strips) a forged per-quad graph — real daemon round-trip', async () => {
      // CONTRACT §A: the daemon pins quads to the per-KA WM graph; the
      // client drops any caller-supplied `graph` before the POST. Proven
      // here by the real daemon ACCEPTING the write and the quad landing
      // in the KA's WM draft (a non-stripped graph would either 400 or
      // land outside the draft and break the query-back).
      const gName = `${RUN}-graphstrip`;
      notError(await server.call('dkg_knowledge_asset_create', { name: gName, projectId: CG }), 'graphstrip:create');
      notError(
        await server.call('dkg_knowledge_asset_write', {
          name: gName,
          projectId: CG,
          quads: [{ subject: `urn:mcpts:${RUN}:g1`, predicate: RDF_TYPE, object: 'urn:mcpts:Note', graph: 'urn:my-graph:forged' }],
        }),
        'graphstrip:write',
      );
      const text = notError(await server.call('dkg_knowledge_asset_query', { name: gName, projectId: CG }), 'graphstrip:query');
      expect(text).toMatch(/1 quad/);
      expect(text).toContain(`urn:mcpts:${RUN}:g1`);
    });

    it('dkg_knowledge_asset_import_file imports a local markdown file', async () => {
      const filePath = path.join(tempDir, 'notes.md');
      await writeFile(filePath, '# Imported Heading\n\nA short markdown body for extraction.\n', 'utf-8');
      const text = notError(
        await server.call('dkg_knowledge_asset_import_file', { name: `${RUN}-import`, projectId: CG, filePath }),
        'assertion_import_file',
      );
      expect(text).toMatch(/Imported 'notes\.md'/);
      expect(text).toMatch(/Extraction status/);
    });

    // ── Imported-artifact trio: resolve → read markdown → semantic
    // enrichment, all against the REAL content-addressed file store.
    // The MCP import tool's text output doesn't echo the assertion URI,
    // so the seed import goes through the REAL client (same call the
    // tool handler makes) to capture `assertionUri` from the daemon's
    // response — then every tool below round-trips on that real URI.
    describe('imported-artifact tools (resolve / read-markdown / enrichment)', () => {
      const trioName = `${RUN}-trio`;
      const trioHeading = `Trio Heading ${RUN}`;
      let trioUri = '';

      it('seed import returns a real assertionUri', async () => {
        const filePath = path.join(tempDir, 'trio.md');
        await writeFile(filePath, `# ${trioHeading}\n\nBody bytes for the artifact trio round-trip.\n`, 'utf-8');
        const { readFile } = await import('node:fs/promises');
        const result = await client.importAssertionFile({
          contextGraphId: CG,
          assertionName: trioName,
          fileBuffer: await readFile(filePath),
          fileName: 'trio.md',
          contentType: 'text/markdown',
        });
        trioUri = String((result as Record<string, unknown>).assertionUri ?? '');
        expect(trioUri, 'daemon import response must carry assertionUri').toMatch(/^did:dkg:/);
      });

      it('dkg_knowledge_asset_import_artifact_resolve resolves the imported artifact metadata', async () => {
        const text = notError(
          await server.call('dkg_knowledge_asset_import_artifact_resolve', { projectId: CG, assertionUri: trioUri }),
          'import_artifact_resolve',
        );
        // Deterministic metadata from the REAL store: the source file hash
        // and the markdown readability flag.
        expect(text).toMatch(/"fileHash"/);
        expect(text).toMatch(/"canReadMarkdown": true/);
      });

      it('dkg_knowledge_asset_import_artifact_read_markdown returns the real stored bytes', async () => {
        const text = notError(
          await server.call('dkg_knowledge_asset_import_artifact_read_markdown', { projectId: CG, assertionUri: trioUri, maxBytes: 4096 }),
          'import_artifact_read_markdown',
        );
        // The exact heading written above must come back out of the
        // content-addressed store — a true byte round-trip.
        expect(text).toContain(trioHeading);
      });

      it('dkg_knowledge_asset_semantic_enrichment_write appends model triples with provenance', async () => {
        const text = notError(
          await server.call('dkg_knowledge_asset_semantic_enrichment_write', {
            projectId: CG,
            assertionUri: trioUri,
            semanticQuads: [
              { subject: `urn:mcpts:${RUN}:doc`, predicate: 'http://schema.org/about', object: '"Semantic topic"' },
            ],
            generationMethod: 'mcp-live-test',
          }),
          'semantic_enrichment_write',
        );
        expect(text).toContain(trioUri);
      });

      it('zod (.strict()) rejects enrichment quads that smuggle a graph field', async () => {
        await expect(
          server.call('dkg_knowledge_asset_semantic_enrichment_write', {
            projectId: CG,
            assertionUri: trioUri,
            semanticQuads: [
              { subject: 'urn:x', predicate: 'urn:p', object: '"v"', graph: 'urn:forged' },
            ],
          }),
        ).rejects.toThrow();
      });
    });

    it('dkg_knowledge_asset_discard drops the WM draft (real daemon semantics)', async () => {
      // NOTE: the retired FakeClient modeled discard as a permanent
      // tombstone that made later writes throw. The REAL daemon treats
      // discard as "drop the current WM draft" — querying afterwards shows
      // an empty/zero-quad draft. Asserting the mock's fictional behavior
      // here is exactly the false-confidence we are removing, so this pins
      // the daemon's actual contract instead.
      const dName = `${RUN}-discard`;
      notError(await server.call('dkg_knowledge_asset_create', { name: dName, projectId: CG }), 'discard:create');
      notError(
        await server.call('dkg_knowledge_asset_write', {
          name: dName,
          projectId: CG,
          quads: [{ subject: `urn:mcpts:${RUN}:d`, predicate: 'urn:p', object: '"v"' }],
        }),
        'discard:write',
      );
      const before = notError(await server.call('dkg_knowledge_asset_query', { name: dName, projectId: CG }), 'discard:query-before');
      expect(before).toMatch(/1 quad/);
      notError(await server.call('dkg_knowledge_asset_discard', { name: dName, projectId: CG }), 'discard');
      const after = notError(await server.call('dkg_knowledge_asset_query', { name: dName, projectId: CG }), 'discard:query-after');
      expect(after, 'discard should have dropped the WM draft').toMatch(/0 quad/);
    });

    // ── Client-side guards: zod + pre-HTTP validation. These hold with
    // NO daemon mock — the real client/zod reject before any network call.
    it('zod rejects a bad assertion-name slug before any daemon call', async () => {
      await expect(server.call('dkg_knowledge_asset_create', { name: 'Bad Name With Spaces', projectId: CG })).rejects.toThrow();
    });

    it('zod rejects an empty quads array on write', async () => {
      await expect(server.call('dkg_knowledge_asset_write', { name: aName, projectId: CG, quads: [] })).rejects.toThrow();
    });

    it('promote rejects an empty entities array (omit or non-empty)', async () => {
      const res = await server.call('dkg_knowledge_asset_share', { name: aName, projectId: CG, entities: [] });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/non-empty array/);
    });
  });

  // ── Health tools ──────────────────────────────────────────────────
  describe('health tools', () => {
    it('dkg_status renders the live node status', async () => {
      const text = notError(await server.call('dkg_status', {}), 'status');
      expect(text).toContain(peerId);
    });

    it('dkg_wallet_balances renders live wallet rows', async () => {
      const text = notError(await server.call('dkg_wallet_balances', {}), 'wallet_balances');
      // The node's operational wallet address (0x…) must appear.
      expect(text).toMatch(/0x[0-9a-fA-F]{6}/);
    });

    it('dkg_peer_info requires peerId (zod)', async () => {
      await expect(server.call('dkg_peer_info', {})).rejects.toThrow();
    });

    it('dkg_peer_info round-trips the live diagnostic for a connected peer', async () => {
      const targetPeer = process.env.DKG_PEER2 ?? '';
      if (!targetPeer) {
        // No explicit second-peer id: just diagnose our own peer id. The
        // daemon still returns the documented diagnostic shape.
        const text = notError(await server.call('dkg_peer_info', { peerId }), 'peer_info(self)');
        expect(text).toContain('getConnectionsReturnsForPeer');
        return;
      }
      const text = notError(await server.call('dkg_peer_info', { peerId: targetPeer }), 'peer_info(peer2)');
      expect(text).toContain(targetPeer);
      expect(text).toContain('getConnectionsReturnsForPeer');
    });
  });

  // ── Memory search ─────────────────────────────────────────────────
  describe('memory search', () => {
    it('dkg_memory_search probes identity + fans out across layers', async () => {
      // Identity resolves on a live node, so the tool runs the multi-tier
      // fan-out and returns a header even when no hits match (per-layer
      // failures are swallowed). A daemon /api/query drift would surface as
      // a thrown error in every layer → still a header, so we also assert
      // the identity-probe path didn't hard-fail.
      const text = notError(await server.call('dkg_memory_search', { query: `${RUN} probe`, projectId: CG }), 'memory_search');
      expect(text).toMatch(/Memory search/);
    });
  });

  // ── Publish tools (on-chain) ──────────────────────────────────────
  describe('publish tools', () => {
    it(
      'dkg_publish writes fresh quads to SWM and mints to VM',
      async () => {
        const text = notError(
          await server.call('dkg_publish', {
            contextGraphId: CG,
            quads: [
              { subject: `urn:mcpts:${RUN}:pub`, predicate: RDF_TYPE, object: 'urn:mcpts:Note' },
              { subject: `urn:mcpts:${RUN}:pub`, predicate: 'urn:p:label', object: 'a literal value' },
            ],
          }),
          'dkg_publish',
        );
        expect(text).toMatch(/Published/);
      },
      PUBLISH_TIMEOUT_MS,
    );

    it(
      'dkg_shared_memory_publish mints a selection-scoped root from loose SWM',
      async () => {
        // The selection-based publish reads LOOSE shared memory written via
        // POST /api/shared-memory/write — NOT the KA-lifecycle SWM that
        // alsoShareSwm/promote populates. (The retired FakeClient conflated
        // the two stores; this is the real, distinct contract.) Seed loose
        // SWM through the real daemon endpoint, then publish that one root.
        const sRoot = `urn:mcpts:${RUN}:smp`;
        const did = `did:dkg:context-graph:${CG}`;
        const seed = await fetch(`${API}/api/shared-memory/write`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({
            contextGraphId: CG,
            quads: [
              { subject: sRoot, predicate: RDF_TYPE, object: 'urn:mcpts:Note', graph: did },
              { subject: sRoot, predicate: 'urn:p:label', object: '"shared-memory publish seed body"', graph: did },
            ],
          }),
        });
        expect(seed.ok, `seed POST /api/shared-memory/write failed: ${seed.status}`).toBe(true);

        // Subset publish is deterministic and side-steps the daemon's
        // multi-root `selection: all` rejection when other SWM is present.
        const text = notError(
          await server.call('dkg_shared_memory_publish', { contextGraphId: CG, rootEntities: [sRoot] }),
          'shared_memory_publish',
        );
        expect(text).toMatch(/Published/);
        expect(text).toMatch(/Roots: 1/);
      },
      PUBLISH_TIMEOUT_MS,
    );

    it(
      'finalized-publish option plumbing (options nesting) survives a real round-trip',
      async () => {
        // The de-mocked replacement for knowledge-assets-client.test.ts's
        // fake-fetcher "nests under options" assertion: drive the REAL
        // create→write→finalize→publish path with the finalized-publish
        // controls and assert the DAEMON accepts them and mints. A renamed
        // `options` field (or a dropped control) would fail the publish.
        const oName = `${RUN}-opts`;
        const oRoot = `urn:mcpts:${RUN}:opts`;
        await client.createKnowledgeAsset({ contextGraphId: CG, name: oName });
        await client.knowledgeAssetWrite({
          contextGraphId: CG,
          name: oName,
          quads: [{ subject: oRoot, predicate: RDF_TYPE, object: 'urn:mcpts:Thing' }],
        });
        await client.knowledgeAssetFinalize({ contextGraphId: CG, name: oName });
        // vm/publish requires the KA to be shared into SWM first (the real
        // create→write→finalize→share→publish lifecycle) — finalize alone
        // leaves nothing in shared memory for the publish to mint.
        await client.knowledgeAssetShare({ contextGraphId: CG, name: oName });
        const published = await client.knowledgeAssetPublish({
          contextGraphId: CG,
          name: oName,
          clearAfter: true,
          publishEpochs: 2,
          // Use this node's own identity id — a valid override the daemon accepts.
          publisherNodeIdentityIdOverride: '1',
        });
        expect(published).toBeTypeOf('object');
        const hasId = ['kaId', 'ual', 'knowledgeAssetId', 'txHash', 'batchId', 'status'].some((k) => k in published);
        expect(hasId, `publish-with-options had no recognizable key: ${Object.keys(published).join(', ')}`).toBe(true);
      },
      PUBLISH_TIMEOUT_MS,
    );

    // ── Client-side publish guards (real client, throw BEFORE network) ──
    it('knowledgeAssetPublish rejects an out-of-range numeric publisher id before HTTP', async () => {
      await expect(
        client.knowledgeAssetPublish({
          contextGraphId: CG,
          name: 'never',
          publisherNodeIdentityIdOverride: Number.MAX_SAFE_INTEGER + 1,
        } as never),
      ).rejects.toThrow(/decimal string/);
    });

    it('knowledgeAssetPublish rejects malformed decimal-string publisher ids before HTTP', async () => {
      await expect(
        client.knowledgeAssetPublish({ contextGraphId: CG, name: 'never', publisherNodeIdentityIdOverride: 'abc' }),
      ).rejects.toThrow(/decimal string/);
      await expect(
        client.knowledgeAssetPublish({ contextGraphId: CG, name: 'never', publisherNodeIdentityIdOverride: '-1' }),
      ).rejects.toThrow(/decimal string/);
    });

    it('knowledgeAssetPublish rejects unknown finalized-publish option keys before HTTP', async () => {
      await expect(
        client.knowledgeAssetPublish({ contextGraphId: CG, name: 'never', publishEpoch: 3 } as never),
      ).rejects.toThrow(/Unsupported finalized publish option/);
    });

    it('knowledgeAssetFinalize rejects mutually exclusive authorship fields before HTTP', async () => {
      await expect(
        client.knowledgeAssetFinalize({
          contextGraphId: CG,
          name: 'never',
          authorAgentAddress: '0xauthor',
          preSignedAuthorAttestation: { address: '0xauthor', reservedKaId: '1', signature: { r: '0xr', vs: '0xvs' } },
        }),
      ).rejects.toThrow(/mutually exclusive/);
    });

    it('createKnowledgeAsset rejects null alsoPublishVm before HTTP', async () => {
      await expect(
        client.createKnowledgeAsset({ contextGraphId: CG, name: 'never', alsoPublishVm: null } as never),
      ).rejects.toThrow(/alsoPublishVm must be a boolean or publish-options object/);
    });

    it('createKnowledgeAsset rejects finalize-only fields without quads before HTTP', async () => {
      await expect(
        client.createKnowledgeAsset({ contextGraphId: CG, name: 'never', authorAgentAddress: '0xauthor' }),
      ).rejects.toThrow(/require non-empty quads/);
    });
  });

  // ── Agent-to-agent chat (real two-node encrypted round-trip) ───────
  describe('chat tools', () => {
    it('dkg_send_message → dkg_check_inbox round-trips between two live nodes', async () => {
      if (!API2) {
        // Single-node operator: still prove the inbox tool round-trips.
        notError(await server.call('dkg_check_inbox', { directionFilter: 'in' }), 'check_inbox(no-API2)');
        return;
      }
      // Build the second node's surface so it can SEND to node 1.
      const cfg2 = makeConfig({
        api: API2,
        token: TOKEN2,
        defaultProject: CG,
        agentUri: 'urn:dkg:agent:mcp-tool-surface-test-2',
      });
      const { server: server2 } = buildSurface(cfg2);

      const marker = `mcpts-chat-${RUN}`;
      // node2 → node1 (resolve node1 by its peerId — always resolvable).
      const sent = await server2.call('dkg_send_message', { to: peerId, text: marker });
      // delivered OR queued are both non-error outcomes; an ACL/transport
      // hard failure would be isError.
      expect(sent.isError, `send_message errored: ${sent.content?.[0]?.text}`).not.toBe(true);

      // Poll node1's inbox (ad-hoc peer filter → does not advance the
      // on-disk cursor) until the encrypted message arrives.
      let seen = '';
      for (let i = 0; i < 30; i++) {
        const inbox = await server.call('dkg_check_inbox', { directionFilter: 'both', limit: 50 });
        const text = inbox.content?.[0]?.text ?? '';
        if (text.includes(marker)) {
          seen = text;
          break;
        }
        await sleep(1000);
      }
      expect(seen, `node1 inbox never surfaced the message "${marker}" sent from node2`).toContain(marker);
    }, 60_000);
  });

  // ── Cleanup ───────────────────────────────────────────────────────
  it('cleans up temp files', async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });
});
