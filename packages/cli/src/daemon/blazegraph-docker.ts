/**
 * Blazegraph Docker provisioner (RFC 120, plan PR 3 item 1).
 *
 * One-command Blazegraph setup for operators who already have Docker.
 * Ported from `start_blazegraph` in [scripts/devnet.sh:254-303](../../../../scripts/devnet.sh)
 * with three changes for the operator-facing path:
 *
 *  1. Hard errors instead of "warn and fall back" — the operator opted
 *     in to Docker via the wizard / flag, so silently downgrading to
 *     Oxigraph would be worse than failing fast.
 *  2. Idempotent reuse — `docker inspect <name>` first; if the container
 *     is already running with the right namespace, return its URL
 *     without re-pulling or re-creating.
 *  3. Port-collision auto-bump — try ports `[9999, 9999+range)`
 *     before giving up. Operators may have V6 nodes on 9999 from
 *     prior installs.
 *  4. Durable, bounded storage — persist the journal in a named volume and
 *     retain at most 4 GB of compressed local-driver container logs.
 *
 * Every external dependency (docker CLI, fetch, port-free check) is
 * injectable so the unit tests run in <50 ms without spawning real
 * processes or making real HTTP calls. The defaults wire up to the
 * real `node:child_process` and `globalThis.fetch`.
 *
 * The "managedByDkg: true" return field is what tells chain-reset-wipe
 * (PR 1) it's allowed to `DROP ALL` instead of running a scoped DELETE
 * — Docker-provisioned namespaces are owned end-to-end by this CLI.
 *
 * The image reference is shared with `scripts/devnet.sh` through the
 * machine-readable repo-root `blazegraph-image.json` runtime asset.
 */
import { spawn } from 'node:child_process';
import * as net from 'node:net';
import { runtimeAssetPaths } from '../runtime-assets.js';
import {
  BLAZEGRAPH_NAMESPACE_XML_TEMPLATE as NAMESPACE_XML_TEMPLATE,
  readBlazegraphImageMetadata,
  type BlazegraphImageMetadata,
} from '../blazegraph-runtime-contract.js';

/**
 * Pinned multi-architecture image index — matches the deployed mainnet fleet.
 * `lyrasis/blazegraph:2.1.5` is amd64-only and fails with `exec format error`
 * when the provisioner runs on an arm64 Linux node.
 *
 * Keep the OCI-index digest immutable: CI reads the same metadata file and
 * requires both linux/amd64 and linux/arm64 manifests.
 */
/**
 * Shared XML template for a Blazegraph namespace tuned for DKG V10
 * (quads enabled, no truth maintenance, no text index, no statement
 * identifiers). Substitutes `{namespace}` for the namespace name.
 *
 * The canonical copy lives in packages/cli/blazegraph-image-metadata.cjs so
 * shell consumers (devnet + CI scripts) render the SAME document via its
 * `--namespace-xml` CLI mode — future tweaks land in exactly one place.
 * Re-exported here so TypeScript importers keep their existing name.
 */
export const BLAZEGRAPH_NAMESPACE_XML_TEMPLATE = NAMESPACE_XML_TEMPLATE;

function loadBlazegraphImageMetadata(): BlazegraphImageMetadata {
  for (const path of runtimeAssetPaths('blazegraph-image.json')) {
    try {
      return readBlazegraphImageMetadata(path);
    } catch { /* try the packaged runtime asset */ }
  }
  throw new Error('Could not load the pinned Blazegraph image metadata from blazegraph-image.json');
}

const BLAZEGRAPH_IMAGE_METADATA = loadBlazegraphImageMetadata();

/** Immutable multi-architecture image reference selected for provisioning. */
export const BLAZEGRAPH_IMAGE = BLAZEGRAPH_IMAGE_METADATA.image;

/** Container HTTP port declared alongside the selected image. */
export const BLAZEGRAPH_CONTAINER_PORT = BLAZEGRAPH_IMAGE_METADATA.containerPort;

/** Image-specific path containing the Blazegraph journal. */
export const BLAZEGRAPH_DATA_PATH = BLAZEGRAPH_IMAGE_METADATA.dataPath;

