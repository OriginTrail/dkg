/** Shared JVM, container and probe policy for provisioning and manual migration. */
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
    if (Number.isSafeInteger(override) && override > 0) return override;
  }
  if (!Number.isFinite(totalMemBytes) || totalMemBytes <= 0) return 2048;
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
export function blazegraphHealthCmd(namespace: string, containerPort: number): string {
  return `curl -sf -m 8 'http://127.0.0.1:${containerPort}/bigdata/namespace/${encodeURIComponent(namespace)}/sparql?query=ASK%7B%7D'`;
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
export function buildBlazegraphPolicyRunArgs(opts: {
  containerName: string;
  hostPort: number;
  namespace: string;
  heapMb: number;
  image: string;
  containerPort: number;
  dataPath: string;
  logMaxSize: string;
  logMaxFile: string;
  volumeName?: string;
}): string[] {
  return [
    'run',
    '-d',
    '--restart', 'unless-stopped',
    '--name', opts.containerName,
    // Blazegraph is an implementation detail of the local node. Do not publish
    // its unauthenticated SPARQL/update endpoint on every host interface.
    '-p', `127.0.0.1:${opts.hostPort}:${opts.containerPort}`,
    '-e', `TOMCAT_JAVA_OPTS=-Xmx${opts.heapMb}m -XX:+ExitOnOutOfMemoryError`,
    '--mount', `type=volume,source=${opts.volumeName ?? blazegraphVolumeName(opts.containerName)},target=${opts.dataPath}`,
    '--log-driver', 'local',
    '--log-opt', `max-size=${opts.logMaxSize}`,
    '--log-opt', `max-file=${opts.logMaxFile}`,
    '--health-cmd', blazegraphHealthCmd(opts.namespace, opts.containerPort),
    '--health-interval', '30s',
    '--health-timeout', '10s',
    '--health-retries', '3',
    // Fresh provisions create the namespace only after the container is up,
    // so give the health probe a generous start period before it counts.
    '--health-start-period', '120s',
    opts.image,
  ];
}

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

export function sanitiseContainerName(namespace: string): string {
  const slug = namespace.normalize('NFKD').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `dkg-blazegraph-${slug || 'node'}`;
}

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
