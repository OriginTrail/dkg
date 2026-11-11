/**
 * Harden migration — post-swap verification probes.
 *
 * Raw-fetch SPARQL probes against the hardened container's namespace
 * endpoint; used by the executor's verify phase (and its
 * already-hardened fast path). See the facade (../blazegraph-harden.ts)
 * for the incident background.
 */
import { readStoreIdentityTag } from '../store-health-check.js';
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
  const result = await readStoreIdentityTag({
    endpoint: { queryUrl: sparqlUrl, headers: {} }, fetch: fetchImpl, timeoutMs,
  });
  return result.ok && result.bindingCount > 0;
}
