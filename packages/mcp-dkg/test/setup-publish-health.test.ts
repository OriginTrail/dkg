import { describe, it, expect, beforeEach } from 'vitest';
import { registerSetupTools } from '../src/tools/setup.js';
import { registerHealthTools } from '../src/tools/health.js';
import { DkgClient } from '../src/client.js';
import { FakeServer, FakeClient, makeConfig } from './harness.js';

describe('setup tools — context graph + sub-graph + subscribe', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    registerSetupTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
  });

  it('registers all three setup tools', () => {
    for (const name of [
      'dkg_context_graph_create',
      'dkg_subscribe',
      'dkg_sub_graph_create',
    ]) {
      expect(server.tools.has(name)).toBe(true);
    }
  });

  it('dkg_context_graph_create description carries the SKILL.md §6 canonical-naming note', () => {
    const desc = server.get('dkg_context_graph_create').config.description!;
    expect(desc).toContain("called 'projects' in the DKG node UI");
  });

  it('auto-derives the slug from the human name when id is omitted', async () => {
    const result = await server.call('dkg_context_graph_create', {
      name: 'My Research Context Graph',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/'my-research-context-graph'/);
    expect(client.contextGraphs.has('my-research-context-graph')).toBe(true);
  });

  it('honours an explicit slug when provided', async () => {
    const result = await server.call('dkg_context_graph_create', {
      name: 'Anything',
      id: 'override-slug',
    });
    expect(result.isError).toBeFalsy();
    expect(client.contextGraphs.has('override-slug')).toBe(true);
  });

  it('rejects invalid slugs without hitting the daemon', async () => {
    const result = await server.call('dkg_context_graph_create', {
      name: 'X',
      id: 'BAD_SLUG_With_Spaces',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid context graph ID/);
    expect(client.contextGraphs.size).toBe(0);
  });

  // F2: surface the daemon's already-exists signal so callers can
  // distinguish "newly created" from "already existed" without doing
  // an extra dkg_list_context_graphs round-trip. Mirrors
  // dkg_knowledge_asset_create's idempotency surfacing.
  it('first create reports "Created"; second create with same id reports "already exists"', async () => {
    const r1 = await server.call('dkg_context_graph_create', { name: 'My Project' });
    expect(r1.isError).toBeFalsy();
    expect(r1.content[0].text).toMatch(/^Created context graph 'my-project'/);

    // Re-create with the same auto-derived id — daemon-side 409 is
    // caught by `client.createContextGraph`, surfaced as
    // `alreadyExists: true` to the tool, which renders the
    // distinct "already exists" message.
    const r2 = await server.call('dkg_context_graph_create', { name: 'My Project' });
    expect(r2.isError).toBeFalsy();
    expect(r2.content[0].text).toMatch(/^Context graph 'my-project' already exists/);
    expect(r2.content[0].text).not.toMatch(/^Created/);
  });

  it('description no longer recommends the dkg_list_context_graphs workaround', () => {
    // The pre-F2 description told callers to "Call dkg_list_context_graphs
    // first to see if one with this name already exists." That workaround
    // was forced because the create call dropped the idempotency signal.
    // Post-F2 the create surfaces the signal directly, so the workaround
    // text must be gone.
    const desc = server.get('dkg_context_graph_create').config.description!;
    expect(desc).not.toMatch(/Call `dkg_list_context_graphs` first/);
    // ...replaced with an explicit idempotency contract.
    expect(desc).toMatch(/Idempotent/);
  });

  it('dkg_sub_graph_create is wrapper-idempotent: ensureSubGraph swallows the daemon-side 409', async () => {
    const r1 = await server.call('dkg_sub_graph_create', {
      contextGraphId: 'cg',
      subGraphName: 'meta',
    });
    expect(r1.isError).toBeFalsy();
    expect(r1.content[0].text).toMatch(/'meta' ready in 'cg'/);
    // Re-create the same name — the wrapper-level idempotency lock means
    // the agent-facing surface stays clean even if the daemon would 409.
    const r2 = await server.call('dkg_sub_graph_create', {
      contextGraphId: 'cg',
      subGraphName: 'meta',
    });
    expect(r2.isError).toBeFalsy();
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

  it('dkg_subscribe defaults includeSharedMemory to true', async () => {
    const result = await server.call('dkg_subscribe', { contextGraphId: 'remote-cg' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Subscribed to 'remote-cg'/);
    expect(client.subscribed.has('remote-cg')).toBe(true);
  });

  it('dkg_subscribe forwards includeSharedMemory: false', async () => {
    let received: boolean | undefined;
    const localClient = new FakeClient({
      subscribe: async (args) => {
        received = args.includeSharedMemory;
        return { subscribed: args.contextGraphId };
      },
    });
    const localServer = new FakeServer();
    registerSetupTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());
    await localServer.call('dkg_subscribe', {
      contextGraphId: 'remote',
      includeSharedMemory: false,
    });
    expect(received).toBe(false);
  });
});

describe('health tools — status + wallet balances', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    registerHealthTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
  });

  it('registers the no-arg health tools with empty inputSchemas', () => {
    expect(server.tools.has('dkg_status')).toBe(true);
    expect(server.tools.has('dkg_wallet_balances')).toBe(true);
    expect(server.get('dkg_status').config.inputSchema).toEqual({});
    expect(server.get('dkg_wallet_balances').config.inputSchema).toEqual({});
    // `dkg_peer_info` is also registered by this module but takes a
    // required `peerId` arg, so it's covered by its own test file
    // (`health-tools.test.ts`) where the schema + handler assertions
    // live alongside the peer-info diagnostic fixtures.
    expect(server.tools.has('dkg_peer_info')).toBe(true);
  });

  it('dkg_status renders the daemon status payload as a JSON code block', async () => {
    const result = await server.call('dkg_status', {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/DKG node status/);
    expect(result.content[0].text).toMatch(/"peerId": "peer-test"/);
  });

  it('dkg_wallet_balances renders per-wallet rows + chain context', async () => {
    const result = await server.call('dkg_wallet_balances', {});
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/0xabc/);
    expect(result.content[0].text).toMatch(/0\.05 ETH/);
    expect(result.content[0].text).toMatch(/12\.5 TRAC/);
    expect(result.content[0].text).toMatch(/Chain: base-sepolia/);
  });

  it('dkg_wallet_balances surfaces a tool error when the daemon reports a probe error', async () => {
    const localClient = new FakeClient();
    localClient.walletBalances = {
      wallets: [],
      balances: [],
      chainId: null,
      rpcUrl: null,
      error: 'rpc unreachable',
    };
    const localServer = new FakeServer();
    registerHealthTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());
    const result = await localServer.call('dkg_wallet_balances', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/rpc unreachable/);
  });
});
