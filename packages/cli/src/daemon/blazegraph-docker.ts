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
 * The provisioner does NOT modify `scripts/devnet.sh`. The devnet
 * loop orchestrates multiple containers across nodes 3-4 with
 * different concerns; the namespace XML body is the only shared
 * artifact and is exported as `BLAZEGRAPH_NAMESPACE_XML_TEMPLATE`.
 */
import { spawn } from 'node:child_process';
import * as net from 'node:net';

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
 * Pinned multi-architecture image tag — matches the deployed mainnet fleet.
 * `lyrasis/blazegraph:2.1.5` is amd64-only and fails with `exec format error`
 * when the provisioner runs on an arm64 Linux node.
 */
export const BLAZEGRAPH_IMAGE = 'islandora/blazegraph:6.4.3';

/** Default container port that the Blazegraph image exposes. */
const BLAZEGRAPH_CONTAINER_PORT = 8080;

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
    const portBinding = info.NetworkSettings?.Ports?.[`${BLAZEGRAPH_CONTAINER_PORT}/tcp`];
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

  // 4. Fresh create path — choose a port and run.
  const portStart = opts.port ?? DEFAULT_HOST_PORT_START;
  const chosenPort = await findFreePort(portStart, portRange, isPortFree, log);
  log(`  Starting Blazegraph container "${containerName}" on port ${chosenPort}…`);
  const runResult = await docker.run([
    'run',
    '-d',
    '--restart', 'unless-stopped',
    '--name', containerName,
    // Blazegraph is an implementation detail of the local node. Do not publish
    // its unauthenticated SPARQL/update endpoint on every host interface.
    '-p', `127.0.0.1:${chosenPort}:${BLAZEGRAPH_CONTAINER_PORT}`,
    BLAZEGRAPH_IMAGE,
  ]);
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
