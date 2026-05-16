import { describe, it, expect, beforeEach } from 'vitest';
import { registerSetupTools } from '../src/tools/setup.js';
import { registerPublishTools } from '../src/tools/publish.js';
import { registerHealthTools } from '../src/tools/health.js';
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
  // dkg_assertion_create's idempotency surfacing.
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

describe('publish tools — write+publish helper + canonical SWM finalizer', () => {
  let server: FakeServer;
  let client: FakeClient;

  beforeEach(() => {
    server = new FakeServer();
    client = new FakeClient();
    registerPublishTools(server.asMcpServer(), client.asDkgClient(), makeConfig());
  });

  it('registers both publish tools', () => {
    expect(server.tools.has('dkg_publish')).toBe(true);
    expect(server.tools.has('dkg_shared_memory_publish')).toBe(true);
  });

  it('dkg_publish auto-types objects: URI passes through, literal gets quoted', async () => {
    const result = await server.call('dkg_publish', {
      contextGraphId: 'cg',
      quads: [
        { subject: 'urn:s:1', predicate: 'urn:p:type', object: 'urn:Note' },
        { subject: 'urn:s:1', predicate: 'urn:p:label', object: 'a literal value' },
      ],
    });
    expect(result.isError).toBeFalsy();
    const call = client.publishCalls.at(-1)!;
    const wireQuads = call.quads as Array<{ subject: string; predicate: string; object: string }>;
    expect(wireQuads[0].object).toBe('urn:Note');
    expect(wireQuads[1].object).toBe('"a literal value"');
  });

  it('dkg_publish rejects an empty quads array at the schema layer', async () => {
    await expect(
      server.call('dkg_publish', { contextGraphId: 'cg', quads: [] }),
    ).rejects.toThrow();
  });

  it('dkg_shared_memory_publish without rootEntities publishes selection: all', async () => {
    const result = await server.call('dkg_shared_memory_publish', { contextGraphId: 'cg' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Selection: all/);
  });

  it('dkg_shared_memory_publish rejects an empty rootEntities array (omit or non-empty only)', async () => {
    const result = await server.call('dkg_shared_memory_publish', {
      contextGraphId: 'cg',
      rootEntities: [],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/non-empty array/);
  });

  it('dkg_shared_memory_publish forwards a non-empty rootEntities subset', async () => {
    const result = await server.call('dkg_shared_memory_publish', {
      contextGraphId: 'cg',
      rootEntities: ['urn:r:1', 'urn:r:2'],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Roots: 2/);
    const call = client.publishCalls.find((c) => c.kind === 'publishSharedMemory')!;
    expect(call.rootEntities).toEqual(['urn:r:1', 'urn:r:2']);
  });

  it('dkg_shared_memory_publish runs registerContextGraph first when registerIfNeeded: true', async () => {
    const localClient = new FakeClient();
    let registered = false;
    localClient.registerContextGraph = (async () => {
      registered = true;
      return {
        registered: 'cg',
        onChainId: 'chain:cg',
        txHash: '0xreg',
        alreadyRegistered: false,
      };
    }) as never;
    const localServer = new FakeServer();
    registerPublishTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    const result = await localServer.call('dkg_shared_memory_publish', {
      contextGraphId: 'cg',
      registerIfNeeded: true,
    });
    expect(result.isError).toBeFalsy();
    expect(registered).toBe(true);
    expect(result.content[0].text).toMatch(/Registered on-chain/);
  });

  // F12 (qa-review-round-2): the registerIfNeeded already-registered
  // tolerance was implemented as a `message.includes('already registered')`
  // substring match — locale-fragile + breaks on any daemon wording
  // change. Post-F12 the client surfaces a typed `alreadyRegistered:
  // true` flag from the daemon's HTTP 409, and the tool branches on
  // the typed flag.
  it('F12: registerIfNeeded tolerates already-registered via the typed flag (no substring match)', async () => {
    const localClient = new FakeClient({
      registerContextGraph: async () => ({
        registered: 'cg',
        alreadyRegistered: true,
      }) as any,
    });
    const localServer = new FakeServer();
    registerPublishTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    const result = await localServer.call('dkg_shared_memory_publish', {
      contextGraphId: 'cg',
      registerIfNeeded: true,
    });
    // The publish must succeed even though the CG was already registered.
    expect(result.isError).toBeFalsy();
    // Success summary MUST NOT claim we just registered something.
    expect(result.content[0].text).not.toMatch(/Registered on-chain/);
  });

  it('F12: registerIfNeeded propagates non-409 register failures (no silent swallow)', async () => {
    // A truly-failing register call (network error, unrelated body
    // shape) MUST propagate as a tool error; the pre-F12 substring
    // match would have swallowed any error whose message happened to
    // contain "already registered" verbatim.
    const localClient = new FakeClient({
      registerContextGraph: async () => {
        throw new Error('rpc unreachable');
      },
    });
    const localServer = new FakeServer();
    registerPublishTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    const result = await localServer.call('dkg_shared_memory_publish', {
      contextGraphId: 'cg',
      registerIfNeeded: true,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Failed to register context graph: rpc unreachable/);
  });

  // F3+F13 (qa-review-round-1 F3 + qa-review-round-2 F13): chain
  // provenance echoed on publish responses so callers can verify
  // post-hoc which chain the publish landed on. User explicit:
  // option (a) WITHOUT loud-warning prose. accessPolicy is also
  // echoed when registerIfNeeded ran so the caller can verify what
  // the daemon committed without a separate read-back.
  it('F3+F13: dkg_publish success summary echoes the configured chainId', async () => {
    // FakeClient.walletBalances ships chainId='base-sepolia' by default.
    const result = await server.call('dkg_publish', {
      contextGraphId: 'cg',
      quads: [{ subject: 'urn:s:1', predicate: 'urn:p:type', object: 'urn:Note' }],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Chain: base-sepolia/);
  });

  it('F3+F13: dkg_shared_memory_publish success summary echoes the configured chainId', async () => {
    const result = await server.call('dkg_shared_memory_publish', { contextGraphId: 'cg' });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Chain: base-sepolia/);
  });

  it('F3+F13: chainId is omitted gracefully when the wallet-balances probe fails', async () => {
    // The probe failure must NOT fail the publish — the publish
    // succeeded, the chain echo is best-effort.
    const localClient = new FakeClient({
      getWalletBalances: async () => {
        throw new Error('rpc unreachable');
      },
    });
    const localServer = new FakeServer();
    registerPublishTools(localServer.asMcpServer(), localClient.asDkgClient(), makeConfig());

    const result = await localServer.call('dkg_publish', {
      contextGraphId: 'cg',
      quads: [{ subject: 'urn:s:1', predicate: 'urn:p:type', object: 'urn:Note' }],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).not.toMatch(/Chain:/);
  });

  it('F3+F13: dkg_shared_memory_publish echoes accessPolicy when registerIfNeeded ran', async () => {
    const result = await server.call('dkg_shared_memory_publish', {
      contextGraphId: 'cg',
      registerIfNeeded: true,
      accessPolicy: 1,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toMatch(/Registered on-chain:.*accessPolicy=1/);
  });

  it('F3+F13: response carries no warning prose (user explicit)', async () => {
    // The user explicitly opted for echo-only — no "WARNING: this
    // spends gas" / "Verify chainId before publishing" / similar
    // copy. Future-proofs against well-meaning re-additions.
    const r1 = await server.call('dkg_publish', {
      contextGraphId: 'cg',
      quads: [{ subject: 'urn:s:1', predicate: 'urn:p:type', object: 'urn:Note' }],
    });
    const r2 = await server.call('dkg_shared_memory_publish', { contextGraphId: 'cg' });
    for (const r of [r1, r2]) {
      expect(r.content[0].text).not.toMatch(/warning/i);
      expect(r.content[0].text).not.toMatch(/spends gas/i);
      expect(r.content[0].text).not.toMatch(/verify.*chain/i);
    }
  });

  // F11 (qa-review-round-2 / matrix v0.8 §4.10): the canonical
  // wire form for `accessPolicy` is the numeric `0|1` per the
  // daemon's `/api/context-graph/{create,register}` handlers
  // (`packages/cli/src/daemon/routes/context-graph.ts:455` /
  // `:509-510` — both reject anything other than literal 0/1).
  // Matrix v0.8 §4.10 line 291 had drifted to `z.enum(['open',
  // 'private'])`; this test pins the implementation against the
  // daemon canonical so a future re-alignment can't regress
  // silently to the string form.
  it('F11: dkg_shared_memory_publish accepts numeric accessPolicy 0 (open)', async () => {
    const result = await server.call('dkg_shared_memory_publish', {
      contextGraphId: 'cg',
      registerIfNeeded: true,
      accessPolicy: 0,
    });
    expect(result.isError).toBeFalsy();
  });

  it('F11: dkg_shared_memory_publish accepts numeric accessPolicy 1 (private)', async () => {
    const result = await server.call('dkg_shared_memory_publish', {
      contextGraphId: 'cg',
      registerIfNeeded: true,
      accessPolicy: 1,
    });
    expect(result.isError).toBeFalsy();
  });

  it('F11: dkg_shared_memory_publish rejects the legacy string `"open"` form at the schema layer', async () => {
    await expect(
      server.call('dkg_shared_memory_publish', {
        contextGraphId: 'cg',
        registerIfNeeded: true,
        accessPolicy: 'open',
      }),
    ).rejects.toThrow();
  });

  it('F11: dkg_shared_memory_publish rejects out-of-range numeric accessPolicy', async () => {
    // Matches the daemon's strict `accessPolicy !== 0 && accessPolicy !== 1`
    // guard at routes/context-graph.ts:509 — the schema layer must
    // reject the same shape (literal 0 / literal 1 only) before
    // the wire boundary.
    await expect(
      server.call('dkg_shared_memory_publish', {
        contextGraphId: 'cg',
        registerIfNeeded: true,
        accessPolicy: 2,
      }),
    ).rejects.toThrow();
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
