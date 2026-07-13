/**
 * Wizard + flag helpers that thread the triple-store backend through
 * `dkg init` and the adapter-setup commands.
 *
 * Plan: `.cursor/plans/blazegraph_v10_support_178da670.plan.md` §PR 2
 * items 1, 2, 3, 5.
 *
 * Locks in:
 *   - Default path (operator hits Enter / no flag): no store block.
 *   - Blazegraph + valid URL: store block persisted with
 *     `managedByDkg: false`.
 *   - Blazegraph + unreachable URL: surfaces formatted failure, allows
 *     retry, abort returns to local default.
 *   - Blazegraph + 404 URL: namespace-missing branch fires; message
 *     mentions namespace, not network.
 *   - Blank URL prompt: PR 2's "no Docker yet" message + retry.
 *   - `--store oxigraph` on a config that already has a Blazegraph
 *     block: clears the block (operator forcing local).
 *   - `--store blazegraph` without `--store-url`: throws with the
 *     missing-URL message (no half-written config).
 *   - Validation failure throws so the CLI dispatch wrapper exits.
 *   - Unknown backend value throws with the allow-list error.
 *
 * No filesystem I/O — `loadConfig` / `saveConfig` are injected as
 * mocks. Real config wiring is exercised in the higher-level adapter-
 * setup integration tests.
 */
import { describe, it, expect } from 'vitest';
import { applyStoreFlagsToConfig, promptStoreBackend } from '../src/store-wizard.js';
import type { DkgConfig } from '../src/config.js';