/** Default starting host port, matches devnet.sh and Blazegraph defaults. */
const DEFAULT_HOST_PORT_START = 9999;
/** Inclusive range above start to scan for a free port before failing. */
const DEFAULT_HOST_PORT_RANGE = 12; // 9999..10010
/** Keep enough Blazegraph history for incident response without filling the host disk. */
export const BLAZEGRAPH_LOG_MAX_SIZE = '200m';
export const BLAZEGRAPH_LOG_MAX_FILE = '20';

// --------------------------------------------------------------------
// Injectable types — tests pass mocks for every external boundary.
// --------------------------------------------------------------------

export interface DockerCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DockerRunner {
  /**
   * Run `docker <args>`. Should NOT throw on non-zero exit — return
   * the result so the provisioner can decide whether the failure is
   * fatal (e.g. `docker run`) or expected (e.g. `docker inspect` on a
   * non-existent container).
   */
  run(args: readonly string[], opts?: { timeoutMs?: number }): Promise<DockerCommandResult>;
}

export interface ProvisionBlazegraphDockerOptions {
  /** Used to name the container and create the namespace inside it. */
  namespace: string;
  /** Override container name. Default: `dkg-blazegraph-<namespace>`. */
  containerName?: string;
  /** Preferred host port. Default: 9999. */
  port?: number;
  /** Inclusive count of ports to scan starting at `port` for collisions. */
  portRange?: number;
  log?: (msg: string) => void;
  // Injectables (tests provide these; production callers omit them):
  docker?: DockerRunner;
  fetch?: typeof globalThis.fetch;
  /** Returns true if no listener is bound to the given port. */
  isPortFree?: (port: number) => Promise<boolean>;
  /** Polling interval while waiting for /bigdata/status to respond. */
  pollIntervalMs?: number;
  /** Total time to wait for Blazegraph to come up. */
  pollTimeoutMs?: number;
}

export interface ProvisionBlazegraphDockerResult {
  url: string;
  port: number;
  containerName: string;
  /**
   * Marker for chain-reset-wipe (PR 1): a `managedByDkg: true` store
   * may be wiped with `DROP ALL`. Always true from this function.
   */
  managedByDkg: true;
  /**
   * Whether the container was already running and re-used. Affects
   * the wizard log ("container created" vs "reusing existing").
   */
  reused: boolean;
  /**
   * Whether the namespace was created during this run vs already
   * present. Lets the wizard surface a useful summary line.
   */
  namespaceCreated: boolean;
}

// --------------------------------------------------------------------
// Default real-world implementations of the injectables.
// --------------------------------------------------------------------

function defaultDockerRunner(): DockerRunner {
  return {
    run(args, opts) {
      return new Promise<DockerCommandResult>((resolve, reject) => {
        const child = spawn('docker', [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (b) => { stdout += b.toString('utf-8'); });
        child.stderr.on('data', (b) => { stderr += b.toString('utf-8'); });
        const timeoutMs = opts?.timeoutMs;
        const timer = timeoutMs
          ? setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs)
          : undefined;
        child.once('error', (err) => {
          if (timer) clearTimeout(timer);
          // Most common case: docker binary not installed → ENOENT.
          // Surface a clear error rather than the cryptic spawn error.
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            reject(new Error(
              "docker CLI not found on PATH — install Docker Desktop or the Docker Engine and ensure 'docker' resolves on your shell PATH",
            ));
            return;
          }
          reject(err);
        });
        child.once('close', (exitCode) => {
          if (timer) clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
        });
      });
    },
  };
}

async function defaultIsPortFree(port: number): Promise<boolean> {
  // Use net.createServer instead of `lsof` so we don't shell out and
  // we keep the check cross-platform. A successful listen → close
  // means the port is free at this moment (TOCTOU exists but is the
  // same race Docker itself runs into).
  return new Promise<boolean>((resolve) => {
    const tester = net.createServer()
      .once('error', (err: NodeJS.ErrnoException) => {
        // EADDRINUSE → port taken. Any other code → assume taken to be
        // safe (e.g. EACCES on privileged ports).
        resolve(err.code !== 'EADDRINUSE' ? false : false);
      })
      .once('listening', () => {
        tester.close(() => resolve(true));
      })
      .listen(port, '127.0.0.1');
  });
}

