import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  contextGraphDataGraphUri,
  sparqlString,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { GraphManager, type TripleStore } from '@origintrail-official/dkg-storage';

const NEGATIVE_CACHE_TTL_MS = 60_000;
const POSITIVE_CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 256;

type ResolutionCacheEntry =
  | {
      readonly kind: 'resolved';
      readonly localContextGraphId: string;
      readonly requiresSubscription: boolean;
      readonly expiresAt: number;
    }
  | {
      readonly kind: 'miss';
      readonly expiresAt: number;
    };

interface ResolutionCacheLookup {
  readonly hit: boolean;
  readonly localContextGraphId?: string;
}

class RandomSamplingContextGraphResolutionCache {
  private readonly entries = new Map<string, ResolutionCacheEntry>();

  get(
    key: string,
    isSubscribed: (localContextGraphId: string) => boolean,
    now = Date.now(),
  ): ResolutionCacheLookup {
    const entry = this.entries.get(key);
    if (!entry) return { hit: false };
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return { hit: false };
    }
    if (
      entry.kind === 'resolved'
      && entry.requiresSubscription
      && !isSubscribed(entry.localContextGraphId)
    ) {
      this.entries.delete(key);
      return { hit: false };
    }
    // Access-order the bounded cache without encoding positive/negative states
    // through optional fields.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.kind === 'resolved'
      ? { hit: true, localContextGraphId: entry.localContextGraphId }
      : { hit: true };
  }

  rememberMiss(key: string, now = Date.now()): void {
    this.set(key, { kind: 'miss', expiresAt: now + NEGATIVE_CACHE_TTL_MS });
  }

  rememberResolution(
    key: string,
    localContextGraphId: string,
    requiresSubscription: boolean,
    now = Date.now(),
  ): void {
    this.set(key, {
      kind: 'resolved',
      localContextGraphId,
      requiresSubscription,
      // Liveness is mutable even though the name commitment is not. Re-prove
      // the active slot periodically instead of caching that attestation forever.
      expiresAt: now + POSITIVE_CACHE_TTL_MS,
    });
  }

  private set(key: string, entry: ResolutionCacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

const resolutionCaches = new WeakMap<object, RandomSamplingContextGraphResolutionCache>();

function cacheFor(owner: object): RandomSamplingContextGraphResolutionCache {
  let cache = resolutionCaches.get(owner);
  if (!cache) {
    cache = new RandomSamplingContextGraphResolutionCache();
    resolutionCaches.set(owner, cache);
  }
  return cache;
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(String(signal.reason ?? 'Random Sampling context-graph resolution aborted'));
  error.name = 'AbortError';
  return error;
}

function raceAgainstAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

export interface RandomSamplingContextGraphResolverDependencies {
  readonly cacheOwner: object;
  readonly store: TripleStore;
  readonly chain: ChainAdapter;
  readonly configuredContextGraphIds: readonly string[];
  resolveDirect(onChainContextGraphId: bigint): string | null | undefined;
  subscribedContextGraphIds(): Iterable<string>;
  isSubscribed(localContextGraphId: string): boolean;
  contextGraphNameCommitment(localContextGraphId: string): string;
  isWireIdKeyedSubscription(localContextGraphId: string): boolean;
}

/**
 * Chain-attested cold reverse binding used only by proof-time exact repair.
 * The resolver owns its bounded cache and compatibility discovery; the agent
 * mixins expose only one typed delegation point.
 */
export async function resolveRandomSamplingLocalContextGraphBinding(
  deps: RandomSamplingContextGraphResolverDependencies,
  onChainContextGraphId: bigint,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const direct = deps.resolveDirect(onChainContextGraphId);
  if (direct) return direct;

  const cacheKey = onChainContextGraphId.toString();
  const cache = cacheFor(deps.cacheOwner);
  const cached = cache.get(cacheKey, deps.isSubscribed);
  if (cached.hit) return cached.localContextGraphId;

  const rememberMiss = (): undefined => {
    cache.rememberMiss(cacheKey);
    return undefined;
  };
  const getNameHash = deps.chain.getContextGraphNameHash;
  const getAccessPolicy = deps.chain.getContextGraphAccessPolicy;
  const isActive = deps.chain.isContextGraphActiveOnChain;
  if (
    typeof getNameHash !== 'function'
    || typeof getAccessPolicy !== 'function'
    || typeof isActive !== 'function'
  ) return rememberMiss();

  const committedNameHash = await raceAgainstAbort(
    getNameHash.call(
      deps.chain,
      onChainContextGraphId,
      signal ? { signal } : undefined,
    ),
    signal,
  );
  if (!committedNameHash || !/^0x[0-9a-fA-F]{64}$/.test(committedNameHash)) {
    return rememberMiss();
  }
  const normalizedCommitment = committedNameHash.toLowerCase();
  const matchesCommitment = (localContextGraphId: string): boolean => {
    try {
      if (
        deps.contextGraphNameCommitment(localContextGraphId).toLowerCase()
        === normalizedCommitment
      ) return true;
    } catch {
      return false;
    }
    // A host-only core may know only the wire hash. Accept that verbatim form
    // solely when local subscription metadata affirmatively proves the record
    // is hash-keyed; a generic persisted onChainHash is not identity evidence.
    return deps.isWireIdKeyedSubscription(localContextGraphId)
      && localContextGraphId.toLowerCase() === normalizedCommitment;
  };

  const candidates = new Set<string>([
    ...deps.subscribedContextGraphIds(),
    ...deps.configuredContextGraphIds,
  ]);
  const ontologyGraph = contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY);
  const onChainIdPredicate = `${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}OnChainId`;
  try {
    const durableBindings = await raceAgainstAbort(deps.store.query(`
      SELECT DISTINCT ?ctxGraph WHERE {
        GRAPH <${ontologyGraph}> {
          ?ctxGraph <${onChainIdPredicate}> ?onChainId .
          FILTER(STR(?onChainId) = ${sparqlString(cacheKey)})
        }
      }
      LIMIT 2
    `, {
      signal,
      source: 'agent.randomSampling.resolveLocalContextGraphId.durableBinding',
    }), signal);
    if (durableBindings.type === 'bindings') {
      const prefix = 'did:dkg:context-graph:';
      for (const row of durableBindings.bindings) {
        const raw = row['ctxGraph'];
        const uri = typeof raw === 'string' ? raw.replace(/^<|>$/g, '') : '';
        if (uri.startsWith(prefix) && uri.length > prefix.length) {
          candidates.add(uri.slice(prefix.length));
        }
      }
    }
  } catch {
    if (signal?.aborted) throw abortReason(signal);
    // Older local stores may not carry the durable binding. Continue into the
    // compatibility graph-catalog fallback below.
  }

  let matching = [...candidates].filter(matchesCommitment);
  if (matching.length === 0) {
    let storedContextGraphIds: string[];
    try {
      storedContextGraphIds = await raceAgainstAbort(
        new GraphManager(deps.store).listContextGraphs({
          signal,
          source: 'agent.randomSampling.resolveLocalContextGraphId',
        }),
        signal,
      );
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      return rememberMiss();
    }
    for (const localContextGraphId of storedContextGraphIds) {
      candidates.add(localContextGraphId);
    }
    matching = [...candidates].filter(matchesCommitment);
  }
  if (matching.length !== 1) return rememberMiss();

  const localContextGraphId = matching[0]!;
  const [active, accessPolicy] = await raceAgainstAbort(Promise.all([
    isActive.call(
      deps.chain,
      onChainContextGraphId,
      signal ? { signal } : undefined,
    ),
    getAccessPolicy.call(
      deps.chain,
      onChainContextGraphId,
      signal ? { signal } : undefined,
    ),
  ]), signal);
  if (!active || (accessPolicy !== 0 && accessPolicy !== 1)) return rememberMiss();
  if (accessPolicy === 1 && !deps.isSubscribed(localContextGraphId)) {
    return rememberMiss();
  }

  cache.rememberResolution(cacheKey, localContextGraphId, accessPolicy === 1);
  return localContextGraphId;
}
