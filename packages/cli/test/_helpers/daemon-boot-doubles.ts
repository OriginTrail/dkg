import { vi, type Mock } from 'vitest';

/**
 * Doubles for the suites that boot the REAL `runDaemonInner` against a fake
 * `DKGAgent` and a fake HTTP server. A change to what the daemon requires of
 * either is made here once, for every suite that takes its doubles from here.
 *
 * `vi.mock` is hoisted per test file and cannot be issued from a helper. Each suite
 * keeps its own `vi.mock('node:http', () => ({ createServer: mocks.createServer }))`
 * and `vi.mock('@origintrail-official/dkg-agent', ...)` factories (thin: they only
 * delegate to that file's own `mocks`) and hands these doubles to them:
 *
 *   mocks.createServer.mockImplementation(() => createFakeDaemonHttpServer());
 *   mocks.agentCreate.mockResolvedValue(createFakeDaemonAgent());
 *
 * Do not write `mockImplementation(createFakeDaemonHttpServer)`: the daemon calls
 * `createServer(requestListener)`, which would pass the listener as `options`.
 *
 * This module must not import, as a value, anything a suite mocks (`node:http`,
 * `@origintrail-official/dkg-agent`, `../../src/config.js`, ...): it would bind to
 * that file's mock. It imports only `vitest`.
 *
 * Every call builds fresh spies, so `vi.clearAllMocks()` / `vi.restoreAllMocks()`
 * in a suite cannot leak state between tests through this module.
 */

/** The port `address()` reports when a suite does not choose one. */
const DEFAULT_FAKE_API_PORT = 43123;

export interface FakeDaemonHttpServerOptions {
  /** The port `address()` reports: the API port the daemon believes it bound. */
  readonly port?: number;
}

/**
 * The slice of `http.Server` the daemon touches. `listen` and `close` complete
 * synchronously (their callback runs before they return); every chainable method
 * returns the server.
 */
export interface FakeDaemonHttpServer {
  readonly listen: Mock<(port: number, host: string, callback?: () => void) => FakeDaemonHttpServer>;
  readonly address: Mock<() => { port: number }>;
  readonly close: Mock<(callback?: () => void) => FakeDaemonHttpServer>;
  readonly on: Mock<() => FakeDaemonHttpServer>;
  readonly once: Mock<() => FakeDaemonHttpServer>;
}

export function createFakeDaemonHttpServer(options: FakeDaemonHttpServerOptions = {}): FakeDaemonHttpServer {
  const port = options.port ?? DEFAULT_FAKE_API_PORT;
  const server: FakeDaemonHttpServer = {
    listen: vi.fn((_port: number, _host: string, callback?: () => void) => {
      callback?.();
      return server;
    }),
    address: vi.fn(() => ({ port })),
    close: vi.fn((callback?: () => void) => {
      callback?.();
      return server;
    }),
    on: vi.fn(() => server),
    once: vi.fn(() => server),
  };
  return server;
}

export interface FakeDaemonAgentOptions<Libp2pExtras extends object = object> {
  /**
   * Members added to the fake `node.libp2p`, which by default has only
   * `getMultiaddrs()`: all an Edge boot touches. A suite that boots a Core node
   * supplies the extra surface that path reads (the AutoNAT watcher's event-listener
   * methods, the transport manager behind the post-start prerequisite check), so
   * that suite-specific shape and its spies stay in the suite.
   */
  readonly libp2p?: Libp2pExtras;
  /**
   * Called synchronously at the start of `stop()`, before the fake store closes: the
   * place for a suite to record where the agent stop sits in a shutdown sequence.
   */
  readonly onStop?: () => void;
}

/**
 * The slice of a `DKGAgent` the daemon's boot and shutdown touch, as spies the
 * suite can assert on. `stop()` closes the fake `store`, as the real agent does,
 * so `store.close` is observable as "the agent finished stopping". A suite hands
 * the result straight to its `agentCreate` mock (a bare `vi.fn()`), so no cast to
 * `DKGAgent` is needed and none is made here.
 */
export function createFakeDaemonAgent<Libp2pExtras extends object = object>(
  options: FakeDaemonAgentOptions<Libp2pExtras> = {},
) {
  const { libp2p: libp2pExtras, onStop } = options;
  const store = { close: vi.fn(async () => undefined) };
  const libp2p = { getMultiaddrs: vi.fn(() => []), ...libp2pExtras };
  return {
    configurePromoteQueue: vi.fn(),
    peerId: 'self-peer',
    multiaddrs: [],
    wallet: { keypair: { publicKey: new Uint8Array([1]), secretKey: new Uint8Array([2]) } },
    store,
    node: { libp2p },
    eventBus: { on: vi.fn() },
    assertion: { create: vi.fn(), write: vi.fn() },
    setChatAcl: vi.fn(),
    setSkillAcl: vi.fn(),
    onChat: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => {
      onStop?.();
      await store.close();
    }),
    // The daemon calls it only from the agent-chat route, never while booting.
    publishProfile: vi.fn(async () => undefined),
    ensureProfilePublished: vi.fn(async () => undefined),
    publishRelayRegistry: vi.fn(async () => undefined),
    ensureContextGraphLocal: vi.fn(async () => undefined),
    getSubscribedContextGraphs: vi.fn(() => new Map()),
    subscribeToContextGraph: vi.fn(),
    pingPeers: vi.fn(async () => undefined),
    listLocalAgents: vi.fn(() => []),
    registerImportedArtifactByteStore: vi.fn(),
    getDefaultAgentAddress: vi.fn(() => undefined),
    query: vi.fn(async () => ({ type: 'bindings', bindings: [] })),
    createContextGraph: vi.fn(),
    listContextGraphs: vi.fn(async () => []),
    createACKTransportFactory: vi.fn(() => ({})),
    drainRpcUsage: vi.fn(() => ({ calls: 0, errors: 0, throttledMs: 0, byEndpoint: {} })),
  };
}

export type FakeDaemonAgent = ReturnType<typeof createFakeDaemonAgent>;
