/**
 * Live MCP agent-tool-surface ↔ daemon contract (opt-in, real node).
 *
 * What this proves that the mocked tests can't
 * --------------------------------------------
 * Every other test in this package drives the tools against `FakeClient`
 * / a fake fetcher (see `harness.ts`, `knowledge-assets-client.test.ts`).
 * Those pin the *outgoing request shape* but return `{ ok: true }` for
 * anything, so they are blind to the failure mode a teammate hit in
 * rc.17 — "the agent tool surface wasn't updated all the way with the new
 * API and KA logic." When the daemon renamed an endpoint, changed a body
 * field, tightened a `view` enum, or reshaped a response, the mocks kept
 * passing while the real round-trip was broken.
 *
 * This test wires the REAL `DkgClient` + the REAL `registerTools()`
 * surface (the exact registration sequence from `src/index.ts`) against a
 * RUNNING daemon and walks the whole Knowledge-Asset lifecycle plus the
 * read/query surface, asserting genuine end-to-end success. A renamed
 * endpoint (404 → `DkgHttpError`), a renamed/removed body field (daemon
 * 400), a dropped `view` value, or an empty/garbage response all fail
 * here — exactly the drift the static `client-daemon-endpoint-contract`
 * test can't see at the field/semantic level.
 *
 * Why it's opt-in
 * ---------------
 * It needs a real DKG daemon (and, for the VM-publish leg, a funded node
 * on a chain — e.g. a `devnet.sh` node). That's too heavy for the per-PR
 * unit lane, so it's gated behind `MCP_INTEGRATION_TEST=1` and SKIPS
 * otherwise (mirroring `cli/test/blazegraph-integration.test.ts`). Run it:
 *
 *   MCP_INTEGRATION_TEST=1 \
 *   DKG_API=http://127.0.0.1:9201 \
 *   DKG_TOKEN=<node-token> \
 *   DKG_PROJECT=<an on-chain-registered context graph, e.g. devnet-test> \
 *     npx vitest run test/mcp-daemon-contract.integration.test.ts
 *
 * (or `pnpm --filter @origintrail-official/dkg-mcp test:integration` with
 * the same env). `DKG_PROJECT` MUST be a context graph that is registered
 * on chain so the VM-publish leg can mint; an unregistered CG will make
 * the publish step fail for environmental reasons, not drift.
 */
import { describe, it, expect, beforeAll } from 'vitest';
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

const ENABLED = process.env.MCP_INTEGRATION_TEST === '1';

const API = process.env.DKG_API ?? 'http://127.0.0.1:9201';
const TOKEN = process.env.DKG_TOKEN ?? '';
const CG = process.env.DKG_PROJECT ?? process.env.DKG_CG ?? 'devnet-test';

// Unique-per-run so a re-run never collides on KA name / root entity.
const RUN = `mcpci-${Date.now().toString(36)}`;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PUBLISH_TIMEOUT_MS = 180_000;

/** Build the full agent tool surface exactly as src/index.ts does. */
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

