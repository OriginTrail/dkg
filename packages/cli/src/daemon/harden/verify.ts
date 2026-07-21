/**
 * Harden migration — post-swap verification probes.
 *
 * Raw-fetch SPARQL probes against the hardened container's namespace
 * endpoint; used by the executor's verify phase (and its
 * already-hardened fast path). See the facade (../blazegraph-harden.ts)
 * for the incident background.
 */
import {
  STORE_META_GRAPH,
  STORE_META_PREDICATE,
  STORE_META_SUBJECT,
} from '../store-health-check.js';
import { fetchWithDeadline, STORE_PROBE_TIMEOUT_MS } from '../blazegraph-docker.js';

/**
 * Bounded ASK {} against the namespace SPARQL endpoint; true on HTTP 200.
 * Every probe here carries its own fetch deadline: these run in the
 * executor's POST-RENAME verify phase, where a never-settling response
 * (container listens but never answers) must become an ordinary
 * verification failure — and therefore a rollback — instead of an
 * unbounded await that strands the node with the store renamed away.
 */
export async function askOk(
  fetchImpl: typeof globalThis.fetch,
  sparqlUrl: string,
  timeoutMs: number = STORE_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const res = await fetchWithDeadline(fetchImpl, sparqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/sparql-results+json',
      },
      body: `query=${encodeURIComponent('ASK {}')}`,
    }, timeoutMs);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Cheap named-graph presence probe: every daemon-booted namespace carries
 * the store identity tag (store-health-check.ts `checkOrSetStoreIdentity`),
 * so a binding here proves the DATA followed the migration, not just that
 * an empty namespace answers ASK. Vocabulary imported from
 * store-health-check.ts — the writer of the tag — so the probe can never
 * drift from what the daemon actually writes.
 */
export async function identityTagPresent(
  fetchImpl: typeof globalThis.fetch,
  sparqlUrl: string,
  timeoutMs: number = STORE_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const query =
    `SELECT ?name WHERE { GRAPH <${STORE_META_GRAPH}> { ` +
    `<${STORE_META_SUBJECT}> <${STORE_META_PREDICATE}> ?name } }`;
  try {
    const res = await fetchWithDeadline(fetchImpl, sparqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/sparql-results+json',
      },
      body: `query=${encodeURIComponent(query)}`,
    }, timeoutMs);
    if (!res.ok) return false;
    // The BODY read gets its own deadline: headers can arrive from a wedged
    // container whose response stream then never completes, and the fetch
    // deadline no longer covers it once the response has resolved.
    const body = await Promise.race([
      res.json().catch(() => null),
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        if (timer.unref) timer.unref();
      }),
    ]) as { results?: { bindings?: unknown[] } } | null;
    return (body?.results?.bindings?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
