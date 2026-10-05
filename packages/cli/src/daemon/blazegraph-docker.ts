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
import * as os from 'node:os';
import { blazegraphHealthCmd as policyHealthCmd, buildBlazegraphPolicyRunArgs, computeBlazegraphHeapMb, fetchWithDeadline, sanitiseContainerName, blazegraphVolumeName, STORE_PROBE_TIMEOUT_MS } from './blazegraph-container-policy.js';
export { blazegraphMigrationVolumeName, computeBlazegraphHeapMb, blazegraphVolumeName, deriveBlazegraphContainerName, parseBlazegraphNamespaceEndpoint, fetchWithDeadline, STORE_PROBE_TIMEOUT_MS } from './blazegraph-container-policy.js';
import blazegraphRuntimeContract from
  '@origintrail-official/dkg/blazegraph-runtime-contract';
import {
  BlazegraphNamespaceManager,
  blazegraphNamespaceApiUrlFromBaseUrl,
  normalizeBlazegraphNamespace,
  type BlazegraphNamespaceEnsureResult,
} from '@origintrail-official/dkg-storage';
import { classifyBlazegraphContainerInspection, inspectBlazegraphContainerFacts, type BlazegraphContainerFacts } from './blazegraph-container-inspection.js';
import { runtimeAssetPaths } from '../runtime-assets.js';

const {
  BLAZEGRAPH_NAMESPACE_XML_TEMPLATE: NAMESPACE_XML_TEMPLATE,
  readBlazegraphImageMetadata,
} = blazegraphRuntimeContract;
type BlazegraphImageMetadata = ReturnType<typeof readBlazegraphImageMetadata>;

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
export const BLAZEGRAPH_DATA_DIR = BLAZEGRAPH_DATA_PATH;
export const BLAZEGRAPH_JOURNAL_FILE = `${BLAZEGRAPH_DATA_PATH}/bigdata.jnl`;
/** tomcat uid:gid in the pinned islandora image, used when seeding the journal. */
export const BLAZEGRAPH_TOMCAT_UID_GID = '100:1000';

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
  totalMemoryBytes?: () => number;
  env?: NodeJS.ProcessEnv;
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

