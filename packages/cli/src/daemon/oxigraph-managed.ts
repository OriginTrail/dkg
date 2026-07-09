/**
 * Managed local Oxigraph server orchestration (Release 2 opt-in path).
 *
 * `store.backend: 'oxigraph-server'` means "run a daemon-managed local
 * Oxigraph server and talk to it over SPARQL HTTP". This module turns that
 * one config value into:
 *
 *   1. a concrete launch plan (binary cache dir, RocksDB location, bind
 *      port, blob directory) — {@link planManagedOxigraph}, pure so it's
 *      unit-tested without spawning anything; and
 *   2. a running, health-checked server plus a `store` config rewritten to
 *      `backend: 'sparql-http'` pointing at it — {@link startManagedOxigraph}.
 *
 * The rewrite is the whole trick: downstream boot code (config validation,
 * the external-store health check, namespace identity tag, chain-reset
 * wipe, and the `sparql-http` adapter itself) already handles external
 * SPARQL backends. By normalising `oxigraph-server` → `sparql-http` in
 * memory before any of that runs, the *only* new code path is spawning the
 * child — everything else is reused unchanged.
 *
 * `managedByDkg: true` is set on the rewritten options so chain-reset wipe
 * uses `DROP ALL` (the local RocksDB is owned end-to-end by this daemon),
 * matching the Blazegraph-Docker provisioner's contract.
 */
import { join } from 'node:path';
import { ensureOxigraphBinary } from './oxigraph-binary.js';
import {
  startOxigraphServer,
  type OxigraphServerHandle,
  type OxigraphServerIo,
} from './oxigraph-server.js';

/** Config value that opts a node into the daemon-managed local server. */
export const MANAGED_OXIGRAPH_BACKEND = 'oxigraph-server';

/** Default loopback bind port. Override via `store.options.port`. */
export const DEFAULT_OXIGRAPH_PORT = 7878;

/** Same port validation as {@link planManagedOxigraph} — shared with status. */
export function resolveManagedOxigraphPort(
  options: Record<string, unknown> | undefined,
): number {
  const rawPort = options?.port;
  return typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536
    ? rawPort
    : DEFAULT_OXIGRAPH_PORT;
}

