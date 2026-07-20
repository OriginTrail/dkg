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

/** Bounded ASK {} against the namespace SPARQL endpoint; true on HTTP 200. */
export async function askOk(
  fetchImpl: typeof globalThis.fetch,
  sparqlUrl: string,
): Promise<boolean> {
  try {
    const res = await fetchImpl(sparqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/sparql-results+json',
      },
      body: `query=${encodeURIComponent('ASK {}')}`,
    });
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
): Promise<boolean> {
  const query =
    `SELECT ?name WHERE { GRAPH <${STORE_META_GRAPH}> { ` +
    `<${STORE_META_SUBJECT}> <${STORE_META_PREDICATE}> ?name } }`;
  try {
    const res = await fetchImpl(sparqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/sparql-results+json',
      },
      body: `query=${encodeURIComponent(query)}`,
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null) as
      | { results?: { bindings?: unknown[] } }
      | null;
    return (body?.results?.bindings?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
