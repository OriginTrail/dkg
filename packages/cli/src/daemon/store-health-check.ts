/**
 * Boot-time reachability probe for external SPARQL endpoints.
 *
 * # Why this exists
 *
 * When an operator points the daemon at an external triple-store backend
 * (`store.backend === 'blazegraph'` or `'sparql-http'`), the daemon's
 * useful surface — publish, query, agent identity loading, finalisation —
 * all depend on that endpoint being reachable. Without an early probe, a
 * misconfigured URL or unreachable server fails much later, deep inside
 * the agent's first SPARQL call, with a stack trace that doesn't include
 * the URL. Operators see "EHOSTUNREACH" in their logs and have to read
 * the daemon source to figure out what was being contacted.
 *
 * This probe runs synchronously before the agent boots, fails fast with
 * an actionable message that names the endpoint, and exits the daemon
 * cleanly. The boot-time exit policy lives in the caller (lifecycle), not
 * here — this module just answers "is the endpoint reachable, and if not
 * why?".
 *
 * # Design
 *
 * - For local backends: returns `{ ok: true }` without I/O. Always safe
 *   to call regardless of store configuration; centralising the
 *   backend-class branch here lets callers be unconditional.
 * - For external backends: constructs a transient `BlazegraphStore` /
 *   `SparqlHttpStore` directly via the adapter factory, issues
 *   `ASK { ?s ?p ?o }` with an `AbortController` timeout, returns
 *   ok/error. The transient store is closed immediately — we don't keep
 *   it around as the agent will create its own.
 * - Error wrapping: HTTP 404 commonly indicates the namespace doesn't
 *   exist (Blazegraph), not that the server is down. We surface that
 *   case explicitly because the recovery is different (create namespace
 *   vs check network), and the operator otherwise has to know
 *   Blazegraph protocol details to diagnose it.
 *
 * # Plan reference
 *
 * `.cursor/plans/blazegraph_v10_support_178da670.plan.md` §PR 1 item 4.
 * Sequencing in lifecycle: marker comparison → this probe (if external) →
 * `chainResetWipe` → agent boot. Health check fires before wipe so we
 * don't strand the operator with a partial state after the local file
 * wipe but a SPARQL wipe that can't run.
 */
import { existsSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isExternalBackend, getSparqlEndpoint } from '@origintrail-official/dkg-storage';
import { defaultDockerRunner, type DockerRunner } from './blazegraph-docker.js';

export interface StoreHealthCheckOptions {
  storeConfig:
    | {
        backend: string;
        options?: Record<string, unknown>;
      }
    | undefined;
  /** Probe timeout in milliseconds. Defaults to 5_000. */
  timeoutMs?: number;
  /**
   * Override for the SPARQL HTTP transport. Tests inject a mock to
   * exercise reachable / unreachable / 404-namespace-missing branches;
   * defaults to `globalThis.fetch`.
   */
  fetch?: typeof globalThis.fetch;
}

