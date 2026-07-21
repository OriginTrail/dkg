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
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import { runtimeAssetPaths } from '../runtime-assets.js';

/**
 * Shared XML template for a Blazegraph namespace tuned for DKG V10
 * (quads enabled, no truth maintenance, no text index, no statement
 * identifiers). Substitutes `{namespace}` for the namespace name.
 *
 * Mirrors the body inlined at scripts/devnet.sh:287-294. Kept here so
 * future tweaks land in one place.
 */
export const BLAZEGRAPH_NAMESPACE_XML_TEMPLATE = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE properties SYSTEM "http://java.sun.com/dtd/properties.dtd">
<properties>
  <entry key="com.bigdata.rdf.sail.namespace">{namespace}</entry>
  <entry key="com.bigdata.rdf.store.AbstractTripleStore.quads">true</entry>
  <entry key="com.bigdata.rdf.store.AbstractTripleStore.statementIdentifiers">false</entry>
  <entry key="com.bigdata.rdf.store.AbstractTripleStore.textIndex">false</entry>
  <entry key="com.bigdata.rdf.sail.truthMaintenance">false</entry>
  <entry key="com.bigdata.rdf.store.AbstractTripleStore.axiomsClass">com.bigdata.rdf.axioms.NoAxioms</entry>
</properties>`;

/**
 * Pinned multi-architecture image index — matches the deployed mainnet fleet.
 * `lyrasis/blazegraph:2.1.5` is amd64-only and fails with `exec format error`
 * when the provisioner runs on an arm64 Linux node.
 *
 * Keep the OCI-index digest immutable: CI reads the same metadata file and
 * requires both linux/amd64 and linux/arm64 manifests.
 */
interface BlazegraphImageMetadata {
  image: string;
  containerPort: number;
}

interface BlazegraphImageMetadataParser {
  readBlazegraphImageMetadata(path: string): BlazegraphImageMetadata;
}

const require = createRequire(import.meta.url);
const { readBlazegraphImageMetadata } = require(
  '../../blazegraph-image-metadata.cjs',
) as BlazegraphImageMetadataParser;

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

/**
 * In-container journal data dir. Provenance: the deployed image's
 * RWStore.properties sets a RELATIVE path (`com.bigdata.journal.
 * AbstractJournal.file=blazegraph.jnl`) — it is the image's startup
 * wiring that lands the journal at /data/bigdata.jnl. The constants
 * below were verified against the LIVE fleet containers
 * (`docker exec <container> find / -name '*.jnl'` → /data/bigdata.jnl,
 * owned tomcat:tomcat), not inferred from RWStore.properties. Mounting
 * a named volume here is what makes a container recreate data-safe
 * (2026-07-18 wedge incident: the fleet's legacy containers keep the
 * journal in the writable layer, so `docker rm` would destroy the only
 * copy).
 */
export const BLAZEGRAPH_DATA_DIR = '/data';

/** Absolute journal path inside the container (see BLAZEGRAPH_DATA_DIR). */
export const BLAZEGRAPH_JOURNAL_FILE = '/data/bigdata.jnl';

/**
 * Numeric uid:gid of the image's tomcat user (verified on the fleet:
 * /data is owned tomcat:tomcat = 100:1000). Used when seeding a volume
 * with a journal copied out of a legacy container.
 */
export const BLAZEGRAPH_TOMCAT_UID_GID = '100:1000';

/** Default starting host port, matches devnet.sh and Blazegraph defaults. */
const DEFAULT_HOST_PORT_START = 9999;
/** Inclusive range above start to scan for a free port before failing. */
const DEFAULT_HOST_PORT_RANGE = 12; // 9999..10010

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
  /** Host RAM probe used for the JVM heap computation. Default: os.totalmem. */
  totalMemoryBytes?: () => number;
  /** Environment for operator overrides (DKG_BLAZEGRAPH_HEAP_MB). Default: process.env. */
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

/**
 * Real `docker` CLI runner. Exported for the sibling modules that share
 * the provisioner's docker boundary (blazegraph-harden.ts migration,
 * store-health-check.ts runtime monitor); tests inject mocks instead.
 */
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
          // A signal-terminated child reports `exitCode: null` + a non-null
          // signal. The old `exitCode ?? 0` turned our own timeout SIGKILL
          // into a FAKE SUCCESS — a `docker stop`/`docker cp` that was
          // killed mid-flight must never look like it completed. Callers
          // treat non-zero as failure, so report -1 with a stderr note.
          if (exitCode === null || signal !== null) {
            resolve({
              stdout,
              stderr:
                `${stderr}${stderr.endsWith('\n') || stderr === '' ? '' : '\n'}` +
                `docker terminated by signal ${signal ?? 'unknown'}` +
                `${timedOut ? ` after the ${timeoutMs}ms timeout` : ''} — treated as failure`,
              exitCode: -1,
            });
            return;
          }
          resolve({ stdout, stderr, exitCode });
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

/**
 * JVM heap sizing policy (2026-07-18 wedge incident): the islandora image
 * ships NO -Xmx, so the JVM defaults to ~25% of host RAM and dies in a G1
 * full-GC spiral under sync-responder load. Policy: 40% of host RAM,
 * clamped to [2 GiB, 8 GiB]. An operator override via
 * `DKG_BLAZEGRAPH_HEAP_MB` wins verbatim (unclamped) — the operator knows
 * their host better than the clamp does.
 */
export function computeBlazegraphHeapMb(
  totalMemBytes: number,
  envOverride?: string,
): number {
  // Strictly decimal digits only. `Number()` also accepts '0x10', '6e3',
  // '3.0', Infinity-adjacent forms etc. — an operator typo like '6e3'
  // must fall back to the computed policy, not become a 6000 MB heap by
  // accident (or '0x10' → 16 MB, which would OOM-loop the store).
  const raw = envOverride?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const override = Number(raw);
    if (Number.isInteger(override) && override > 0) return override;
  }
  const forty = Math.round((0.4 * totalMemBytes) / 2 ** 20);
  return Math.min(8192, Math.max(2048, forty));
}

/** Named docker volume holding the journal for a given container. */
export function blazegraphVolumeName(containerName: string): string {
  return `${containerName}-data`;
}

/**
 * Container-side health probe: a bounded empty-pattern ASK against the
 * namespace endpoint. Catches the alive-but-deaf failure mode (JVM up,
 * Tomcat's HTTP poller thread OOME-killed) that `--restart unless-stopped`
 * can never see — the wedged container shows `unhealthy` in `docker ps`.
 * curl is verified present in the image at /usr/bin/curl.
 */
export function blazegraphHealthCmd(namespace: string): string {
  return `curl -sf -m 8 'http://127.0.0.1:${BLAZEGRAPH_CONTAINER_PORT}/bigdata/namespace/${encodeURIComponent(namespace)}/sparql?query=ASK%7B%7D'`;
}

/**
 * Full `docker run` argv for a hardened Blazegraph container. Extracted
 * from the inline array in the fresh-create path so the survivability
 * flags are unit-testable and shared with the `dkg store harden`
 * migration (blazegraph-harden.ts):
 *   - TOMCAT_JAVA_OPTS is the verified env hook — the image's
 *     /opt/tomcat/bin/setenv.sh does `export JAVA_OPTS="${TOMCAT_JAVA_OPTS}"`
 *     (with-contenv, re-read on every container start).
 *   - -XX:+ExitOnOutOfMemoryError turns the OOME wedge into a JVM exit,
 *     which `--restart unless-stopped` can actually heal.
 *   - Named volume keeps the journal out of the writable layer.
 *   - json-file log caps stop the >4 GB unrotated log growth seen on fleet.
 */
export function buildBlazegraphRunArgs(opts: {
  containerName: string;
  hostPort: number;
  namespace: string;
  heapMb: number;
  image?: string;
}): string[] {
  return [
    'run',
    '-d',
    '--restart', 'unless-stopped',
    '--name', opts.containerName,
    // Blazegraph is an implementation detail of the local node. Do not publish
    // its unauthenticated SPARQL/update endpoint on every host interface.
    '-p', `127.0.0.1:${opts.hostPort}:${BLAZEGRAPH_CONTAINER_PORT}`,
    '-e', `TOMCAT_JAVA_OPTS=-Xmx${opts.heapMb}m -XX:+ExitOnOutOfMemoryError`,
    '-v', `${blazegraphVolumeName(opts.containerName)}:${BLAZEGRAPH_DATA_DIR}`,
    '--log-opt', 'max-size=64m',
    '--log-opt', 'max-file=3',
    '--health-cmd', blazegraphHealthCmd(opts.namespace),
    '--health-interval', '30s',
    '--health-timeout', '10s',
    '--health-retries', '3',
    // Fresh provisions create the namespace only after the container is up,
    // so give the health probe a generous start period before it counts.
    '--health-start-period', '120s',
    opts.image ?? BLAZEGRAPH_IMAGE,
  ];
}

/**
 * Resolve the daemon-managed container name from `config.store.options`.
 * Prefers a persisted `options.containerName` (written by `dkg store
 * harden`); otherwise derives it from the SPARQL URL's namespace segment.
 * Fleet configs persist only `{url, managedByDkg}` and the node name is
 * NOT the namespace (e.g. node "saturn_station" runs namespace "dkg" in
 * container "dkg-blazegraph-dkg"), so the URL is the only truthful source.
 * Returns null when neither is available — callers must treat that as
 * "not managed" and never touch docker.
 */
/** Parsed shape of a managed Blazegraph namespace SPARQL endpoint URL. */
export interface BlazegraphNamespaceEndpoint {
  /** Decoded namespace segment. */
  namespace: string;
  /** Everything before `/bigdata/…` (scheme + host + port). */
  baseUrl: string;
  /** Canonical namespace SPARQL URL rebuilt from the parsed parts. */
  sparqlUrl: string;
}

/**
 * THE parser for the managed Blazegraph endpoint shape
 * (`…/bigdata/namespace/<ns>/sparql`). The harden command, the container-name
 * derivation and the monitor all reason about the same store URL; parsing it
 * in one place keeps their interpretations from drifting when the endpoint
 * shape (or an explicit config namespace field) changes.
 */
export function parseBlazegraphNamespaceEndpoint(
  url: unknown,
): BlazegraphNamespaceEndpoint | null {
  if (typeof url !== 'string') return null;
  const match = url.match(/^(.*)\/bigdata\/namespace\/([^/]+)\/sparql\/?$/);
  if (!match) return null;
  try {
    const namespace = decodeURIComponent(match[2]);
    return {
      namespace,
      baseUrl: match[1],
      sparqlUrl: sparqlUrlForNamespace(match[1], namespace),
    };
  } catch {
    return null;
  }
}

export function deriveBlazegraphContainerName(
  storeOptions: Record<string, unknown> | undefined,
): string | null {
  if (typeof storeOptions?.containerName === 'string' && storeOptions.containerName) {
    return storeOptions.containerName;
  }
  const endpoint = parseBlazegraphNamespaceEndpoint(storeOptions?.url);
  return endpoint ? sanitiseContainerName(endpoint.namespace) : null;
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

interface ContainerInspectInfo {
  exists: boolean;
  running: boolean;
  hostPort?: number;
}

async function inspectContainer(
  docker: DockerRunner,
  name: string,
): Promise<ContainerInspectInfo> {
  // `docker inspect <name>` exits non-zero with "No such object" when
  // the container doesn't exist; non-zero is our "doesn't exist"
  // signal. Otherwise parse the JSON to get state + port mapping.
  const result = await docker.run(['inspect', name]);
  if (result.exitCode !== 0) {
    return { exists: false, running: false };
  }
  try {
    const arr = JSON.parse(result.stdout);
    const info = Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
    if (!info) return { exists: true, running: false };
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
    return { exists: true, running, hostPort };
  } catch {
    return { exists: true, running: false };
  }
}

/**
 * Polls `/bigdata/status` until the server answers HTTP 200 or the
 * timeout elapses. Mirrors the 30-attempt loop in devnet.sh but
 * surfaces the failure as a thrown error. Exported so the
 * `dkg store harden` migration (blazegraph-harden.ts) reuses the same
 * readiness poll after recreating a container.
 */
/**
 * Fetch with a hard deadline that holds even when the fetch implementation
 * ignores its abort signal (a container that accepts TCP but never completes
 * the HTTP response, or an injected probe fetch). The elapsed-time loops in
 * this module only check time BETWEEN probes, so one never-settling fetch
 * would otherwise hang a caller forever — post-rename in the harden
 * migration that stranded the node with the store renamed away and the
 * rollback path unreachable. Race gives the guarantee; the signal lets a
 * real fetch also release its socket.
 */
export async function fetchWithDeadline(
  fetchImpl: typeof globalThis.fetch,
  input: string,
  init: Parameters<typeof globalThis.fetch>[1],
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`store probe timed out after ${timeoutMs}ms: ${input}`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    if (timer.unref) timer.unref();
  });
  try {
    return await Promise.race([
      fetchImpl(input, { ...init, signal: controller.signal }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Per-probe fetch deadline used by every readiness/verify probe below. */
export const STORE_PROBE_TIMEOUT_MS = 15_000;

export async function waitForBlazegraphReady(opts: {
  url: string;
  fetch: typeof globalThis.fetch;
  intervalMs: number;
  timeoutMs: number;
  /** Deadline for ONE status fetch; a hung probe counts as a failed probe. */
  probeTimeoutMs?: number;
  log: (msg: string) => void;
}): Promise<void> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < opts.timeoutMs) {
    attempt++;
    try {
      // Bounded per probe: the while-condition only checks time BETWEEN
      // probes, so an unbounded fetch against a listening-but-wedged
      // container would hang this loop forever instead of timing out.
      const remaining = Math.max(1, opts.timeoutMs - (Date.now() - start));
      const r = await fetchWithDeadline(
        opts.fetch,
        `${opts.url}/bigdata/status`,
        { method: 'GET' },
        Math.min(opts.probeTimeoutMs ?? STORE_PROBE_TIMEOUT_MS, remaining),
      );
      if (r.ok) {
        opts.log(`  Blazegraph ready after ${attempt} probe(s) (~${Math.round((Date.now() - start) / 1000)}s).`);
        return;
      }
    } catch {
      // Container not listening yet (or the probe timed out) — keep polling.
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
    const port = inspectInfo.hostPort ?? opts.port ?? DEFAULT_HOST_PORT_START;
    const url = `http://127.0.0.1:${port}`;
    log(`  Reusing running container "${containerName}" on port ${port}.`);
    await waitForBlazegraphReady({ url, fetch, intervalMs: pollIntervalMs, timeoutMs: pollTimeoutMs, log });
    const created = !(await namespaceExists({ url, namespace, fetch }));
    if (created) {
      await createNamespace({ url, namespace, fetch, log });
    } else {
      log(`  Namespace "${namespace}" already exists.`);
    }
    return {
      url: sparqlUrlForNamespace(url, namespace),
      port,
      containerName,
      managedByDkg: true,
      reused: true,
      namespaceCreated: created,
    };
  }

  // 3. Stopped-but-exists path — start it back up before re-creating.
  if (inspectInfo.exists && !inspectInfo.running) {
    log(`  Container "${containerName}" exists but is stopped; starting it.`);
    const startResult = await docker.run(['start', containerName]);
    if (startResult.exitCode !== 0) {
      // Fall through to recreate — `docker start` failed for some
      // reason (e.g. config drift); remove and start fresh.
      log(`  docker start failed (${startResult.stderr.trim() || 'unknown'}); recreating.`);
      await docker.run(['rm', '-f', containerName]);
    } else {
      const port = (await inspectContainer(docker, containerName)).hostPort
        ?? opts.port
        ?? DEFAULT_HOST_PORT_START;
      const url = `http://127.0.0.1:${port}`;
      await waitForBlazegraphReady({ url, fetch, intervalMs: pollIntervalMs, timeoutMs: pollTimeoutMs, log });
      const created = !(await namespaceExists({ url, namespace, fetch }));
      if (created) {
        await createNamespace({ url, namespace, fetch, log });
      } else {
        log(`  Namespace "${namespace}" already exists.`);
      }
      return {
        url: sparqlUrlForNamespace(url, namespace),
        port,
        containerName,
        managedByDkg: true,
        reused: true,
        namespaceCreated: created,
      };
    }
  }

  // 4. Fresh create path — choose a port and run with the survivability
  //    flags (heap policy, journal volume, healthcheck, log caps). See
  //    buildBlazegraphRunArgs for the incident rationale.
  const portStart = opts.port ?? DEFAULT_HOST_PORT_START;
  const chosenPort = await findFreePort(portStart, portRange, isPortFree, log);
  const heapMb = computeBlazegraphHeapMb(
    (opts.totalMemoryBytes ?? os.totalmem)(),
    (opts.env ?? process.env).DKG_BLAZEGRAPH_HEAP_MB,
  );
  log(`  Starting Blazegraph container "${containerName}" on port ${chosenPort}…`);
  log(`  JVM heap: ${heapMb} MB (40% of host RAM, clamped 2G..8G)`);
  // Idempotent — `docker volume create` on an existing volume is a no-op.
  const volumeResult = await docker.run(['volume', 'create', blazegraphVolumeName(containerName)]);
  if (volumeResult.exitCode !== 0) {
    throw new Error(
      `Failed to create Blazegraph journal volume — docker volume create exited ${volumeResult.exitCode}. ` +
      `stderr: ${volumeResult.stderr.trim() || '(empty)'}`,
    );
  }
  const runResult = await docker.run(buildBlazegraphRunArgs({
    containerName,
    hostPort: chosenPort,
    namespace,
    heapMb,
  }));
  if (runResult.exitCode !== 0) {
    throw new Error(
      `Failed to start Blazegraph container — docker run exited ${runResult.exitCode}. ` +
      `stderr: ${runResult.stderr.trim() || '(empty)'}`,
    );
  }

  const url = `http://127.0.0.1:${chosenPort}`;
  await waitForBlazegraphReady({ url, fetch, intervalMs: pollIntervalMs, timeoutMs: pollTimeoutMs, log });
  await createNamespace({ url, namespace, fetch, log });

  return {
    url: sparqlUrlForNamespace(url, namespace),
    port: chosenPort,
    containerName,
    managedByDkg: true,
    reused: false,
    namespaceCreated: true,
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