export function defaultDockerRunner(): DockerRunner {
  return {
    run(args, opts) {
      return new Promise<DockerCommandResult>((resolve, reject) => {
        const child = spawn('docker', [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (b) => { stdout += b.toString('utf-8'); });
        child.stderr.on('data', (b) => { stderr += b.toString('utf-8'); });
        const timeoutMs = opts?.timeoutMs;
        let timedOut = false;
        const timer = timeoutMs
          ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs)
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
        child.once('close', (exitCode, signal) => {
          if (timer) clearTimeout(timer);
          resolve({ stdout, stderr: signal || exitCode === null ? `${stderr}\ndocker terminated by signal ${signal ?? 'unknown'}${timedOut ? ` after the ${timeoutMs}ms timeout` : ''}` : stderr, exitCode: signal || exitCode === null ? -1 : exitCode });
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

export function normaliseBlazegraphNamespace(namespace: string): string {
  return normalizeBlazegraphNamespace(namespace);
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

interface ContainerInspectInfo extends BlazegraphContainerFacts { exists: boolean }

async function inspectContainer(docker: DockerRunner, containerName: string): Promise<ContainerInspectInfo> {
  const result = await docker.run(['inspect', containerName]);
  const policy = {
    containerName, dataPath: BLAZEGRAPH_DATA_PATH, containerPort: BLAZEGRAPH_CONTAINER_PORT,
    logMaxSize: BLAZEGRAPH_LOG_MAX_SIZE, logMaxFile: BLAZEGRAPH_LOG_MAX_FILE,
    // Reuse follows the actual published port; migration uses configured-first
    // inspection because stopped containers may have no published bindings.
    portSource: 'published' as const,
  };
  const outcome = classifyBlazegraphContainerInspection(result, containerName, policy);
  if (outcome.kind === 'found') return { exists: true, ...outcome.facts };
  // Provisioning retains its command-status existence policy. Unreadable successful
  // output proves no journal policy; migration instead refuses this failed outcome.
  return { exists: outcome.kind === 'failed' && result.exitCode === 0,
    ...inspectBlazegraphContainerFacts(null, policy) };
}

function warnForLegacyContainerConfiguration(
  info: BlazegraphContainerFacts,
  containerName: string,
  log: (msg: string) => void,
): void {
  if (!info.journalMountIsVolume) log(
    `  WARNING: Reused container "${containerName}" is not confirmed to use the expected named Docker volume ` +
    `"${blazegraphVolumeName(containerName)}" at ${BLAZEGRAPH_DATA_PATH}. ` +
    'DKG will not recreate it automatically because that could discard Blazegraph data; back up the journal before migrating or recreating the container.',
  );
  if (!info.boundedLogs) log(
    `  WARNING: Reused container "${containerName}" does not use the bounded local log policy ` +
    `(max-size=${BLAZEGRAPH_LOG_MAX_SIZE}, max-file=${BLAZEGRAPH_LOG_MAX_FILE}). Its Docker logs remain outside the configured 4 GB rotation budget.`,
  );
  if (!info.boundedJvm || !info.healthProbe) log(`  WARNING: Reused container "${containerName}" lacks a bounded JVM with exit on OOM or a store health probe. Run dkg store harden --dry-run to inspect a data-preserving migration.`);
}

/**
 * Polls `/bigdata/status` until the server answers HTTP 200 or the
 * timeout elapses. Mirrors the 30-attempt loop in devnet.sh but
 * surfaces the failure as a thrown error.
 */
export async function waitForBlazegraphReady(opts: {
  url: string;
  fetch: typeof globalThis.fetch;
  intervalMs: number;
  timeoutMs: number;
  probeTimeoutMs?: number;
  log: (msg: string) => void;
}): Promise<void> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < opts.timeoutMs) {
    attempt++;
    try {
      const remaining = Math.max(1, opts.timeoutMs - (Date.now() - start));
      const r = await fetchWithDeadline(opts.fetch, `${opts.url}/bigdata/status`, { method: 'GET' }, Math.min(opts.probeTimeoutMs ?? STORE_PROBE_TIMEOUT_MS, remaining));
      if (r.ok) {
        opts.log(`  Blazegraph ready after ${attempt} probe(s) (~${Math.round((Date.now() - start) / 1000)}s).`);
        return;
      }
    } catch {
      // Container not listening yet — keep polling.
    }
    await new Promise((res) => setTimeout(res, Math.min(opts.intervalMs, Math.max(0, opts.timeoutMs - (Date.now() - start)))));
  }
  throw new Error(
    `Blazegraph did not become ready within ${opts.timeoutMs}ms ` +
    `at ${opts.url}/bigdata/status. Container started but the SPARQL endpoint is not responding.`,
  );
}

async function reconcileNamespace(opts: {
  url: string;
  namespace: string;
  fetch: typeof globalThis.fetch;
  log: (msg: string) => void;
}): Promise<BlazegraphNamespaceEnsureResult> {
  const manager = new BlazegraphNamespaceManager({
    namespaceApiUrl: blazegraphNamespaceApiUrlFromBaseUrl(opts.url),
    fetchImpl: opts.fetch,
  });
  const result = await manager.ensure(opts.namespace);
  if (result.created) {
    opts.log(`  Created Blazegraph namespace "${opts.namespace}".`);
  } else {
    opts.log(`  Namespace "${opts.namespace}" already exists.`);
  }
  return result;
}

async function finaliseReusedContainer(opts: {
  inspectInfo: ContainerInspectInfo;
  containerName: string;
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
    opts.log(`  Reusing running container "${opts.containerName}" on port ${port}.`);
  }
  warnForLegacyContainerConfiguration(opts.inspectInfo, opts.containerName, opts.log);
  await waitForBlazegraphReady({
    url,
    fetch: opts.fetch,
    intervalMs: opts.pollIntervalMs,
    timeoutMs: opts.pollTimeoutMs,
    log: opts.log,
  });
  const namespaceResult = await reconcileNamespace({
    url,
    namespace: opts.namespace,
    fetch: opts.fetch,
    log: opts.log,
  });
  return {
    url: namespaceResult.sparqlUrl,
    port,
    containerName: opts.containerName,
    managedByDkg: true,
    reused: true,
    namespaceCreated: namespaceResult.created,
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
  const heapMb = computeBlazegraphHeapMb((opts.totalMemoryBytes ?? os.totalmem)(), (opts.env ?? process.env).DKG_BLAZEGRAPH_HEAP_MB);

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
  const inspectInfo = await inspectContainer(docker, containerName);
  if (inspectInfo.exists && inspectInfo.running) {
    return finaliseReusedContainer({
      inspectInfo,
      containerName,
      fallbackPort: opts.port ?? DEFAULT_HOST_PORT_START,
      namespace,
      fetch,
      pollIntervalMs,
      pollTimeoutMs,
      log,
      announceReuse: true,
    });
  }

  let recreationVolumeName: string | undefined;

  // 3. Stopped-but-exists path — start it back up before re-creating.
  if (inspectInfo.exists && !inspectInfo.running) {
    log(`  Container "${containerName}" exists but is stopped; starting it.`);
    const startResult = await docker.run(['start', containerName]);
    if (startResult.exitCode !== 0) {
      if (!inspectInfo.journalMountIsVolume) {
        warnForLegacyContainerConfiguration(inspectInfo, containerName, log);
        throw new Error(
          `Cannot safely recreate stopped legacy container "${containerName}" after docker start failed ` +
          `(${startResult.stderr.trim() || 'unknown'}): its Blazegraph journal could not be confirmed in the expected ` +
          `named volume "${blazegraphVolumeName(containerName)}". Back up and migrate it before retrying.`,
        );
      }
      // The expected named volume preserves the journal, so removing only the
      // broken container is safe. The fresh path below reattaches that volume.
      recreationVolumeName = inspectInfo.journalVolumeName;
      log(`  docker start failed (${startResult.stderr.trim() || 'unknown'}); recreating.`);
      await docker.run(['rm', '-f', containerName]);
    } else {
      const restartedInfo = await inspectContainer(docker, containerName);
      return finaliseReusedContainer({
        inspectInfo: restartedInfo,
        containerName,
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
  const runResult = await docker.run(buildBlazegraphRunArgs({ containerName, hostPort: chosenPort, namespace, heapMb, volumeName: recreationVolumeName }));
  if (runResult.exitCode !== 0) {
    throw new Error(
      `Failed to start Blazegraph container — docker run exited ${runResult.exitCode}. ` +
      `stderr: ${runResult.stderr.trim() || '(empty)'}`,
    );
  }

  const url = `http://127.0.0.1:${chosenPort}`;
  await waitForBlazegraphReady({ url, fetch, intervalMs: pollIntervalMs, timeoutMs: pollTimeoutMs, log });
  const namespaceResult = await reconcileNamespace({ url, namespace, fetch, log });

  return {
    url: namespaceResult.sparqlUrl,
    port: chosenPort,
    containerName,
    managedByDkg: true,
    reused: false,
    namespaceCreated: namespaceResult.created,
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

/** One container policy used by both fresh provisioning and manual migration. */
export function buildBlazegraphRunArgs(opts: { containerName: string; hostPort: number; namespace: string; heapMb: number; image?: string; volumeName?: string }): string[] {
  return buildBlazegraphPolicyRunArgs({ ...opts, image: opts.image ?? BLAZEGRAPH_IMAGE,
    containerPort: BLAZEGRAPH_CONTAINER_PORT, dataPath: BLAZEGRAPH_DATA_PATH,
    logMaxSize: BLAZEGRAPH_LOG_MAX_SIZE, logMaxFile: BLAZEGRAPH_LOG_MAX_FILE });
}

export function blazegraphHealthCmd(namespace: string): string {
  return policyHealthCmd(namespace, BLAZEGRAPH_CONTAINER_PORT);
}

/** Migration gets a separate volume so a pre-existing volume remains untouched. */