export interface StoreHealthCheckResult {
  ok: boolean;
  /** Always populated for external backends, regardless of ok. */
  endpoint?: string;
  /** Backend name passed through for log-formatting convenience. */
  backend?: string;
  /** Human-readable failure reason. Undefined on success. */
  error?: string;
  /**
   * True when the probe surfaced an HTTP 404, which typically indicates
   * the namespace doesn't exist on the SPARQL server (Blazegraph) rather
   * than the server being down. Callers use this to bias the error
   * message towards "create the namespace" rather than "fix the
   * network".
   */
  namespaceMissing?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export async function checkExternalStoreReachable(
  opts: StoreHealthCheckOptions,
): Promise<StoreHealthCheckResult> {
  if (!isExternalBackend(opts.storeConfig?.backend)) {
    return { ok: true };
  }

  let endpoint: ReturnType<typeof getSparqlEndpoint>;
  try {
    endpoint = getSparqlEndpoint({
      backend: opts.storeConfig!.backend,
      options: opts.storeConfig!.options,
    });
  } catch (err) {
    return {
      ok: false,
      backend: opts.storeConfig?.backend,
      error: (err as Error).message,
    };
  }

  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(endpoint.queryUrl, {
      method: 'POST',
      headers: {
        ...endpoint.headers,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/sparql-results+json',
      },
      body: `query=${encodeURIComponent('ASK { ?s ?p ?o }')}`,
      signal: controller.signal,
    });

    if (res.ok) {
      // We don't parse the body — a 200 with any body shape proves the
      // endpoint speaks SPARQL Protocol well enough to answer.
      return {
        ok: true,
        backend: opts.storeConfig!.backend,
        endpoint: endpoint.queryUrl,
      };
    }

    // 404 deserves a specific message because the fix is different from
    // a network failure. Blazegraph returns 404 when the namespace path
    // doesn't exist (e.g. operator wrote `…/namespace/mynode/sparql`
    // before running `dkg init`'s Docker provisioner that creates the
    // `mynode` namespace).
    if (res.status === 404) {
      return {
        ok: false,
        backend: opts.storeConfig!.backend,
        endpoint: endpoint.queryUrl,
        namespaceMissing: true,
        error:
          `endpoint returned 404 — namespace likely doesn't exist. ` +
          `Create it via the Blazegraph UI / API or use the Docker convenience path (dkg init).`,
      };
    }

    const text = await res.text().catch(() => '');
    return {
      ok: false,
      backend: opts.storeConfig!.backend,
      endpoint: endpoint.queryUrl,
      error: `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`,
    };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    const isAbort = (err as Error).name === 'AbortError' || /aborted/i.test(message);
    return {
      ok: false,
      backend: opts.storeConfig!.backend,
      endpoint: endpoint.queryUrl,
      error: isAbort
        ? `timed out after ${timeoutMs}ms`
        : `transport error: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ====================================================================
// Namespace identity tagging (RFC 120, plan PR 3 item 3)
// ====================================================================
//
// Why this exists
// ---------------
// Two daemons pointed at the same Blazegraph namespace would silently
// stomp on each other's data — the named-graph prefix scoping in
// chain-reset-wipe protects against V6/V8 collisions but doesn't help
// when two DKG nodes share a namespace. RFC 120 review point #5.
//
// The fix is a single triple inside a reserved named graph
// `<urn:dkg:store-meta>` that records the first node name that booted
// against this namespace. On every subsequent boot the daemon checks
// for it and:
//   - missing: writes it (first boot or operator's reset path).
//   - matches `config.name`: proceeds silently.
//   - mismatch: exits with an actionable message naming the other
//     node so the operator knows which daemon to relocate.
//
// Skipped entirely for local backends (no concurrent-access risk — the
// Oxigraph file is operator-owned).

// Exported: this vocabulary is the single source of truth for the store
// identity tag. `dkg store harden` (blazegraph-harden.ts) probes for the
// same triple as its data-followed-the-migration verification — it must
// never re-hardcode these IRIs.
export const STORE_META_GRAPH = 'urn:dkg:store-meta';
export const STORE_META_SUBJECT = 'urn:dkg:store-tag';
export const STORE_META_PREDICATE = 'urn:dkg:storeTaggedFor';

export interface StoreIdentityTagOptions {
  storeConfig:
    | {
        backend: string;
        options?: Record<string, unknown>;
      }
    | undefined;
  /** Operator-chosen node name from `~/.dkg/config.json`. */
  nodeName: string;
  fetch?: typeof globalThis.fetch;
  /** Probe timeout in milliseconds. Defaults to 5_000. */
  timeoutMs?: number;
}

export type StoreIdentityTagResult =
  | { ok: true; action: 'skipped'; reason: 'local-backend' | 'unknown-backend' }
  | { ok: true; action: 'matched'; nodeName: string }
  | { ok: true; action: 'tagged'; nodeName: string }
  | { ok: false; action: 'mismatch'; existingNodeName: string; expectedNodeName: string; error: string }
  | { ok: false; action: 'transport-error'; error: string };

/**
 * Read the existing identity tag (if any) and either accept it, write
 * a new one, or refuse to start on mismatch.
 *
 * Implemented with raw fetch against the SPARQL Query / Update
 * endpoints so it doesn't need the agent runtime — runs as part of
 * boot before the agent exists.
 */
export async function checkOrSetStoreIdentity(
  opts: StoreIdentityTagOptions,
): Promise<StoreIdentityTagResult> {
  if (!isExternalBackend(opts.storeConfig?.backend)) {
    return { ok: true, action: 'skipped', reason: 'local-backend' };
  }

  let endpoint: ReturnType<typeof getSparqlEndpoint>;
  try {
    endpoint = getSparqlEndpoint({
      backend: opts.storeConfig!.backend,
      options: opts.storeConfig!.options,
    });
  } catch (err) {
    return {
      ok: false,
      action: 'transport-error',
      error: (err as Error).message,
    };
  }

  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 1. SELECT the existing tag value (if any).
  const selectQuery =
    `SELECT ?name WHERE { GRAPH <${STORE_META_GRAPH}> { ` +
    `<${STORE_META_SUBJECT}> <${STORE_META_PREDICATE}> ?name } }`;
  const selectController = new AbortController();
  const selectTimer = setTimeout(() => selectController.abort(), timeoutMs);
  let existing: string | null;
  try {
    const res = await fetchImpl(endpoint.queryUrl, {
      method: 'POST',
      headers: {
        ...endpoint.headers,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/sparql-results+json',
      },
      body: `query=${encodeURIComponent(selectQuery)}`,
      signal: selectController.signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        action: 'transport-error',
        error: `identity SELECT returned HTTP ${res.status} ${res.statusText}`,
      };
    }
    const body = await res.json().catch(() => null) as
      | { results?: { bindings?: Array<{ name?: { value?: string } }> } }
      | null;
    const binding = body?.results?.bindings?.[0]?.name?.value;
    existing = typeof binding === 'string' && binding.length > 0 ? binding : null;
  } catch (err) {
    return {
      ok: false,
      action: 'transport-error',
      error: `identity SELECT failed: ${(err as Error).message}`,
    };
  } finally {
    clearTimeout(selectTimer);
  }

  // 2a. Match: nothing to do.
  if (existing != null && existing === opts.nodeName) {
    return { ok: true, action: 'matched', nodeName: existing };
  }

  // 2b. Mismatch: refuse to start.
  if (existing != null && existing !== opts.nodeName) {
    return {
      ok: false,
      action: 'mismatch',
      existingNodeName: existing,
      expectedNodeName: opts.nodeName,
      error:
        `this triple-store is already tagged for node "${existing}". ` +
        `This node is "${opts.nodeName}". Two daemons can't safely share one namespace — ` +
        `pick a different namespace, or clear the tag with: ` +
        `DELETE WHERE { GRAPH <${STORE_META_GRAPH}> { <${STORE_META_SUBJECT}> <${STORE_META_PREDICATE}> ?n } }`,
    };
  }