// --------------------------------------------------------------------
// Internals
// --------------------------------------------------------------------

function sanitiseContainerName(namespace: string): string {
  // Docker container names: [a-zA-Z0-9_.-]+. Slugify so user-provided
  // node names like "Bob's Node" don't blow up `docker run`.
  const slug = namespace
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `dkg-blazegraph-${slug || 'node'}`;
}

export function normaliseBlazegraphNamespace(namespace: string): string {
  const slug = namespace
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'dkg-node';
}

function sparqlUrlForNamespace(baseUrl: string, namespace: string): string {
  return `${baseUrl}/bigdata/namespace/${encodeURIComponent(namespace)}/sparql`;
}

async function findFreePort(
  start: number,
  range: number,
  isPortFree: (port: number) => Promise<boolean>,
  log: (msg: string) => void,
): Promise<number> {
  for (let p = start; p < start + range; p++) {
    if (await isPortFree(p)) {
      if (p !== start) log(`  Port ${start} is in use (another Blazegraph or service?). Using port ${p} instead.`);
      return p;
    }
  }
  throw new Error(
    `No free port found in the range ${start}..${start + range - 1}. ` +
    'Close another service occupying these ports or pass --port <free port>.',
  );
}

interface BlazegraphContainerPolicyStatus {
  durableStorage: boolean;
  boundedLogs: boolean;
}