describe.skipIf(!ENABLED)('MCP ↔ daemon live contract', () => {
  let client: DkgClient;
  let server: FakeServer;
  let peerId: string;

  // Shared lifecycle state across the ordered KA steps below.
  const kaName = `${RUN}-ka`;
  const kaRoot = `urn:mcpci:${RUN}:s1`;

  beforeAll(async () => {
    if (!TOKEN) {
      throw new Error(
        'MCP_INTEGRATION_TEST=1 but DKG_TOKEN is empty. Export the daemon API token ' +
          '(e.g. from ~/.dkg/auth.token or your devnet node) or unset MCP_INTEGRATION_TEST to skip.',
      );
    }
    const config = makeConfig({
      api: API,
      token: TOKEN,
      defaultProject: CG,
      agentUri: 'urn:dkg:agent:mcp-integration-test',
    });
    ({ server, client } = buildSurface(config));

    // Fail fast with a clear message if the node isn't reachable, rather
    // than letting every case throw an opaque fetch error.
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
    // WM-view reads are scoped to the raw peer ID (see DkgClient.query
    // JSDoc), so we capture it once for the working-memory query leg.
    peerId = String(identity.peerId ?? '');
    expect(peerId, 'daemon /api/agent/identity returned no peerId').toBeTruthy();

    // Ensure the target CG exists locally and is registered on chain so the
    // VM-publish legs can mint. Both calls are idempotent (alreadyExists /
    // alreadyRegistered), so pointing DKG_PROJECT at a pre-provisioned CG
    // is a no-op. This keeps the test runnable with just a node + token.
    await client.createContextGraph({ id: CG, name: CG });
    await client.registerContextGraph({ id: CG });
  }, 120_000);

  it('GET /api/agent/identity returns the documented identity shape', async () => {
    const id = await client.getAgentIdentity();
    expect(id).toBeTypeOf('object');
    // agentAddress (DID-form) is the field WM provenance + the tools rely
    // on; peerId is the WM-routing key. At least one must be present.
    expect(Boolean(id.agentAddress || id.agentDid || id.peerId)).toBe(true);
  });

  it('GET /api/status returns a node status object', async () => {
    const status = await client.getStatus();
    expect(status).toBeTypeOf('object');
    expect(status).not.toBeNull();
  });

  it('dkg_list_context_graphs tool round-trips against the daemon', async () => {
    const res = await server.call('dkg_list_context_graphs', { scope: 'all' });
    expect(res.isError, `tool errored: ${res.content?.[0]?.text}`).not.toBe(true);
    expect(res.content[0].text).toBeTruthy();
  });

  it('GET /api/sub-graph/list returns an array', async () => {
    const rows = await client.listSubGraphs(CG);
    expect(Array.isArray(rows)).toBe(true);
  });

  // ── Knowledge-Asset lifecycle: write → finalize → share → publish ──
  // This is the surface the teammate flagged as drifting. Each verb hits
  // a distinct /api/knowledge-assets/:name/<layer>/<verb> route; a rename
  // or KA-logic change on any of them fails the corresponding step.

  it('create opens a WM draft (POST /api/knowledge-assets)', async () => {
    const created = await client.createKnowledgeAsset({ contextGraphId: CG, name: kaName });
    expect(created).toBeTypeOf('object');
  });

  it('wm/write appends quads and reports the written count', async () => {
    const quads = [
      { subject: kaRoot, predicate: 'urn:mcpci:p', object: '"v1"' },
      { subject: kaRoot, predicate: RDF_TYPE, object: 'urn:mcpci:Thing' },
    ];
    const res = await client.knowledgeAssetWrite({ contextGraphId: CG, name: kaName, quads });
    expect(res.written).toBe(quads.length);
  });

  it('GET /api/knowledge-assets/:name surfaces lifecycle state', async () => {
    const state = await client.getKnowledgeAsset({ contextGraphId: CG, name: kaName });
    expect(state).toBeTypeOf('object');
    // Lifecycle descriptors carry a status and/or the WM pointer; assert
    // the response is non-empty so a reshaped/empty body is caught.
    expect(Object.keys(state).length).toBeGreaterThan(0);
  });

  it('wm/quads dumps the draft we just wrote', async () => {
    const dump = await client.queryAssertion({ contextGraphId: CG, assertionName: kaName });
    expect(dump.count).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(dump.quads)).toBe(true);
  });

  it('wm/finalize seals the draft and returns a merkle root', async () => {
    const sealed = await client.knowledgeAssetFinalize({ contextGraphId: CG, name: kaName });
    expect(sealed.merkleRoot, 'finalize returned no merkleRoot').toMatch(/^0x[0-9a-fA-F]+$/);
  });

  it('swm/share advances the SWM pointer', async () => {
    // Omit `entities` → daemon promotes every root in the sealed draft
    // (our single `kaRoot`), so promotedCount is deterministically ≥ 1.
    const shared = await client.knowledgeAssetShare({ contextGraphId: CG, name: kaName });
    expect(shared.swmShared).toBe(true);
    expect(shared.promotedCount).toBeGreaterThan(0);
  });

  it(
    'vm/publish mints on chain and returns an on-chain identifier',
    async () => {
      const published = await client.knowledgeAssetPublish({ contextGraphId: CG, name: kaName });
      expect(published).toBeTypeOf('object');
      // Tolerate exact shape variance but require a recognizable on-chain
      // result key — an empty/garbage body would be semantic drift.
      const keys = Object.keys(published);
      const hasIdentifier = ['kaId', 'ual', 'knowledgeAssetId', 'txHash', 'batchId', 'status'].some(
        (k) => k in published,
      );
      expect(hasIdentifier, `publish response had no recognizable key: ${keys.join(', ')}`).toBe(true);
    },
    PUBLISH_TIMEOUT_MS,
  );

  // ── Query surface across all three memory tiers ────────────────────
  // Catches `view` enum drift and /api/query body-field drift: a removed
  // view value or renamed field makes the daemon 400 and the call throw.

  it('POST /api/query (working-memory) returns bindings', async () => {
    const r = await client.query({
      sparql: `SELECT ?p ?o WHERE { <${kaRoot}> ?p ?o }`,
      contextGraphId: CG,
      view: 'working-memory',
      agentAddress: peerId,
    });
    expect(Array.isArray(r.bindings)).toBe(true);
  });

  it('POST /api/query (shared-working-memory) is accepted', async () => {
    const r = await client.query({
      sparql: `SELECT ?p ?o WHERE { <${kaRoot}> ?p ?o }`,
      contextGraphId: CG,
      view: 'shared-working-memory',
    });
    expect(Array.isArray(r.bindings)).toBe(true);
  });

  it('POST /api/query (verifiable-memory) is accepted', async () => {
    const r = await client.query({
      sparql: `SELECT ?p ?o WHERE { <${kaRoot}> ?p ?o }`,
      contextGraphId: CG,
      view: 'verifiable-memory',
    });
    expect(Array.isArray(r.bindings)).toBe(true);
  });

  it('dkg_query tool round-trips against the daemon', async () => {
    const res = await server.call('dkg_query', {
      sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1',
      view: 'shared-working-memory',
    });
    expect(res.isError, `tool errored: ${res.content?.[0]?.text}`).not.toBe(true);
  });

  // ── Atomic create+share+publish (the one-shot KA path) ─────────────
  it(
    'atomic createKnowledgeAsset(quads, alsoShareSwm, alsoPublishVm) mints on chain',
    async () => {
      const atomicName = `${RUN}-atomic`;
      const atomicRoot = `urn:mcpci:${RUN}:atomic`;
      const res = await client.createKnowledgeAsset({
        contextGraphId: CG,
        name: atomicName,
        quads: [
          {
            subject: atomicRoot,
            predicate: 'urn:mcpci:p',
            object: '"atomic"',
            graph: `did:dkg:context-graph:${CG}`,
          },
          {
            subject: atomicRoot,
            predicate: RDF_TYPE,
            object: 'urn:mcpci:Thing',
            graph: `did:dkg:context-graph:${CG}`,
          },
        ],
        alsoShareSwm: true,
        alsoPublishVm: true,
      });
      expect(res).toBeTypeOf('object');
      const hasIdentifier = ['kaId', 'ual', 'knowledgeAssetId', 'txHash', 'status'].some(
        (k) => k in res,
      );
      expect(hasIdentifier, `atomic publish had no recognizable key: ${Object.keys(res).join(', ')}`).toBe(
        true,
      );
    },
    PUBLISH_TIMEOUT_MS,
  );
});