  // 3. Tag-missing path: INSERT the tag.
  const updateQuery =
    `INSERT DATA { GRAPH <${STORE_META_GRAPH}> { ` +
    `<${STORE_META_SUBJECT}> <${STORE_META_PREDICATE}> "${escapeSparqlLiteral(opts.nodeName)}" ` +
    `} }`;
  const updateController = new AbortController();
  const updateTimer = setTimeout(() => updateController.abort(), timeoutMs);
  try {
    const res = await fetchImpl(endpoint.updateUrl, {
      method: 'POST',
      headers: {
        ...endpoint.headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `update=${encodeURIComponent(updateQuery)}`,
      signal: updateController.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        ok: false,
        action: 'transport-error',
        error: `identity INSERT returned HTTP ${res.status}: ${detail.slice(0, 200)}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      action: 'transport-error',
      error: `identity INSERT failed: ${(err as Error).message}`,
    };
  } finally {
    clearTimeout(updateTimer);
  }

  return { ok: true, action: 'tagged', nodeName: opts.nodeName };
}

/**
 * Format an identity-tag mismatch into an operator-facing log block.
 * Multi-line, names both sides, includes the cleanup recipe.
 */
export function formatIdentityTagMismatch(result: StoreIdentityTagResult): string {
  if (result.ok || result.action !== 'mismatch') return '';
  return [
    `[STORE-IDENTITY] external triple-store is owned by a different node.`,
    `  this node:    ${result.expectedNodeName}`,
    `  store tagged: ${result.existingNodeName}`,
    ``,
    `Two daemons sharing one namespace would silently corrupt each other.`,
    `Fix one of:`,
    `  - pick a different namespace (recommended): edit \`store.options.url\` in \`~/.dkg/config.json\`.`,
    `  - reclaim this namespace if the other node is gone, by clearing the tag:`,
    `      DELETE WHERE {`,
    `        GRAPH <${STORE_META_GRAPH}> {`,
    `          <${STORE_META_SUBJECT}> <${STORE_META_PREDICATE}> ?n`,
    `        }`,
    `      }`,
  ].join('\n');
}

/** SPARQL literal escape — covers the common cases for node names. */
function escapeSparqlLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Format a failed health-check result into an operator-facing log block.
 * Multi-line, includes the URL, the error, and a remediation hint chosen
 * based on the failure mode.
 */
export function formatHealthCheckFailure(result: StoreHealthCheckResult): string {
  if (result.ok) return '';
  const lines: string[] = [
    `[STORE-HEALTH] external triple-store backend is unreachable at boot.`,
    `  backend: ${result.backend ?? '<unknown>'}`,
    `  endpoint: ${result.endpoint ?? '<unknown>'}`,
    `  error: ${result.error ?? '<unknown>'}`,
    ``,
    `Daemon cannot start without a reachable store. Fix one of:`,
  ];
  if (result.namespaceMissing) {
    lines.push(`  - create the namespace on the SPARQL server.`);
    lines.push(`  - re-run \`dkg init\` and use the Docker convenience path.`);
  } else {
    lines.push(`  - verify the endpoint URL in \`~/.dkg/config.json\` → \`store.options\`.`);
    lines.push(`  - verify the SPARQL server is running and reachable from this host.`);
    lines.push(`  - check firewall / network policy if the URL is on a different host.`);
  }
  lines.push(`  - switch back to Oxigraph by removing the \`store\` block from config.`);
  return lines.join('\n');
}

// ====================================================================
// Runtime store monitor (store.monitor.*) — 2026-07-18 mainnet wedge
// ====================================================================
//
// Why this exists
// ---------------
// The boot probe above catches a store that's dead at daemon start, but
// the 2026-07-18 incident showed the fleet's real failure mode is a
// store that dies WHILE the daemon runs: Blazegraph's JVM survives an
// OutOfMemoryError storm with its HTTP poller thread dead
// (alive-but-deaf — ASK answers nothing forever at ~0.2% CPU), so
// `--restart unless-stopped` never fires and nodes silently stop
// submitting RandomSampling proofs until a human runs `docker restart`.
//
// This monitor probes the configured endpoint on a timer and — ONLY for
// a daemon-managed Blazegraph container — issues a bounded
// `docker restart` (restart-only; never rm/recreate/volume ops) after N
// consecutive failures, with a cooldown so a genuinely sick store can't
// be restart-stormed. Operator-managed stores get loud logs and nothing
// else. All log lines carry the `store.monitor.` prefix so journald
// queries can grep one namespace.
//
// The probe deliberately reuses `checkExternalStoreReachable` (raw fetch,
// NOT agent.store) so a scheduler-saturated daemon can't mask a live
// endpoint — or vice versa.

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Harden-migration lock marker (`<DKG_HOME>/.store-harden.lock`).
 *
 * `dkg store harden` stops the legacy container and then `docker cp`s a
 * multi-GB journal out of it — minutes of wall time during which THIS
 * monitor would otherwise see 6 failed probes and `docker restart` the
 * deliberately-stopped container mid-copy, tearing the export. The
 * harden executor writes this marker before its first mutating step and
 * removes it in a `finally`; while it exists the monitor (and the boot
 * recovery below) must not issue ANY docker restart.
 *
 * The filename constant + path helper live here (not in
 * blazegraph-harden.ts) because the monitor is the reader; harden
 * imports them so writer and reader can never drift. Callers plumb the
 * config dir (`dkgDir()`) the same way `dkg store harden` resolves it.
 */
export const STORE_HARDEN_LOCK_FILENAME = '.store-harden.lock';

/** Boot-recovery restart-attempt timestamp (`<DKG_HOME>/.store-boot-restart-ts`). */
export const STORE_BOOT_RESTART_TS_FILENAME = '.store-boot-restart-ts';

export function storeHardenLockPath(dkgHome: string): string {
  return join(dkgHome, STORE_HARDEN_LOCK_FILENAME);
}

export function storeBootRestartTsPath(dkgHome: string): string {
  return join(dkgHome, STORE_BOOT_RESTART_TS_FILENAME);
}

/**
 * A harden lock older than this is treated as stale (crashed/SIGKILLed
 * harden that never reached its `finally`): the monitor logs loudly and
 * resumes normal operation rather than staying suspended forever. A real
 * migration (docker cp of a ~5.5 GB journal + verify) completes in
 * minutes; 6 hours is a generous ceiling.
 */
const HARDEN_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

/** Live = exists and not stale. Errors reading mtime count as live (fail-safe). */
function hardenLockIsLive(lockPath: string, log: (m: string) => void): boolean {
  if (!existsSync(lockPath)) return false;
  let ageMs: number | null = null;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    // Raced deletion or unreadable: treat as live for this tick — the
    // next tick re-checks and the cost of one skipped restart is nil.
    return true;
  }
  if (ageMs > HARDEN_LOCK_STALE_MS) {
    log(
      `[store.monitor] store.monitor.harden-lock-stale lock=${lockPath} ageMs=${Math.round(ageMs)} ` +
      `— a previous 'dkg store harden' apparently died without cleanup; ignoring the lock ` +
      `(remove the file to silence this)`,
    );
    return false;
  }
  return true;
}

export interface StoreMonitorStats {
  probesTotal: number;
  failuresTotal: number;
  consecutiveFailures: number;
  restartsTotal: number;
  /** docker restart attempts that failed (non-zero exit OR spawn rejection). */
  restartFailuresTotal: number;
  lastProbeOkAt: number | null;
  lastRestartAt: number | null;
  cooldownUntilMs: number | null;
  managedContainer: string | null;
}

export interface StoreRuntimeMonitorOptions {
  storeConfig:
    | {
        backend: string;
        options?: Record<string, unknown>;
      }
    | undefined;
  /**
   * Docker container to restart on sustained failure, or null when the
   * store is not daemon-managed (operator-managed stores are never
   * touched — log-only).
   */
  managedContainerName: string | null;
  /**
   * Path to the `dkg store harden` in-progress marker
   * ({@link storeHardenLockPath}). While the file exists (and is not
   * stale) the monitor suspends ALL docker restarts so it can never
   * revive a container the migration deliberately stopped mid-`docker
   * cp`. Callers (lifecycle.ts) pass `storeHardenLockPath(dkgDir())`;
   * omitting it disables the guard (tests / non-managed monitors).
   */
  hardenLockPath?: string;
  log: (msg: string) => void;
  // Injectables (tests provide these; production callers omit them):
  docker?: DockerRunner;
  fetch?: typeof globalThis.fetch;
  intervalMs?: number;
  probeTimeoutMs?: number;
  failureThreshold?: number;
  restartCooldownMs?: number;
  now?: () => number;
}

export interface StoreRuntimeMonitor {
  start(): void;
  stop(): void;
  /** One probe cycle; exposed so tests drive the state machine directly. */
  tick(): Promise<void>;
  readonly stats: StoreMonitorStats;
}

export function createStoreRuntimeMonitor(
  opts: StoreRuntimeMonitorOptions,
): StoreRuntimeMonitor {
  const log = opts.log;
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs
    ?? parsePositiveIntegerEnv('DKG_STORE_MONITOR_INTERVAL_MS', 30_000);
  const probeTimeoutMs = opts.probeTimeoutMs ?? 8_000;
  const failureThreshold = opts.failureThreshold
    ?? parsePositiveIntegerEnv('DKG_STORE_MONITOR_FAILURE_THRESHOLD', 6);
  const restartCooldownMs = opts.restartCooldownMs
    ?? parsePositiveIntegerEnv('DKG_STORE_MONITOR_RESTART_COOLDOWN_MS', 600_000);

  const stats: StoreMonitorStats = {
    probesTotal: 0,
    failuresTotal: 0,
    consecutiveFailures: 0,
    restartsTotal: 0,
    restartFailuresTotal: 0,
    lastProbeOkAt: null,
    lastRestartAt: null,
    cooldownUntilMs: null,
    managedContainer: opts.managedContainerName,
  };

  // Uncapped consecutive-failure count for the unmanaged "log at each
  // threshold multiple" cadence; `stats.consecutiveFailures` is capped at
  // the threshold so a post-cooldown restart fires on the next tick, not
  // after another full run of failures.
  let rawConsecutive = 0;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  // Lazily constructed so a log-only monitor never spawns a docker probe.
  let docker: DockerRunner | null = opts.docker ?? null;

  async function tick(): Promise<void> {
    if (inFlight) return; // a slow probe must not stack a second one
    inFlight = true;
    try {
      const result = await checkExternalStoreReachable({
        storeConfig: opts.storeConfig,
        timeoutMs: probeTimeoutMs,
        fetch: opts.fetch,
      });
      stats.probesTotal += 1;
      if (result.ok) {
        if (rawConsecutive > 0) {
          log(`[store.monitor] store recovered after ${rawConsecutive} failed probe(s)`);
        }
        rawConsecutive = 0;
        stats.consecutiveFailures = 0;
        stats.lastProbeOkAt = now();
        return;
      }

      stats.failuresTotal += 1;
      rawConsecutive += 1;
      stats.consecutiveFailures = Math.min(rawConsecutive, failureThreshold);
      log(
        `[store.monitor] probe failed (${stats.consecutiveFailures}/${failureThreshold}): ` +
        `${result.error ?? 'unknown error'}`,
      );
      if (stats.consecutiveFailures < failureThreshold) return;

      if (opts.managedContainerName == null) {
        // Operator-managed store: never touch docker; re-alert at every
        // threshold multiple rather than every tick.
        if (rawConsecutive % failureThreshold === 0) {
          log(
            `[store.monitor] ERROR store.monitor.unhealthy endpoint=${result.endpoint ?? '<unknown>'} ` +
            `— NOT daemon-managed; manual intervention required`,
          );
        }
        return;
      }

      // BLOCKER-1(a): a live `dkg store harden` run deliberately stops the
      // container and copies its multi-GB journal — a restart here would
      // tear that export. Skip ANY restart while the lock is live; no
      // cooldown and no counter reset, so the restart fires on the first
      // failing tick after the lock clears. Logged at threshold multiples
      // (every ~failureThreshold ticks), not every tick.
      if (opts.hardenLockPath && hardenLockIsLive(opts.hardenLockPath, log)) {
        if (rawConsecutive % failureThreshold === 0) {
          log(
            `[store.monitor] store.monitor.suspended-by-harden container=${opts.managedContainerName} ` +
            `lock=${opts.hardenLockPath} — 'dkg store harden' is in progress; docker restarts suspended`,
          );
        }
        return;
      }

      const cooldownUntil = stats.cooldownUntilMs ?? 0;
      if (now() < cooldownUntil) {
        log(
          `[store.monitor] store.monitor.cooldown-wait remaining=${cooldownUntil - now()}ms ` +
          `container=${opts.managedContainerName}`,
        );
        return;
      }

      // Restart-ONLY — the monitor never removes, recreates, or touches
      // volumes; recreation is exclusively `dkg store harden`.
      //
      // The runner REJECTS on spawn errors (ENOENT, EMFILE, …) — this tick
      // runs from `void tick()` on a timer, so an escaped rejection would
      // land in the daemon's unhandledRejection handler. Catch, count, log.
      docker ??= defaultDockerRunner();
      let restart: { exitCode: number; stderr: string };
      try {
        restart = await docker.run(
          ['restart', '-t', '30', opts.managedContainerName],
          { timeoutMs: 120_000 },
        );
      } catch (err) {
        restart = {
          exitCode: -1,
          stderr: `docker spawn failed: ${(err as Error).message ?? String(err)}`,
        };
      }
      if (restart.exitCode === 0) {
        stats.restartsTotal += 1;
        stats.lastRestartAt = now();
        log(
          `[store.monitor] store.monitor.restart container=${opts.managedContainerName} ` +
          `restarts=${stats.restartsTotal}`,
        );
      } else {
        stats.restartFailuresTotal += 1;
        log(
          `[store.monitor] store.monitor.restart-failed container=${opts.managedContainerName} ` +
          `exit=${restart.exitCode} stderr=${restart.stderr.trim() || '(empty)'}`,
        );
      }
      // Cooldown starts even on a failed restart attempt — hammering
      // `docker restart` against a broken engine helps nobody.
      stats.cooldownUntilMs = now() + restartCooldownMs;
      rawConsecutive = 0;
      stats.consecutiveFailures = 0;
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick,
    stats,
  };
}

/** Boot restarts are attempted at most once per this window (cross-process). */
export const BOOT_RESTART_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Boot-time one-shot recovery for a daemon-managed store that fails the
 * initial reachability probe: one bounded `docker restart`, then poll
 * until the endpoint answers or the timeout elapses. Returns whether the
 * store came back. Used exactly once before the boot path's exit(1) —
 * without this, a wedged store puts the daemon in an exit-loop (probe
 * fails → exit(1) → systemd restarts the daemon → same wedged store).
 *
 * Cross-process restart cooldown (`restartCooldownFilePath`): under
 * `Restart=always` a slow COLD-starting store (readiness > this
 * function's window) would otherwise loop daemon-exit → systemd-restart
 * → container-restart, never letting the store finish booting — each
 * daemon boot would kick the container back to second zero. The last
 * attempt's timestamp is persisted; while it is younger than
 * `restartCooldownMs` (default 30 min) the container-restart is SKIPPED
 * and we go straight to the re-probe poll (wait, then let the caller's
 * failure path exit) so the container's cold start runs undisturbed
 * across daemon restarts.
 *
 * Harden guard (`hardenLockPath`): while `dkg store harden` holds its
 * lock, no restart is issued at all (same reason as the runtime
 * monitor's suspension) — we only poll.
 */
export async function attemptManagedStoreBootRecovery(opts: {
  storeConfig:
    | {
        backend: string;
        options?: Record<string, unknown>;
      }
    | undefined;
  managedContainerName: string;
  log: (msg: string) => void;
  docker?: DockerRunner;
  fetch?: typeof globalThis.fetch;
  /** See {@link storeHardenLockPath}; omit to disable the guard. */
  hardenLockPath?: string;
  /** See {@link storeBootRestartTsPath}; omit to disable the cooldown. */
  restartCooldownFilePath?: string;
  restartCooldownMs?: number;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<boolean> {
  const docker = opts.docker ?? defaultDockerRunner();
  // >= 180s: cold start of s6 + Tomcat + a multi-GB RWStore journal takes
  // well over the old 60s (the hardened container's own health-start-period
  // is 120s). A too-small window here re-created the very exit-loop this
  // function exists to break.
  const readyTimeoutMs = opts.readyTimeoutMs ?? 180_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2_000;
  const restartCooldownMs = opts.restartCooldownMs ?? BOOT_RESTART_COOLDOWN_MS;

  let restartAllowed = true;
  if (opts.hardenLockPath && hardenLockIsLive(opts.hardenLockPath, opts.log)) {
    opts.log(
      `[store.monitor] store.monitor.suspended-by-harden container=${opts.managedContainerName} ` +
      `lock=${opts.hardenLockPath} — boot recovery will not restart the container; polling only`,
    );
    restartAllowed = false;
  } else if (opts.restartCooldownFilePath) {
    const lastAttempt = await readFile(opts.restartCooldownFilePath, 'utf-8')
      .then((raw) => Number.parseInt(raw.trim(), 10))
      .catch(() => null);
    const ageMs = lastAttempt != null && Number.isFinite(lastAttempt)
      ? Date.now() - lastAttempt
      : null;
    if (ageMs != null && ageMs >= 0 && ageMs < restartCooldownMs) {
      opts.log(
        `[store.monitor] boot-recovery restart skipped — last attempt ${Math.round(ageMs / 1000)}s ago ` +
        `(< ${Math.round(restartCooldownMs / 1000)}s cooldown). Waiting for the store to finish its own ` +
        `start instead of kicking the container again.`,
      );
      restartAllowed = false;
    }
  }

  if (restartAllowed) {
    if (opts.restartCooldownFilePath) {
      // Record the attempt BEFORE issuing it so a crash mid-restart still
      // counts against the cooldown on the next boot.
      await writeFile(opts.restartCooldownFilePath, `${Date.now()}\n`, 'utf-8').catch((err) => {
        opts.log(
          `[store.monitor] boot-recovery could not persist the restart timestamp ` +
          `(${(err as Error).message}) — continuing`,
        );
      });
    }
    let restart: { exitCode: number; stderr: string };
    try {
      restart = await docker.run(
        ['restart', '-t', '30', opts.managedContainerName],
        { timeoutMs: 120_000 },
      );
    } catch (err) {
      restart = {
        exitCode: -1,
        stderr: `docker spawn failed: ${(err as Error).message ?? String(err)}`,
      };
    }
    if (restart.exitCode !== 0) {
      opts.log(
        `[store.monitor] boot-recovery restart failed for ${opts.managedContainerName}: ` +
        `${restart.stderr.trim() || `exit ${restart.exitCode}`}`,
      );
      return false;
    }
  }

  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    const health = await checkExternalStoreReachable({
      storeConfig: opts.storeConfig,
      fetch: opts.fetch,
    });
    if (health.ok) {
      opts.log(
        restartAllowed
          ? `[store.monitor] boot-recovery succeeded — store reachable after restart`
          : `[store.monitor] boot-recovery succeeded — store came up on its own (no restart issued)`,
      );
      return true;
    }
    if (Date.now() >= deadline) {
      opts.log(
        `[store.monitor] boot-recovery failed — store still unreachable ` +
        `${readyTimeoutMs}ms after ${restartAllowed ? 'restart' : 'the skipped restart'}: ` +
        `${health.error ?? 'unknown error'}`,
      );
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