interface BlazegraphContainerSpec {
  containerName: string;
  volumeName: string;
  dataPath: string;
  mountSpec: string;
  logDriver: string;
  logOptions: readonly { name: string; value: string }[];
  dockerRunArgs(hostPort: number): readonly string[];
  inspectPolicy(info: unknown): BlazegraphContainerPolicyStatus;
  warningMessages(status: BlazegraphContainerPolicyStatus): string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createBlazegraphContainerSpec(containerName: string): BlazegraphContainerSpec {
  const volumeName = `${containerName}-data`;
  const dataPath = BLAZEGRAPH_DATA_PATH;
  const mountSpec = `type=volume,source=${volumeName},target=${dataPath}`;
  const logDriver = 'local';
  const logOptions = [
    { name: 'max-size', value: BLAZEGRAPH_LOG_MAX_SIZE },
    { name: 'max-file', value: BLAZEGRAPH_LOG_MAX_FILE },
  ] as const;

  return {
    containerName,
    volumeName,
    dataPath,
    mountSpec,
    logDriver,
    logOptions,
    dockerRunArgs(hostPort) {
      return [
        'run',
        '-d',
        '--restart', 'unless-stopped',
        '--name', containerName,
        // Blazegraph is an implementation detail of the local node. Do not
        // publish its unauthenticated SPARQL/update endpoint on every interface.
        '-p', `127.0.0.1:${hostPort}:${BLAZEGRAPH_CONTAINER_PORT}`,
        '--mount', mountSpec,
        // The local driver rotates and compresses logs. Explicit options keep
        // the bound independent of host-wide Docker daemon defaults.
        '--log-driver', logDriver,
        ...logOptions.flatMap(({ name, value }) => ['--log-opt', `${name}=${value}`]),
        BLAZEGRAPH_IMAGE,
      ];
    },
    inspectPolicy(info) {
      if (!isRecord(info)) return { durableStorage: false, boundedLogs: false };
      const mounts: unknown[] = Array.isArray(info.Mounts) ? info.Mounts : [];
      const durableStorage = mounts.some((mount) => {
        if (!isRecord(mount)) return false;
        return mount.Type === 'volume'
          && mount.Name === volumeName
          && mount.Destination === dataPath;
      });
      const hostConfig = isRecord(info.HostConfig) ? info.HostConfig : undefined;
      const logConfig = isRecord(hostConfig?.LogConfig) ? hostConfig.LogConfig : undefined;
      const config = isRecord(logConfig?.Config) ? logConfig.Config : undefined;
      const boundedLogs = logConfig?.Type === logDriver
        && logOptions.every(({ name, value }) => config?.[name] === value);
      return { durableStorage, boundedLogs };
    },
    warningMessages(status) {
      const warnings: string[] = [];
      if (!status.durableStorage) {
        warnings.push(
          `  WARNING: Reused container "${containerName}" is not confirmed to use the expected named Docker volume ` +
          `"${volumeName}" at ${dataPath}. ` +
          'DKG will not recreate it automatically because that could discard Blazegraph data; back up the journal before migrating or recreating the container.',
        );
      }
      if (!status.boundedLogs) {
        const policy = logOptions.map(({ name, value }) => `${name}=${value}`).join(', ');
        warnings.push(
          `  WARNING: Reused container "${containerName}" does not use the bounded ${logDriver} log policy ` +
          `(${policy}). Its Docker logs remain outside the configured 4 GB rotation budget.`,
        );
      }
      return warnings;
    },
  };
}

interface ContainerInspectInfo extends BlazegraphContainerPolicyStatus {
  exists: boolean;
  running: boolean;
  hostPort?: number;
}

async function inspectContainer(
  docker: DockerRunner,
  spec: BlazegraphContainerSpec,
): Promise<ContainerInspectInfo> {
  // `docker inspect <name>` exits non-zero with "No such object" when
  // the container doesn't exist; non-zero is our "doesn't exist"
  // signal. Otherwise parse the JSON to get state + port mapping.
  const result = await docker.run(['inspect', spec.containerName]);
  if (result.exitCode !== 0) {
    return {
      exists: false,
      running: false,
      durableStorage: false,
      boundedLogs: false,
    };
  }
  try {
    const arr = JSON.parse(result.stdout);
    const info = Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
    if (!info) {
      return {
        exists: true,
        running: false,
        durableStorage: false,
        boundedLogs: false,
      };
    }
    const running = info.State?.Running === true;
    const ports = info.NetworkSettings?.Ports;
    // Containers provisioned before the islandora image migration expose the
    // old image's 8080/tcp port. Prefer the current image contract, but retain
    // the real host mapping for an already-created legacy container instead of
    // silently falling back to 9999 and potentially targeting another store.
    const portBinding = ports?.[`${BLAZEGRAPH_CONTAINER_PORT}/tcp`]
      ?? (BLAZEGRAPH_CONTAINER_PORT === 8080 ? undefined : ports?.['8080/tcp']);
    const hostPort = Array.isArray(portBinding) && portBinding.length > 0
      ? Number(portBinding[0].HostPort)
      : undefined;
    return {
      exists: true,
      running,
      hostPort,
      ...spec.inspectPolicy(info),
    };
  } catch {
    return {
      exists: true,
      running: false,
      durableStorage: false,
      boundedLogs: false,
    };
  }
}

function warnForLegacyContainerConfiguration(
  info: ContainerInspectInfo,
  spec: BlazegraphContainerSpec,
  log: (msg: string) => void,
): void {
  for (const warning of spec.warningMessages(info)) log(warning);
}

/**
 * Polls `/bigdata/status` until the server answers HTTP 200 or the
 * timeout elapses. Mirrors the 30-attempt loop in devnet.sh but
 * surfaces the failure as a thrown error.
 */
async function waitForBlazegraphReady(opts: {
  url: string;
  fetch: typeof globalThis.fetch;
  intervalMs: number;
  timeoutMs: number;
  log: (msg: string) => void;
}): Promise<void> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < opts.timeoutMs) {
    attempt++;
    try {
      const r = await opts.fetch(`${opts.url}/bigdata/status`, { method: 'GET' });
      if (r.ok) {
        opts.log(`  Blazegraph ready after ${attempt} probe(s) (~${Math.round((Date.now() - start) / 1000)}s).`);
        return;
      }
    } catch {
      // Container not listening yet — keep polling.
    }
    await new Promise((res) => setTimeout(res, opts.intervalMs));
  }
  throw new Error(
    `Blazegraph did not become ready within ${opts.timeoutMs}ms ` +
    `at ${opts.url}/bigdata/status. Container started but the SPARQL endpoint is not responding.`,
  );
}

