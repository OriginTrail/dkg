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
import { isExternalBackend, getSparqlEndpoint } from '@origintrail-official/dkg-storage';

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

const STORE_META_GRAPH = 'urn:dkg:store-meta';
const STORE_META_SUBJECT = 'urn:dkg:store-tag';
const STORE_META_PREDICATE = 'urn:dkg:storeTaggedFor';

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
