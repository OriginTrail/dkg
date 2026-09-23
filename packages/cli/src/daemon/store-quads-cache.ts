/**
 * The external-store quad count reported by GET /api/status, and its cache.
 *
 * Kept out of the status route so its module-level state has one owner: the
 * route reads and refreshes it, and the managed Oxigraph supervisor
 * invalidates it without importing the route, which imports the supervisor.
 */
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { StoreQuadsStatus, StoreQuadsStatusFields } from '../status-store-quads-wire.js';

// Quad-count cache for external SPARQL backends. A full-store COUNT is not a
// liveness check: on a multi-million-row namespace it can occupy the store for
// seconds and compete directly with sync. Normal /api/status polling therefore
// never starts it. Operators may request a background refresh explicitly with
// `?includeStoreQuads=true` (`dkg status` does when it has no recent count);
// subsequent ordinary status calls can reuse the cached value without touching
// the store. Cold/stale explicit callers get the current snapshot while one
// refresh runs in the background, so status never waits on the count.
// Every snapshot names its status, so a count nobody has requested yet
// ('not-requested') cannot be read as an unreachable store, and a cached
// result carries its age, because ordinary polling never refreshes it.
// Local backends bypass this entirely (file-bytes metric stays on the
// metrics collector tick).
// The TTL caps how often explicit requests can trigger a recount, whoever
// sends them. How old a count a caller accepts is the caller's own policy:
// `dkg status` asks for a recount once its count is ten minutes old
// (STORE_QUADS_REFRESH_AFTER_MS in commands/lifecycle.ts).
const STORE_QUADS_CACHE_TTL_MS = 30_000;

// The statuses come from the wire union, so renaming one there breaks the
// daemon's compile instead of leaving a stale spelling here.
type Ready = Extract<StoreQuadsStatus, 'ready'>;
type Unreachable = Extract<StoreQuadsStatus, 'unreachable'>;

/** A finished count, as cached. */
type StoreQuadsCacheEntry =
  | { status: Ready; value: number; fetchedAt: number }
  | { status: Unreachable; fetchedAt: number };

/** A cached result as reported; `ageMs` is null when the clock stepped back past it. */
type CachedStoreQuadsSnapshot =
  | { status: Ready; value: number; ageMs: number | null }
  | { status: Unreachable; ageMs: number | null };

type StoreQuadsSnapshot =
  | { status: Extract<StoreQuadsStatus, 'not-requested' | 'pending'> }
  | CachedStoreQuadsSnapshot;

let storeQuadsCache: StoreQuadsCacheEntry | null = null;
let storeQuadsInflight: Promise<void> | null = null;

/** Drop cached quad counts (e.g. when the managed Oxigraph child exits). */
export function invalidateExternalStoreQuadsCache(): void {
  storeQuadsCache = null;
  storeQuadsInflight = null;
}

function snapshotStoreQuadsCache(
  cache: StoreQuadsCacheEntry,
  now: number,
): CachedStoreQuadsSnapshot {
  // After a wall-clock step backwards the age is unknown: report it as such
  // rather than as 0, which would present an old count as just checked.
  const elapsedMs = now - cache.fetchedAt;
  const ageMs = elapsedMs >= 0 ? elapsedMs : null;
  return cache.status === 'ready'
    ? { status: 'ready', value: cache.value, ageMs }
    : { status: 'unreachable', ageMs };
}

export function getCachedExternalStoreQuads(
  agent: DKGAgent,
  now: number,
): StoreQuadsSnapshot {
  const cached = storeQuadsCache ? snapshotStoreQuadsCache(storeQuadsCache, now) : null;
  // An unknown age is stale, never fresh.
  if (cached && cached.ageMs !== null && cached.ageMs < STORE_QUADS_CACHE_TTL_MS) {
    return cached;
  }

  const currentSnapshot: StoreQuadsSnapshot = cached ?? { status: 'pending' };
  if (!storeQuadsInflight) {
    const refresh = (async () => {
      let result: StoreQuadsCacheEntry;
      try {
        const r = await agent.store.query(
          'SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } }',
          { priority: 'health', source: 'daemon.status.storeQuads' },
        );
        let value: number | null = null;
        if (r.type === 'bindings' && r.bindings.length > 0) {
          const cell = r.bindings[0].c ?? '';
          const digits = cell.match(/\d+/)?.[0];
          value = digits ? parseInt(digits, 10) : 0;
        }
        result = value === null
          ? { status: 'unreachable', fetchedAt: Date.now() }
          : { status: 'ready', value, fetchedAt: Date.now() };
      } catch {
        // Surface "unknown" rather than a stale value; operators can
        // distinguish unreachable from genuinely-empty via storeBackend +
        // their network logs. Cache the null briefly to avoid hammering
        // a flapping endpoint.
        result = { status: 'unreachable', fetchedAt: Date.now() };
      }
      storeQuadsCache = result;
    })();
    storeQuadsInflight = refresh;
    void refresh.finally(() => {
      if (storeQuadsInflight === refresh) storeQuadsInflight = null;
    });
  }
  return currentSnapshot;
}

// Ordinary polling: report what is already known and never start a count.
export function peekCachedExternalStoreQuads(now: number): StoreQuadsSnapshot {
  if (storeQuadsCache) return snapshotStoreQuadsCache(storeQuadsCache, now);
  return { status: storeQuadsInflight ? 'pending' : 'not-requested' };
}

/**
 * The flat `/api/status` fields for a snapshot; a local backend has none.
 * Call it as soon as the snapshot is taken: `storeQuadsRefreshing` reads the
 * in-flight count, which may settle at any later await.
 */
export function storeQuadsStatusFields(snapshot: StoreQuadsSnapshot | null): StoreQuadsStatusFields {
  if (!snapshot) return { storeQuads: null };
  return {
    storeQuads: snapshot.status === 'ready' ? snapshot.value : null,
    storeQuadsStatus: snapshot.status,
    storeQuadsAgeMs: 'ageMs' in snapshot ? snapshot.ageMs : null,
    // A count that will replace the reported result is running.
    storeQuadsRefreshing: storeQuadsInflight !== null,
  };
}