async function namespaceExists(opts: {
  url: string;
  namespace: string;
  fetch: typeof globalThis.fetch;
}): Promise<boolean> {
  // Blazegraph exposes per-namespace metadata at
  // `/bigdata/namespace/<ns>/sparql/properties`. A 200 means present.
  try {
    const r = await opts.fetch(
      `${opts.url}/bigdata/namespace/${encodeURIComponent(opts.namespace)}/sparql/properties`,
      { method: 'GET' },
    );
    return r.ok;
  } catch {
    return false;
  }
}

async function createNamespace(opts: {
  url: string;
  namespace: string;
  fetch: typeof globalThis.fetch;
  log: (msg: string) => void;
}): Promise<void> {
  const body = BLAZEGRAPH_NAMESPACE_XML_TEMPLATE.replace(
    '{namespace}',
    opts.namespace,
  );
  const r = await opts.fetch(`${opts.url}/bigdata/namespace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body,
  });
  if (!r.ok) {
    let detail = '';
    try { detail = (await r.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error(
      `Failed to create Blazegraph namespace "${opts.namespace}" — HTTP ${r.status}${detail ? `: ${detail}` : ''}`,
    );
  }
  opts.log(`  Created Blazegraph namespace "${opts.namespace}".`);
}

async function reconcileNamespace(opts: {
  url: string;
  namespace: string;
  fetch: typeof globalThis.fetch;
  log: (msg: string) => void;
}): Promise<boolean> {
  const created = !(await namespaceExists(opts));
  if (created) {
    await createNamespace(opts);
  } else {
    opts.log(`  Namespace "${opts.namespace}" already exists.`);
  }
  return created;
}

async function finaliseReusedContainer(opts: {
  inspectInfo: ContainerInspectInfo;
  spec: BlazegraphContainerSpec;
  fallbackPort: number;
  namespace: string;
  fetch: typeof globalThis.fetch;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  log: (msg: string) => void;
  announceReuse: boolean;
}): Promise<ProvisionBlazegraphDockerResult> {
  const port = opts.inspectInfo.hostPort ?? opts.fallbackPort;
  const url = `http://127.0.0.1:${port}`;
  if (opts.announceReuse) {
    opts.log(`  Reusing running container "${opts.spec.containerName}" on port ${port}.`);
  }
  warnForLegacyContainerConfiguration(opts.inspectInfo, opts.spec, opts.log);
  await waitForBlazegraphReady({
    url,
    fetch: opts.fetch,
    intervalMs: opts.pollIntervalMs,
    timeoutMs: opts.pollTimeoutMs,
    log: opts.log,
  });
  const namespaceCreated = await reconcileNamespace({
    url,
    namespace: opts.namespace,
    fetch: opts.fetch,
    log: opts.log,
  });
  return {
    url: sparqlUrlForNamespace(url, opts.namespace),
    port,
    containerName: opts.spec.containerName,
    managedByDkg: true,
    reused: true,
    namespaceCreated,
  };
}

// --------------------------------------------------------------------
// Public entry point
// --------------------------------------------------------------------

export async function provisionBlazegraphDocker(
  opts: ProvisionBlazegraphDockerOptions,
): Promise<ProvisionBlazegraphDockerResult> {
  const log = opts.log ?? console.log;
  const docker = opts.docker ?? defaultDockerRunner();
  const fetch = opts.fetch ?? globalThis.fetch;
  const isPortFree = opts.isPortFree ?? defaultIsPortFree;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const pollTimeoutMs = opts.pollTimeoutMs ?? 30_000;
  const portRange = opts.portRange ?? DEFAULT_HOST_PORT_RANGE;
  const namespace = normaliseBlazegraphNamespace(opts.namespace);
  if (namespace !== opts.namespace) {
    log(`  Normalized Blazegraph namespace "${opts.namespace}" → "${namespace}".`);
  }
  const containerName = opts.containerName ?? sanitiseContainerName(namespace);
  const containerSpec = createBlazegraphContainerSpec(containerName);

  // 1. Pre-flight: is docker installed?
  const versionResult = await docker.run(['--version'], { timeoutMs: 5000 });
  if (versionResult.exitCode !== 0) {
    throw new Error(
      "docker CLI is on PATH but `docker --version` failed — ensure the Docker daemon is installed and reachable. " +
      `stderr: ${versionResult.stderr.trim() || '(empty)'}`,
    );
  }
  log(`  Docker available: ${versionResult.stdout.trim().split('\n')[0]}`);

  // 2. Reuse path — is the container already running?
  const inspectInfo = await inspectContainer(docker, containerSpec);
  if (inspectInfo.exists && inspectInfo.running) {
    return finaliseReusedContainer({
      inspectInfo,
      spec: containerSpec,
      fallbackPort: opts.port ?? DEFAULT_HOST_PORT_START,
      namespace,
      fetch,
      pollIntervalMs,
      pollTimeoutMs,
      log,
      announceReuse: true,
    });
  }

  // 3. Stopped-but-exists path — start it back up before re-creating.
  if (inspectInfo.exists && !inspectInfo.running) {
    log(`  Container "${containerName}" exists but is stopped; starting it.`);
    const startResult = await docker.run(['start', containerName]);
    if (startResult.exitCode !== 0) {
      if (!inspectInfo.durableStorage) {
        warnForLegacyContainerConfiguration(inspectInfo, containerSpec, log);
        throw new Error(
          `Cannot safely recreate stopped legacy container "${containerName}" after docker start failed ` +
          `(${startResult.stderr.trim() || 'unknown'}): its Blazegraph journal could not be confirmed in the expected ` +
          `named volume "${containerSpec.volumeName}". Back up and migrate it before retrying.`,
        );
      }
      // The expected named volume preserves the journal, so removing only the
      // broken container is safe. The fresh path below reattaches that volume.
      log(`  docker start failed (${startResult.stderr.trim() || 'unknown'}); recreating.`);
      await docker.run(['rm', '-f', containerName]);
    } else {
      const restartedInfo = await inspectContainer(docker, containerSpec);
      return finaliseReusedContainer({
        inspectInfo: restartedInfo,
        spec: containerSpec,
        fallbackPort: opts.port ?? DEFAULT_HOST_PORT_START,
        namespace,
        fetch,
        pollIntervalMs,
        pollTimeoutMs,
        log,
        announceReuse: false,
      });
    }
  }

  // 4. Fresh create path — choose a port and run.
  const portStart = opts.port ?? DEFAULT_HOST_PORT_START;
  const chosenPort = await findFreePort(portStart, portRange, isPortFree, log);
  log(`  Starting Blazegraph container "${containerName}" on port ${chosenPort}…`);
  const runResult = await docker.run(containerSpec.dockerRunArgs(chosenPort));
  if (runResult.exitCode !== 0) {
    throw new Error(
      `Failed to start Blazegraph container — docker run exited ${runResult.exitCode}. ` +
      `stderr: ${runResult.stderr.trim() || '(empty)'}`,
    );
  }

  const url = `http://127.0.0.1:${chosenPort}`;
  await waitForBlazegraphReady({ url, fetch, intervalMs: pollIntervalMs, timeoutMs: pollTimeoutMs, log });
  const namespaceCreated = await reconcileNamespace({ url, namespace, fetch, log });

  return {
    url: sparqlUrlForNamespace(url, namespace),
    port: chosenPort,
    containerName,
    managedByDkg: true,
    reused: false,
    namespaceCreated,
  };
}

/**
 * Cheap "is docker available?" check for the wizard. Doesn't need to
 * start anything — we just need to know whether to offer the Docker
 * branch or skip straight to the manual-URL retry.
 */
export async function isDockerAvailable(
  docker?: DockerRunner,
): Promise<boolean> {
  const runner = docker ?? defaultDockerRunner();
  try {
    const result = await runner.run(['--version'], { timeoutMs: 3000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
