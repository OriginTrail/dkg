import { describe, it, expect, beforeEach } from 'vitest';
import { registerSetupTools } from '../src/tools/setup.js';
import { registerPublishTools } from '../src/tools/publish.js';
import { registerHealthTools } from '../src/tools/health.js';
import { FakeServer } from './harness.js';
import { LIVE, API, TOKEN, CG, liveClient, liveConfig } from './live.js';

// ── NO MOCKS ─────────────────────────────────────────────────────────
// The retired version drove an in-memory FakeClient (contextGraphs set,
// publishCalls spy, subscribe spy, canned walletBalances) plus a couple
// of fake-fetcher cases. Replaced with three honest lanes:
//   • PURE — schema defaults, descriptions, registration, and the
//     CLIENT-SIDE validation guards (invalid slug, empty quads/roots,
//     accessPolicy enum). These short-circuit BEFORE any network call, so
//     they run against a real (uninvoked) DkgClient with no node.
//   • DEAD-PORT — real error handling proven with a genuine ECONNREFUSED
//     client (no mock): register-failure propagation, wallet probe failure.
//   • LIVE (gated) — the real daemon round-trips: create/subscribe/
//     sub-graph, on-chain publish with chain echo + auto-typing, and the
//     registerIfNeeded already-registered tolerance.

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PUBLISH_TIMEOUT_MS = 180_000;
const DEAD = 'http://127.0.0.1:1';

// ── PURE: setup tool surface ─────────────────────────────────────────
describe('setup tools — pure surface + client-side guards (no node)', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    registerSetupTools(server.asMcpServer(), liveClient(), liveConfig());
  });

  it('registers all three setup tools', () => {
    for (const name of ['dkg_context_graph_create', 'dkg_subscribe', 'dkg_sub_graph_create']) {
      expect(server.tools.has(name)).toBe(true);
    }
  });

  it('dkg_context_graph_create description carries the SKILL.md §6 canonical-naming note + Idempotent contract', () => {
    const desc = server.get('dkg_context_graph_create').config.description!;
    expect(desc).toContain("called 'projects' in the DKG node UI");
    expect(desc).not.toMatch(/Call `dkg_list_context_graphs` first/);
    expect(desc).toMatch(/Idempotent/);
  });

  it('rejects an invalid slug client-side, before any daemon call', async () => {
    // VALID_CG_ID_RE fails → errResult returned BEFORE client.createContextGraph.
    // Proven by using a real client pointed at a DEAD port: if the guard
    // regressed and fell through to the network, we'd get a connection
    // error, not the documented validation message.
    const s = new FakeServer();
    registerSetupTools(s.asMcpServer(), liveClient({ api: DEAD }), liveConfig({ api: DEAD }));
    const result = await s.call('dkg_context_graph_create', { name: 'X', id: 'BAD_SLUG_With_Spaces' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid context graph ID/);
  });

  it('dkg_subscribe schema defaults includeSharedMemory to true and accepts false', () => {
    expect(server.parse('dkg_subscribe', { contextGraphId: 'x' }).includeSharedMemory).toBe(true);
    expect(server.parse('dkg_subscribe', { contextGraphId: 'x', includeSharedMemory: false }).includeSharedMemory).toBe(false);
  });

  it('documents canonical context graph ids for existing-target setup tools', () => {
    for (const name of ['dkg_subscribe', 'dkg_sub_graph_create']) {
      const contextGraphId = server.get(name).config.inputSchema?.contextGraphId;
      expect(contextGraphId?.description).toContain('dkg_list_context_graphs');
      expect(contextGraphId?.description).toContain('local-notes');
      expect(contextGraphId?.description).toContain('<curatorAddress>/<slug>');
      expect(contextGraphId?.description).toContain('Do not guess');
    }
  });
});