function resolvePositiveIntegerOption(
  options: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = options?.[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

interface StoreConfigLike {
  backend?: unknown;
  options?: Record<string, unknown>;
  graphSetIndex?: boolean | {
    enabled?: boolean;
    revalidateMs?: number;
  };
}

interface ConfigLike {
  store?: StoreConfigLike;
  largeLiteralStorage?: {
    enabled?: boolean;
    thresholdBytes?: number;
    directory?: string;
  };
  sharedMemoryPublicSnapshotStorage?: {
    enabled?: boolean;
    directory?: string;
  };
}

export interface ManagedOxigraphPlan {
  /** Loopback bind port. */
  port: number;
  /** RocksDB data directory (`oxigraph serve --location`). */
  location: string;
  /** Directory the verified binary is cached in. */
  cacheDir: string;
  /**
   * `store` config rewritten to the equivalent `sparql-http` backend so
   * the rest of boot treats it as a normal external endpoint. Endpoints
   * are filled in by {@link startManagedOxigraph} once the port is bound.
   */
  storeConfigTemplate: {
    backend: 'sparql-http';
    options: Record<string, unknown>;
    graphSetIndex?: StoreConfigLike['graphSetIndex'];
  };
  /**
   * largeLiteralStorage to apply when the operator didn't configure one.
   * External backends have no `options.path`, so the blob store would
   * throw without an explicit directory; we default it under the data dir
   * to preserve parity with the local Oxigraph default.
   */
  largeLiteralStorage: { enabled: boolean; thresholdBytes?: number; directory: string };
  /** Startup readiness deadline passed to the managed server supervisor. */
  readyTimeoutMs?: number;
  /** Native Oxigraph query timeout, passed as `oxigraph serve --timeout-s`. */
  queryTimeoutS?: number;
  /**
   * sharedMemoryPublicSnapshotStorage with a defaulted `directory`, set
   * only when the operator enabled it. Same rewrite hazard as
   * largeLiteralStorage: the local Oxigraph path infers a directory, but
   * after rewriting to `sparql-http` a config with `enabled: true` and no
   * explicit `directory` would fail validateStoreConfig(). Defaulted to
   * the same `swm-public-snapshots` dir createPublicSnapshotStore() uses.
   */
  sharedMemoryPublicSnapshotStorage?: { enabled: boolean; directory: string };
}

/**
 * Pure: decide how to launch the managed server from config, or return
 * null if this node isn't using `oxigraph-server`. Does no I/O.
 */
export function planManagedOxigraph(
  config: ConfigLike,
  dataDir: string,
): ManagedOxigraphPlan | null {
  if (config.store?.backend !== MANAGED_OXIGRAPH_BACKEND) return null;

  const options = config.store.options ?? {};
  const port = resolveManagedOxigraphPort(options);
  const readyTimeoutMs = resolvePositiveIntegerOption(options, 'readyTimeoutMs');
  const queryTimeoutS = resolvePositiveIntegerOption(options, 'queryTimeoutS');
  const location =
    typeof options.location === 'string' && options.location.trim()
      ? options.location
      : join(dataDir, 'oxigraph-data');
  // Honour an operator `cacheDir` override (preserved by the wizard/flag flow)
  // the same way `location` is; fall back to the default binary cache dir.
  const cacheDir =
    typeof options.cacheDir === 'string' && options.cacheDir.trim()
      ? options.cacheDir
      : join(dataDir, 'oxigraph');

  const largeLiteralStorage = {
    enabled: config.largeLiteralStorage?.enabled ?? true,
    thresholdBytes: config.largeLiteralStorage?.thresholdBytes,
    directory: config.largeLiteralStorage?.directory ?? join(dataDir, 'literal-blobs'),
  };

  // Only defaulted when the operator opted in: the feature is disabled by
  // default, and validateStoreConfig() only requires a directory when
  // enabled === true. Mirrors createPublicSnapshotStore()'s default dir.
  const sharedMemoryPublicSnapshotStorage =
    config.sharedMemoryPublicSnapshotStorage?.enabled === true
      ? {
          enabled: true,
          directory:
            config.sharedMemoryPublicSnapshotStorage.directory ??
            join(dataDir, 'swm-public-snapshots'),
        }
      : undefined;

  const graphSetIndex = config.store?.graphSetIndex;
  const storeConfigTemplate: ManagedOxigraphPlan['storeConfigTemplate'] = {
    backend: 'sparql-http',
    // managedByDkg lets chain-reset wipe DROP ALL on the local RocksDB
    // we own end-to-end; queryEndpoint/updateEndpoint added at launch.
    options: { managedByDkg: true },
  };
  if (graphSetIndex !== undefined) {
    storeConfigTemplate.graphSetIndex = graphSetIndex;
  }

  return {
    port,
    location,
    cacheDir,
    storeConfigTemplate,
    largeLiteralStorage,
    readyTimeoutMs,
    queryTimeoutS,
    sharedMemoryPublicSnapshotStorage,
  };
}

export interface ManagedOxigraphResult {
  handle: OxigraphServerHandle;
  /** Drop-in replacement for `config.store`. */
  storeConfig: {
    backend: 'sparql-http';
    options: Record<string, unknown>;
    graphSetIndex?: StoreConfigLike['graphSetIndex'];
  };
  largeLiteralStorage: { enabled: boolean; thresholdBytes?: number; directory: string };
  /** Set only when the operator enabled the feature (else leave config as-is). */
  sharedMemoryPublicSnapshotStorage?: { enabled: boolean; directory: string };
}

export interface StartManagedOxigraphOptions {
  config: ConfigLike;
  dataDir: string;
  log?: (msg: string) => void;
  platform?: NodeJS.Platform;
  arch?: string;
  binaryIo?: Parameters<typeof ensureOxigraphBinary>[0]['io'];
  serverIo?: Partial<OxigraphServerIo>;
  readyTimeoutMs?: number;
}

/**
 * Start the managed server if configured. Returns null when the node uses
 * a different backend (so callers can `const m = await start(...); if (m)
 * { config.store = m.storeConfig; ... }`). Throws if the binary can't be
 * fetched/verified or the server never becomes ready — boot should treat
 * that as fatal (a misconfigured store is not safe to run half-up).
 */
export async function startManagedOxigraph(
  opts: StartManagedOxigraphOptions,
): Promise<ManagedOxigraphResult | null> {
  const plan = planManagedOxigraph(opts.config, opts.dataDir);
  if (!plan) return null;
  const log = opts.log ?? (() => {});

  const binaryPath = await ensureOxigraphBinary({
    cacheDir: plan.cacheDir,
    platform: opts.platform,
    arch: opts.arch,
    log,
    io: opts.binaryIo,
  });

  const handle = await startOxigraphServer({
    binaryPath,
    location: plan.location,
    port: plan.port,
    log,
    readyTimeoutMs: opts.readyTimeoutMs ?? plan.readyTimeoutMs,
    queryTimeoutS: plan.queryTimeoutS,
    io: opts.serverIo,
  });

  const storeConfig: ManagedOxigraphResult['storeConfig'] = {
    backend: 'sparql-http',
    options: {
      ...plan.storeConfigTemplate.options,
      queryEndpoint: handle.queryEndpoint,
      updateEndpoint: handle.updateEndpoint,
    },
  };
  if (plan.storeConfigTemplate.graphSetIndex !== undefined) {
    storeConfig.graphSetIndex = plan.storeConfigTemplate.graphSetIndex;
  }

  return {
    handle,
    storeConfig,
    largeLiteralStorage: plan.largeLiteralStorage,
    sharedMemoryPublicSnapshotStorage: plan.sharedMemoryPublicSnapshotStorage,
  };
}