function mockFetch(handler: (input: any, init?: any) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn: typeof globalThis.fetch = (async (input: any, init?: any) => {
    calls.push({ url: String(input), init });
    return handler(input, init);
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

function mockAsk(scriptedAnswers: string[]): (q: string, def?: string) => Promise<string> {
  let i = 0;
  return async (q: string, def?: string) => {
    if (i >= scriptedAnswers.length) {
      throw new Error(`Out of scripted answers (asked: "${q}" default="${def ?? ''}")`);
    }
    const answer = scriptedAnswers[i++];
    return answer === '' && def ? def : answer;
  };
}

// ---------------------------------------------------------------------
// promptStoreBackend
// ---------------------------------------------------------------------

describe('promptStoreBackend', () => {
  it('defaults to oxigraph-server when the operator accepts the default', async () => {
    const { fn, calls } = mockFetch(() => new Response(null, { status: 200 }));
    const result = await promptStoreBackend({
      ask: mockAsk(['']), // accept default — now the managed local server
      fetch: fn,
      log: () => {},
    });
    expect(result.storeBlock).toEqual({ backend: 'oxigraph-server', options: {} });
    expect(calls).toHaveLength(0); // no URL probe issued for a local backend
  });

  it('returns no store block (embedded worker) when operator picks "oxigraph" by name', async () => {
    const result = await promptStoreBackend({
      ask: mockAsk(['oxigraph']),
      log: () => {},
    });
    expect(result.storeBlock).toBeNull();
  });

  it('returns no store block (embedded worker) when operator picks the worker by number', async () => {
    // Menu is now `1) oxigraph-server  2) oxigraph  3) blazegraph` — picking
    // option 2 must opt down to the embedded in-process worker (no block).
    const result = await promptStoreBackend({
      ask: mockAsk(['2']),
      log: () => {},
    });
    expect(result.storeBlock).toBeNull();
  });

  it('preserves an explicit embedded backend verbatim on Enter-through (no flip, no option loss)', async () => {
    // Codex #946 — only a *block-less* config should fall through to the new
    // oxigraph-server default. A node that explicitly chose a local worker
    // variant must keep it on a re-init Enter-through, AND keep its custom
    // `options` (e.g. the worker's `options.path`): returning `null` would let
    // `dkg init` write `store: undefined` and relocate the store on next boot.
    for (const backend of ['oxigraph', 'oxigraph-worker', 'oxigraph-persistent'] as const) {
      const existingStore = { backend, options: { path: '/custom/store' } };
      const result = await promptStoreBackend({
        ask: mockAsk(['']), // Enter
        existingStore,
        log: () => {},
      });
      expect(result.storeBlock).toEqual(existingStore);
    }
  });

  it('switches to the default embedded worker when an oxigraph-persistent node EXPLICITLY picks oxigraph', async () => {
    // Codex #946 — preservation must be gated on a true keep. An operator who
    // explicitly selects option `2` / "oxigraph" to move a worker/persistent
    // node back to the plain embedded default must NOT have the old backend +
    // options silently retained. Both the numeric and named selection switch.
    const existingStore = { backend: 'oxigraph-persistent', options: { path: '/custom/store' } };
    for (const answer of ['2', 'oxigraph']) {
      const result = await promptStoreBackend({
        ask: mockAsk([answer]),
        existingStore,
        log: () => {},
      });
      expect(result.storeBlock).toBeNull();
    }
  });

  it('falls back to the recommended default (oxigraph-server) on an out-of-range number', async () => {
    // Codex #946 — a typo'd digit ("9") must not silently downgrade a fresh
    // install to the embedded worker; it resolves to defaultBackend (option 1).
    const result = await promptStoreBackend({
      ask: mockAsk(['9']),
      log: () => {},
    });
    expect(result.storeBlock).toEqual({ backend: 'oxigraph-server', options: {} });
  });

  it('persists Blazegraph + reachable URL with managedByDkg=false', async () => {
    const { fn, calls } = mockFetch(
      () => new Response(JSON.stringify({ boolean: true }), { status: 200 }),
    );
    const logs: string[] = [];
    const result = await promptStoreBackend({
      ask: mockAsk(['blazegraph', 'http://blaze.test/sparql']),
      fetch: fn,
      log: (m) => logs.push(m),
    });
    expect(result.storeBlock).toEqual({
      backend: 'blazegraph',
      options: { url: 'http://blaze.test/sparql', managedByDkg: false },
    });
    expect(calls).toHaveLength(1);
    expect(logs.some((l) => l.includes('reachable'))).toBe(true);
  });

  it('surfaces failure formatter on unreachable URL, retries with a working one', async () => {
    let attempt = 0;
    const { fn } = mockFetch(() => {
      attempt++;
      if (attempt === 1) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ boolean: true }), { status: 200 });
    });
    const logs: string[] = [];
    const result = await promptStoreBackend({
      ask: mockAsk([
        'blazegraph',
        'http://broken.test/sparql', // first attempt: 500
        'y', // retry
        'http://blaze.test/sparql', // works
      ]),
      fetch: fn,
      log: (m) => logs.push(m),
    });
    expect(result.storeBlock).toEqual({
      backend: 'blazegraph',
      options: {
        url: 'http://blaze.test/sparql',
        managedByDkg: false,
      },
    });
    expect(logs.some((l) => l.includes('STORE-HEALTH'))).toBe(true);
  });

  it('aborts to local default when operator declines retry on unreachable URL', async () => {
    const { fn } = mockFetch(() => new Response('boom', { status: 500 }));
    const logs: string[] = [];
    const result = await promptStoreBackend({
      ask: mockAsk([
        'blazegraph',
        'http://broken.test/sparql',
        'n', // refuse retry
      ]),
      fetch: fn,
      log: (m) => logs.push(m),
    });
    expect(result.storeBlock).toBeNull();
    expect(logs.some((l) => l.includes('Aborting store setup'))).toBe(true);
  });

  it('surfaces namespace-missing branch on 404 with namespace-specific hint', async () => {
    const { fn } = mockFetch(
      () => new Response('not found', { status: 404 }),
    );
    const logs: string[] = [];
    const result = await promptStoreBackend({
      ask: mockAsk(['blazegraph', 'http://blaze.test/namespace/missing/sparql', 'n']),
      fetch: fn,
      log: (m) => logs.push(m),
    });
    expect(result.storeBlock).toBeNull();
    const block = logs.join('\n');
    expect(block).toMatch(/create the namespace/);
    expect(block).not.toMatch(/firewall/i); // namespace-missing biases AWAY from network hints
  });

  it('shows "Docker not detected" message on blank URL when Docker is unavailable, then accepts a manual URL', async () => {
    const { fn } = mockFetch(
      () => new Response(JSON.stringify({ boolean: true }), { status: 200 }),
    );
    const logs: string[] = [];
    const result = await promptStoreBackend({
      ask: mockAsk([
        'blazegraph',
        '', // blank URL — Docker probe fails → operator gets retry prompt
        'y', // retry
        'http://blaze.test/sparql', // works
      ]),
      isDockerAvailable: async () => false,
      fetch: fn,
      log: (m) => logs.push(m),
    });
    expect(result.storeBlock).toEqual({
      backend: 'blazegraph',
      options: {
        url: 'http://blaze.test/sparql',
        managedByDkg: false,
      },
    });
    expect(logs.some((l) => l.includes('Docker not detected'))).toBe(true);
  });

  it('aborts when operator types blank URL and declines retry (Docker unavailable)', async () => {
    const result = await promptStoreBackend({
      ask: mockAsk(['blazegraph', '', 'n']),
      isDockerAvailable: async () => false,
      log: () => {},
    });
    expect(result.storeBlock).toBeNull();
  });

  // ---------------------------------------------------------------
  // PR 3 Docker convenience branch
  // ---------------------------------------------------------------

  it('offers Docker provisioning when blank URL + Docker available, returns managedByDkg=true on accept', async () => {
    const provisionCalls: any[] = [];
    const result = await promptStoreBackend({
      ask: mockAsk([
        'blazegraph',
        '', // blank URL — triggers Docker offer
        'y', // accept Docker offer
      ]),
      nodeName: 'mynode',
      isDockerAvailable: async () => true,
      provisionBlazegraphDocker: async (opts) => {
        provisionCalls.push(opts);
        return {
          url: 'http://127.0.0.1:9999/bigdata/namespace/mynode/sparql',
          port: 9999,
          containerName: 'dkg-blazegraph-mynode',
          managedByDkg: true,
          reused: false,
          namespaceCreated: true,
        };
      },
      log: () => {},
    });
    expect(result.storeBlock).toEqual({
      backend: 'blazegraph',
      options: {
        url: 'http://127.0.0.1:9999/bigdata/namespace/mynode/sparql',
        managedByDkg: true,
      },
    });
    expect(provisionCalls).toHaveLength(1);
    expect(provisionCalls[0].namespace).toBe('mynode');
  });

  it('declines Docker offer ("n") falls through to retry/abort branch', async () => {
    const result = await promptStoreBackend({
      ask: mockAsk([
        'blazegraph',
        '',  // blank URL
        'n', // decline Docker
        'n', // decline retry-with-URL → abort to local default
      ]),
      isDockerAvailable: async () => true,
      provisionBlazegraphDocker: async () => {
        throw new Error('should not be called when operator declines');
      },
      log: () => {},
    });
    expect(result.storeBlock).toBeNull();
  });

  it('falls through to retry when Docker provisioning fails', async () => {
    const logs: string[] = [];
    const { fn } = mockFetch(
      () => new Response(JSON.stringify({ boolean: true }), { status: 200 }),
    );
    const result = await promptStoreBackend({
      ask: mockAsk([
        'blazegraph',
        '', // blank URL
        'y', // accept Docker
        // Docker fails → retry-with-URL prompt
        'y', // retry
        'http://blaze.test/sparql', // provide URL
      ]),
      nodeName: 'mynode',
      isDockerAvailable: async () => true,
      provisionBlazegraphDocker: async () => {
        throw new Error('docker daemon down');
      },
      fetch: fn,
      log: (m) => logs.push(m),
    });
    expect(result.storeBlock).toEqual({
      backend: 'blazegraph',
      options: {
        url: 'http://blaze.test/sparql',
        managedByDkg: false,
      },
    });
    expect(logs.some((l) => l.includes('Docker provisioning failed'))).toBe(true);
  });

  it('does not offer Docker when isDockerAvailable returns false', async () => {
    const logs: string[] = [];
    const result = await promptStoreBackend({
      ask: mockAsk(['blazegraph', '', 'n']),
      isDockerAvailable: async () => false,
      provisionBlazegraphDocker: async () => {
        throw new Error('should not be called');
      },
      log: (m) => logs.push(m),
    });
    expect(result.storeBlock).toBeNull();
    expect(logs.some((l) => l.includes('Docker not detected'))).toBe(true);
  });

  it('accepts oxigraph-server by name and returns a no-URL managed block', async () => {
    const result = await promptStoreBackend({
      ask: mockAsk(['oxigraph-server']),
      log: () => {},
    });
    expect(result.storeBlock).toEqual({ backend: 'oxigraph-server', options: {} });
  });

  it('preserves an existing oxigraph-server backend on Enter-through (no silent downgrade)', async () => {
    const result = await promptStoreBackend({
      ask: mockAsk(['']), // accept default — must resolve to oxigraph-server, not oxigraph
      existingStore: { backend: 'oxigraph-server', options: {} },
      log: () => {},
    });
    expect(result.storeBlock).toEqual({ backend: 'oxigraph-server', options: {} });
  });

  it('preserves existing oxigraph-server overrides on an interactive Enter-through', async () => {
    const result = await promptStoreBackend({
      ask: mockAsk(['']), // Enter keeps the managed backend
      existingStore: {
        backend: 'oxigraph-server',
        options: { port: 9999, location: '/data/oxi' },
      },
      log: () => {},
    });
    // port/location overrides (read by planManagedOxigraph at boot) survive —
    // dkg init persisting an empty block would silently reset them.
    expect(result.storeBlock).toEqual({
      backend: 'oxigraph-server',
      options: { port: 9999, location: '/data/oxi' },
    });
  });

  it('does not offer Docker for sparql-http backend', async () => {
    let provisionCalled = false;
    const result = await promptStoreBackend({
      ask: mockAsk(['sparql-http', '', 'n']),
      isDockerAvailable: async () => true,
      provisionBlazegraphDocker: async () => {
        provisionCalled = true;
        throw new Error('should not happen');
      },
      log: () => {},
    });
    expect(provisionCalled).toBe(false);
    expect(result.storeBlock).toBeNull();
  });

  it('preserves an existing sparql-http backend when operator presses Enter (no silent downgrade)', async () => {
    // sparql-http is not a listed numeric choice, but a node already
    // configured for it must not be silently downgraded to oxigraph when
    // the operator accepts the default. First '' = accept backend default
    // (must resolve to sparql-http, NOT option 1); second '' = accept the
    // pre-filled existing endpoint URL.
    const { fn } = mockFetch(
      () => new Response(JSON.stringify({ boolean: true }), { status: 200 }),
    );
    const result = await promptStoreBackend({
      ask: mockAsk(['', '']),
      // Use the canonical persisted shape the CLI actually writes for
      // sparql-http stores (queryEndpoint/updateEndpoint), so this regression
      // catches breakage of re-runs over real on-disk configs.
      existingStore: {
        backend: 'sparql-http',
        options: {
          queryEndpoint: 'http://byo.test/sparql',
          updateEndpoint: 'http://byo.test/sparql',
        },
      } as unknown as DkgConfig['store'],
      fetch: fn,
      log: () => {},
    });
    expect(result.storeBlock?.backend).toBe('sparql-http');
    expect(result.storeBlock?.options).toMatchObject({
      queryEndpoint: 'http://byo.test/sparql',
    });
  });

  it('preserves a DISTINCT updateEndpoint when reusing an existing sparql-http store (no silent collapse)', async () => {
    // A node can point query/update at different URLs. Pressing Enter through
    // the wizard must not overwrite updateEndpoint with the query endpoint.
    const { fn } = mockFetch(
      () => new Response(JSON.stringify({ boolean: true }), { status: 200 }),
    );
    const result = await promptStoreBackend({
      ask: mockAsk(['', '']),
      existingStore: {
        backend: 'sparql-http',
        options: {
          queryEndpoint: 'http://byo.test/query',
          updateEndpoint: 'http://byo.test/update',
        },
      } as unknown as DkgConfig['store'],
      fetch: fn,
      log: () => {},
    });
    expect(result.storeBlock?.backend).toBe('sparql-http');
    expect(result.storeBlock?.options).toMatchObject({
      queryEndpoint: 'http://byo.test/query',
      updateEndpoint: 'http://byo.test/update',
    });
  });

  it('preserves a --store sparql-http flag when operator presses Enter', async () => {
    const { fn } = mockFetch(
      () => new Response(JSON.stringify({ boolean: true }), { status: 200 }),
    );
    const result = await promptStoreBackend({
      ask: mockAsk(['', 'http://flag.test/sparql']),
      flagBackend: 'sparql-http',
      fetch: fn,
      log: () => {},
    });
    expect(result.storeBlock?.backend).toBe('sparql-http');
  });

  it('pre-fills URL prompt from --store-url flag', async () => {
    const { fn, calls } = mockFetch(
      () => new Response(JSON.stringify({ boolean: true }), { status: 200 }),
    );
    // Mock ask returns the default when the answer is empty; passing
    // '' simulates the operator hitting Enter to accept the pre-fill.
    const result = await promptStoreBackend({
      ask: mockAsk(['blazegraph', '']),
      flagBackend: 'blazegraph',
      flagUrl: 'http://prefilled.test/sparql',
      fetch: fn,
      log: () => {},
    });
    expect(result.storeBlock).toEqual({
      backend: 'blazegraph',
      options: {
        url: 'http://prefilled.test/sparql',
        managedByDkg: false,
      },
    });
    expect(calls[0].url).toBe('http://prefilled.test/sparql');
  });

  it('honours existingStore.options.url as the URL default on re-run', async () => {
    const { fn } = mockFetch(
      () => new Response(JSON.stringify({ boolean: true }), { status: 200 }),
    );
    const result = await promptStoreBackend({
      ask: mockAsk(['blazegraph', '']), // accept defaults
      existingStore: {
        backend: 'blazegraph',
        options: { url: 'http://existing.test/sparql' },
      },
      fetch: fn,
      log: () => {},
    });
    expect(result.storeBlock).toEqual({
      backend: 'blazegraph',
      options: {
        url: 'http://existing.test/sparql',
        managedByDkg: false,
      },
    });
  });

  it('supports sparql-http with its own queryEndpoint URL', async () => {
    const { fn, calls } = mockFetch(
      () => new Response(JSON.stringify({ boolean: true }), { status: 200 }),
    );
    const result = await promptStoreBackend({
      ask: mockAsk(['sparql-http', 'http://server.test/query']),
      fetch: fn,
      log: () => {},
    });
    expect(result.storeBlock).toEqual({
      backend: 'sparql-http',
      options: {
        queryEndpoint: 'http://server.test/query',
        updateEndpoint: 'http://server.test/query',
        managedByDkg: false,
      },
    });
    expect(calls[0].url).toBe('http://server.test/query');
  });
});