// ── PURE: publish tool surface + validation ──────────────────────────
describe('publish tools — pure surface + client-side guards (no node)', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    registerPublishTools(server.asMcpServer(), liveClient(), liveConfig());
  });

  it('registers both publish tools', () => {
    expect(server.tools.has('dkg_publish')).toBe(true);
    expect(server.tools.has('dkg_shared_memory_publish')).toBe(true);
  });

  it('documents canonical context graph ids for publish tools', () => {
    for (const name of ['dkg_publish', 'dkg_shared_memory_publish']) {
      const contextGraphId = server.get(name).config.inputSchema?.contextGraphId;
      expect(contextGraphId?.description).toContain('dkg_list_context_graphs');
      expect(contextGraphId?.description).toContain('local-notes');
      expect(contextGraphId?.description).toContain('<curatorAddress>/<slug>');
      expect(contextGraphId?.description).toContain('Do not guess');
    }
  });

  it('dkg_publish rejects an empty quads array at the schema layer (parse)', () => {
    expect(() => server.parse('dkg_publish', { contextGraphId: 'cg', quads: [] })).toThrow();
  });

  it('dkg_shared_memory_publish rejects an empty rootEntities array client-side (before any daemon call)', async () => {
    const s = new FakeServer();
    registerPublishTools(s.asMcpServer(), liveClient({ api: DEAD }), liveConfig({ api: DEAD }));
    const result = await s.call('dkg_shared_memory_publish', { contextGraphId: 'cg', rootEntities: [] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/non-empty array/);
  });

  // F11: accessPolicy wire form is the numeric 0|1 union — accepted by
  // parse; the legacy string `"open"` and out-of-range `2` are rejected.
  it('F11: accepts numeric accessPolicy 0 and 1 (parse)', () => {
    expect(server.parse('dkg_shared_memory_publish', { contextGraphId: 'cg', registerIfNeeded: true, accessPolicy: 0 }).accessPolicy).toBe(0);
    expect(server.parse('dkg_shared_memory_publish', { contextGraphId: 'cg', registerIfNeeded: true, accessPolicy: 1 }).accessPolicy).toBe(1);
  });

  it('F11: rejects the legacy string "open" and out-of-range numeric accessPolicy (parse)', () => {
    expect(() => server.parse('dkg_shared_memory_publish', { contextGraphId: 'cg', registerIfNeeded: true, accessPolicy: 'open' })).toThrow();
    expect(() => server.parse('dkg_shared_memory_publish', { contextGraphId: 'cg', registerIfNeeded: true, accessPolicy: 2 })).toThrow();
  });

  // F12: a register failure must propagate as a tool error (no silent
  // swallow). Proven with a REAL dead-port client → genuine connection
  // error surfaced as "Failed to register context graph: …".
  it('F12: registerIfNeeded propagates a real register failure (no silent swallow)', async () => {
    const s = new FakeServer();
    registerPublishTools(s.asMcpServer(), liveClient({ api: DEAD }), liveConfig({ api: DEAD }));
    const result = await s.call('dkg_shared_memory_publish', { contextGraphId: 'cg', registerIfNeeded: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Failed to register context graph:/);
  });
});

// ── PURE: health tool surface ────────────────────────────────────────
describe('health tools — pure surface + real failure handling (no node)', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    registerHealthTools(server.asMcpServer(), liveClient(), liveConfig());
  });

  it('registers the no-arg health tools with empty inputSchemas', () => {
    expect(server.tools.has('dkg_status')).toBe(true);
    expect(server.tools.has('dkg_wallet_balances')).toBe(true);
    expect(server.get('dkg_status').config.inputSchema).toEqual({});
    expect(server.get('dkg_wallet_balances').config.inputSchema).toEqual({});
    expect(server.tools.has('dkg_peer_info')).toBe(true);
  });

  it('dkg_wallet_balances surfaces a real probe failure as a tool error', async () => {
    const s = new FakeServer();
    registerHealthTools(s.asMcpServer(), liveClient({ api: DEAD }), liveConfig({ api: DEAD }));
    const result = await s.call('dkg_wallet_balances', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Failed to fetch wallet balances/);
  });
});

// ── LIVE: real daemon round-trips ────────────────────────────────────
describe.skipIf(!LIVE)('setup tools — live round-trips', () => {
  const RUN = `sp${Date.now().toString(36)}`;
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    registerSetupTools(server.asMcpServer(), liveClient(), liveConfig());
  });

  it('auto-derives the slug from the human name and reports Created, then idempotent already-exists', async () => {
    const name = `Run ${RUN} Setup CG`;
    const slug = `run-${RUN}-setup-cg`;
    const first = await server.call('dkg_context_graph_create', { name });
    expect(first.isError).toBeFalsy();
    expect(first.content[0].text).toMatch(new RegExp(`^Created context graph '${slug}'`));

    const second = await server.call('dkg_context_graph_create', { name });
    expect(second.isError).toBeFalsy();
    expect(second.content[0].text).toMatch(new RegExp(`^Context graph '${slug}' already exists`));
  });

  it('dkg_sub_graph_create is wrapper-idempotent against the daemon 409', async () => {
    const r1 = await server.call('dkg_sub_graph_create', { contextGraphId: CG, subGraphName: 'meta' });
    expect(r1.isError).toBeFalsy();
    expect(r1.content[0].text).toMatch(/'meta' ready in/);
    const r2 = await server.call('dkg_sub_graph_create', { contextGraphId: CG, subGraphName: 'meta' });
    expect(r2.isError).toBeFalsy();
  });

  it('dkg_subscribe round-trips (default + includeSharedMemory:false)', async () => {
    const def = await server.call('dkg_subscribe', { contextGraphId: CG });
    expect(def.isError).toBeFalsy();
    expect(def.content[0].text).toMatch(new RegExp(`Subscribed to '${CG}'`));

    const noSwm = await server.call('dkg_subscribe', { contextGraphId: CG, includeSharedMemory: false });
    expect(noSwm.isError).toBeFalsy();
  });
});

describe.skipIf(!LIVE)('publish tools — live on-chain round-trips', () => {
  const RUN = `pp${Date.now().toString(36)}`;
  const did = `did:dkg:context-graph:${CG}`;
  let server: FakeServer;
  let client: ReturnType<typeof liveClient>;

  beforeEach(() => {
    server = new FakeServer();
    client = liveClient();
    registerPublishTools(server.asMcpServer(), client, liveConfig());
  });

  it(
    'dkg_publish writes+mints fresh quads, echoes the chain, omits warning prose, and auto-types objects',
    async () => {
      const subj = `urn:pp:${RUN}:e`;
      const literal = `pp ${RUN} literal value payload`;
      const result = await server.call('dkg_publish', {
        contextGraphId: CG,
        quads: [
          { subject: subj, predicate: RDF_TYPE, object: 'urn:pp:Note' },
          { subject: subj, predicate: 'urn:pp:p:label', object: literal },
        ],
      });
      expect(result.isError, result.content[0].text).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toMatch(/Published 2 quad\(s\)/);
      // F3+F13: chain echo present (read from the real wallet-balances probe).
      expect(text).toMatch(/Chain: .+/);
      // User-locked: echo-only, no warning prose.
      expect(text).not.toMatch(/warning/i);
      expect(text).not.toMatch(/spends gas/i);
      expect(text).not.toMatch(/verify.*chain/i);

      // Auto-typing proven END-TO-END: read the minted entity back from VM
      // and confirm the URI object stayed a URI and the bare string became
      // a quoted literal.
      const back = await client.query({
        sparql: `SELECT ?p ?o WHERE { <${subj}> ?p ?o }`,
        contextGraphId: CG,
        view: 'verifiable-memory',
      });
      const rows = back.bindings ?? [];
      const typeRow = rows.find((b) => String((b.p as { value?: string })?.value ?? b.p).includes('22-rdf-syntax-ns#type'));
      const labelRow = rows.find((b) => String((b.p as { value?: string })?.value ?? b.p).includes('urn:pp:p:label'));
      expect(typeRow, 'type triple missing from VM').toBeTruthy();
      expect(labelRow, 'label triple missing from VM').toBeTruthy();
      // The literal round-trips as a plain string value (not a <urn:…>).
      expect(String((labelRow!.o as { value?: string })?.value ?? labelRow!.o)).toContain(literal);
    },
    PUBLISH_TIMEOUT_MS,
  );

  it(
    'dkg_shared_memory_publish mints a selection-scoped subset and reports Roots: 1 + chain',
    async () => {
      const subj = `urn:pp:${RUN}:smp`;
      const seed = await fetch(`${API}/api/shared-memory/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          contextGraphId: CG,
          quads: [
            { subject: subj, predicate: RDF_TYPE, object: 'urn:pp:Note', graph: did },
            { subject: subj, predicate: 'urn:pp:p:label', object: '"subset publish seed"', graph: did },
          ],
        }),
      });
      expect(seed.ok, `seed failed: ${seed.status}`).toBe(true);

      const result = await server.call('dkg_shared_memory_publish', { contextGraphId: CG, rootEntities: [subj] });
      expect(result.isError, result.content[0].text).toBeFalsy();
      expect(result.content[0].text).toMatch(/Published .*SWM to Verifiable Memory/);
      expect(result.content[0].text).toMatch(/Roots: 1/);
      expect(result.content[0].text).toMatch(/Chain: .+/);
    },
    PUBLISH_TIMEOUT_MS,
  );

  it(
    'registerIfNeeded tolerates an already-registered CG (no "Registered on-chain" claim)',
    async () => {
      // devnet-test is already on-chain → registerContextGraph returns
      // alreadyRegistered:true → the tool must NOT claim a fresh
      // registration, but the publish still succeeds.
      const subj = `urn:pp:${RUN}:reg`;
      const seed = await fetch(`${API}/api/shared-memory/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          contextGraphId: CG,
          quads: [
            { subject: subj, predicate: RDF_TYPE, object: 'urn:pp:Note', graph: did },
            { subject: subj, predicate: 'urn:pp:p:label', object: '"already-registered tolerance seed"', graph: did },
          ],
        }),
      });
      expect(seed.ok, `seed failed: ${seed.status}`).toBe(true);

      const result = await server.call('dkg_shared_memory_publish', {
        contextGraphId: CG,
        rootEntities: [subj],
        registerIfNeeded: true,
        accessPolicy: 1,
      });
      expect(result.isError, result.content[0].text).toBeFalsy();
      expect(result.content[0].text).toMatch(/Roots: 1/);
      // Already registered → no fresh-registration echo.
      expect(result.content[0].text).not.toMatch(/Registered on-chain/);
    },
    PUBLISH_TIMEOUT_MS,
  );
});

describe.skipIf(!LIVE)('health tools — live status + wallet', () => {
  let server: FakeServer;

  beforeEach(() => {
    server = new FakeServer();
    registerHealthTools(server.asMcpServer(), liveClient(), liveConfig());
  });

  it('dkg_status renders the real daemon status payload', async () => {
    const result = await server.call('dkg_status', {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/DKG node status/);
    expect(result.content[0].text).toMatch(/"peerId"/);
  });

  it('dkg_wallet_balances renders the real wallet probe', async () => {
    const result = await server.call('dkg_wallet_balances', {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Wallet balances/);
    expect(result.content[0].text).toMatch(/TRAC|ETH|no operational wallets/);
  });
});