// ---------------------------------------------------------------------
// applyStoreFlagsToConfig
// ---------------------------------------------------------------------

interface MockConfigStore {
  current: DkgConfig;
  saved: DkgConfig[];
}

function newMockConfig(initial: DkgConfig): MockConfigStore {
  return { current: { ...initial }, saved: [] };
}

function mockConfigIO(store: MockConfigStore) {
  return {
    loadConfig: async () => ({ ...store.current }),
    saveConfig: async (next: DkgConfig) => {
      store.current = { ...next };
      store.saved.push({ ...next });
    },
  };
}

describe('applyStoreFlagsToConfig', () => {
  const baseConfig: DkgConfig = {
    name: 'dkg-node',
    apiPort: 9200,
    listenPort: 4001,
  } as DkgConfig;

  it('is a no-op when no --store flag is provided', async () => {
    const store = newMockConfig(baseConfig);
    const io = mockConfigIO(store);
    await applyStoreFlagsToConfig({ ...io, log: () => {} });
    expect(store.saved).toEqual([]);
  });

  it('persists blazegraph + URL after probe succeeds', async () => {
    const store = newMockConfig(baseConfig);
    const io = mockConfigIO(store);
    const { fn } = mockFetch(() => new Response(null, { status: 200 }));
    await applyStoreFlagsToConfig({
      ...io,
      storeFlag: 'blazegraph',
      storeUrlFlag: 'http://blaze.test/sparql',
      fetch: fn,
      log: () => {},
    });
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0].store).toEqual({
      backend: 'blazegraph',
      options: { url: 'http://blaze.test/sparql', managedByDkg: false },
    });
  });

  it('throws when --store blazegraph is passed without --store-url (no half-written config)', async () => {
    const store = newMockConfig(baseConfig);
    const io = mockConfigIO(store);
    await expect(
      applyStoreFlagsToConfig({
        ...io,
        storeFlag: 'blazegraph',
        log: () => {},
      }),
    ).rejects.toThrow(/requires --store-url/);
    expect(store.saved).toEqual([]);
  });

  it('throws when the URL is unreachable, persists nothing', async () => {
    const store = newMockConfig(baseConfig);
    const io = mockConfigIO(store);
    const { fn } = mockFetch(() => new Response('boom', { status: 500 }));
    await expect(
      applyStoreFlagsToConfig({
        ...io,
        storeFlag: 'blazegraph',
        storeUrlFlag: 'http://broken.test/sparql',
        fetch: fn,
        log: () => {},
      }),
    ).rejects.toThrow(/store URL validation failed/);
    expect(store.saved).toEqual([]);
  });

  it('throws on unknown backend value', async () => {
    const store = newMockConfig(baseConfig);
    const io = mockConfigIO(store);
    await expect(
      applyStoreFlagsToConfig({
        ...io,
        storeFlag: 'neptune',
        log: () => {},
      }),
    ).rejects.toThrow(/oxigraph, blazegraph, sparql-http/);
  });

  it('persists a daemon-managed oxigraph-server block (no URL required)', async () => {
    const store = newMockConfig(baseConfig);
    const io = mockConfigIO(store);
    await applyStoreFlagsToConfig({ ...io, storeFlag: 'oxigraph-server', log: () => {} });
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0].store).toEqual({ backend: 'oxigraph-server', options: {} });
  });

  it('preserves existing oxigraph-server overrides on a --store oxigraph-server re-run', async () => {
    const store = newMockConfig({
      ...baseConfig,
      store: { backend: 'oxigraph-server', options: { port: 9999, location: '/data/oxi' } },
    } as DkgConfig);
    const io = mockConfigIO(store);
    await applyStoreFlagsToConfig({ ...io, storeFlag: 'oxigraph-server', log: () => {} });
    expect(store.saved).toHaveLength(1);
    // port/location overrides (read by planManagedOxigraph at boot) survive.
    expect(store.saved[0].store).toEqual({
      backend: 'oxigraph-server',
      options: { port: 9999, location: '/data/oxi' },
    });
  });

  it('persists oxigraph-server with no URL required (daemon-managed)', async () => {
    const store = newMockConfig(baseConfig);
    const io = mockConfigIO(store);
    await applyStoreFlagsToConfig({
      ...io,
      storeFlag: 'oxigraph-server',
      log: () => {},
    });
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0].store).toEqual({ backend: 'oxigraph-server', options: {} });
  });

  it('clears existing store block when --store oxigraph is passed', async () => {
    const store = newMockConfig({
      ...baseConfig,
      store: {
        backend: 'blazegraph',
        options: { url: 'http://blaze.test/sparql', managedByDkg: false },
      },
    });
    const io = mockConfigIO(store);
    await applyStoreFlagsToConfig({
      ...io,
      storeFlag: 'oxigraph',
      log: () => {},
    });
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0].store).toBeUndefined();
  });

  it('is a no-op when --store oxigraph is passed and no existing store block', async () => {
    const store = newMockConfig(baseConfig);
    const io = mockConfigIO(store);
    await applyStoreFlagsToConfig({
      ...io,
      storeFlag: 'oxigraph',
      log: () => {},
    });
    expect(store.saved).toEqual([]);
  });

  it('accepts sparql-http with its endpoint URL', async () => {
    const store = newMockConfig(baseConfig);
    const io = mockConfigIO(store);
    const { fn, calls } = mockFetch(() => new Response(null, { status: 200 }));
    await applyStoreFlagsToConfig({
      ...io,
      storeFlag: 'sparql-http',
      storeUrlFlag: 'http://server.test/query',
      fetch: fn,
      log: () => {},
    });
    expect(store.saved[0].store).toEqual({
      backend: 'sparql-http',
      options: {
        queryEndpoint: 'http://server.test/query',
        updateEndpoint: 'http://server.test/query',
        managedByDkg: false,
      },
    });
    expect(calls[0].url).toBe('http://server.test/query');
  });
});
