import { readSharedMemoryPhaseFailureAttribution } from '../sync/shared-memory-diagnostics.js';

export type SwmCatchupPeerOutcome = 'good' | 'empty' | 'denied' | 'unsupported' | 'transportFailed';

export const SWM_CATCHUP_PEER_GOOD_TTL_MS = 10 * 60_000;
export const SWM_CATCHUP_PEER_NEGATIVE_TTL_MS = 2 * 60_000;
export const SWM_CATCHUP_FALLBACK_PROBE_LIMIT = 3;

const DEFAULT_MAX_ENTRIES = 4096;
const KEY_SEPARATOR = '\0';

interface SwmCatchupPeerEntry {
  outcome: SwmCatchupPeerOutcome;
  expiresAt: number;
  updatedAt: number;
}

export interface SwmCatchupPeerSelectorOptions {
  goodTtlMs?: number;
  negativeTtlMs?: number;
  fallbackProbeLimit?: number;
  maxEntries?: number;
}

export interface SelectSwmCatchupPeersInput {
  contextGraphId: string;
  candidatePeers: readonly string[];
  unsupportedPeers?: ReadonlySet<string>;
  privateCuratorPeerIds?: readonly string[];
  /** The graph owner's peers: asked whenever they are candidates, whatever they answered before. */
  ownerPeerIds?: readonly string[];
  now?: number;
  fallbackProbeLimit?: number;
}

export interface SelectSwmCatchupPeersResult {
  selectedPeers: string[];
  skippedUnsupportedPeers: string[];
  skippedNegativePeers: string[];
  scopedCandidatePeers: string[];
}

export class SwmCatchupPeerSelector {
  private readonly entries = new Map<string, SwmCatchupPeerEntry>();
  private readonly goodTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly fallbackProbeLimit: number;
  private readonly maxEntries: number;
  /** Turns through the peers not known yet, one per selection that has known-good peers. */
  private unknownTurn = 0;

  constructor(options: SwmCatchupPeerSelectorOptions = {}) {
    this.goodTtlMs = options.goodTtlMs ?? SWM_CATCHUP_PEER_GOOD_TTL_MS;
    this.negativeTtlMs = options.negativeTtlMs ?? SWM_CATCHUP_PEER_NEGATIVE_TTL_MS;
    this.fallbackProbeLimit = options.fallbackProbeLimit ?? SWM_CATCHUP_FALLBACK_PROBE_LIMIT;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  record(contextGraphId: string, peerId: string, outcome: SwmCatchupPeerOutcome, now = Date.now()): void {
    const ttl = outcome === 'good' ? this.goodTtlMs : this.negativeTtlMs;
    if (ttl <= 0) {
      this.entries.delete(cacheKey(contextGraphId, peerId));
      return;
    }
    this.prune(now);
    if (this.entries.size >= this.maxEntries) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]?.[0];
      if (oldest) this.entries.delete(oldest);
    }
    this.entries.set(cacheKey(contextGraphId, peerId), {
      outcome,
      expiresAt: now + ttl,
      updatedAt: now,
    });
  }

  get(contextGraphId: string, peerId: string, now = Date.now()): SwmCatchupPeerOutcome | undefined {
    const key = cacheKey(contextGraphId, peerId);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.outcome;
  }

  select(input: SelectSwmCatchupPeersInput): SelectSwmCatchupPeersResult {
    const now = input.now ?? Date.now();
    const fallbackProbeLimit = input.fallbackProbeLimit ?? this.fallbackProbeLimit;
    const unsupportedPeers = input.unsupportedPeers ?? new Set<string>();
    const scopedCandidatePeers = applyCuratorScope(
      unique(input.candidatePeers),
      input.privateCuratorPeerIds,
    );

    const protocolCandidates: string[] = [];
    const skippedUnsupportedPeers: string[] = [];
    for (const peerId of scopedCandidatePeers) {
      if (unsupportedPeers.has(peerId)) {
        skippedUnsupportedPeers.push(peerId);
        continue;
      }
      protocolCandidates.push(peerId);
    }

    // The owner holds every member's writes (#3421): it is asked whenever it
    // can be, whatever it answered before, and the rest are chosen beside it.
    const ownerIds = new Set(input.ownerPeerIds ?? []);
    const owners: string[] = [];
    let goodOwner = false;
    const knownGood: string[] = [];
    const unknown: string[] = [];
    const negative: string[] = [];
    for (const peerId of protocolCandidates) {
      const outcome = this.get(input.contextGraphId, peerId, now);
      if (ownerIds.has(peerId)) {
        owners.push(peerId);
        goodOwner ||= outcome === 'good';
      } else if (outcome === 'good') knownGood.push(peerId);
      else if (outcome) negative.push(peerId);
      else unknown.push(peerId);
    }

    let selectedPeers: string[];
    if (knownGood.length > 0 || goodOwner) {
      // A peer that served data once may have fallen behind since (#3421):
      // one peer not known yet is asked as well, another one each time.
      selectedPeers = unknown.length > 0
        ? [...knownGood, unknown[this.unknownTurn++ % unknown.length]!]
        : knownGood;
    } else if (unknown.length > 0) {
      selectedPeers = unknown.slice(0, Math.max(0, fallbackProbeLimit));
    } else {
      selectedPeers = negative.slice(0, Math.max(0, fallbackProbeLimit));
    }
    selectedPeers = [...owners, ...selectedPeers];

    const selected = new Set(selectedPeers);
    return {
      selectedPeers,
      skippedUnsupportedPeers,
      skippedNegativePeers: negative.filter((peerId) => !selected.has(peerId)),
      scopedCandidatePeers,
    };
  }

  prune(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export function createSwmCatchupPeerSelector(options?: SwmCatchupPeerSelectorOptions): SwmCatchupPeerSelector {
  return new SwmCatchupPeerSelector(options);
}

/** What {@link swmCatchupOwnerPeerIds} reads of the agent. */
export interface SwmCatchupOwnerLookup {
  resolveCuratorPeerIdsForCg(
    contextGraphId: string,
    options: { maxPeerIds: number },
  ): Promise<{ readonly curatorIsLocal: boolean; readonly peerIds: readonly string[] }>;
}

/**
 * The peers of the graph's owner, which a catch-up always asks (#3421): none
 * when this node owns the graph or the owner cannot be looked up. Never throws.
 */
export async function swmCatchupOwnerPeerIds(agent: SwmCatchupOwnerLookup, contextGraphId: string): Promise<string[]> {
  try {
    const resolved = await agent.resolveCuratorPeerIdsForCg(contextGraphId, { maxPeerIds: 16 });
    return resolved.curatorIsLocal ? [] : [...resolved.peerIds];
  } catch {
    return [];
  }
}

interface SwmCatchupPeerTelemetry {
  insertedTriples?: number;
  /** New data triples stored; producers that report only the total leave it out. */
  insertedDataTriples?: number;
  fetchedDataTriples?: number;
  fetchedMetaTriples?: number;
  deniedPhases?: number;
  failedPeers?: number;
  failedPhases?: number;
  localYieldFailedPhases?: number;
  timedOutPhases?: number;
  backoffWorthyFailures?: number;
  errorMessage?: string;
}

export type SwmCatchupPeerOutcomeInput = SwmCatchupPeerTelemetry & {
  /** A local scheduler decision is not itself peer-health evidence. */
  localYield?: true;
};

export function classifySwmCatchupPeerOutcome(
  input: SwmCatchupPeerTelemetry & { localYield?: never },
): SwmCatchupPeerOutcome;
export function classifySwmCatchupPeerOutcome(
  input: SwmCatchupPeerOutcomeInput,
): SwmCatchupPeerOutcome | undefined;
export function classifySwmCatchupPeerOutcome(
  input: SwmCatchupPeerOutcomeInput,
): SwmCatchupPeerOutcome | undefined {
  if (servedData(input)) return 'good';
  if ((input.deniedPhases ?? 0) > 0 || isDeniedMessage(input.errorMessage)) {
    return 'denied';
  }
  const failedPhases = input.failedPhases ?? 0;
  if (
    input.errorMessage ||
    (input.failedPeers ?? 0) > 0 ||
    (input.timedOutPhases ?? 0) > 0 ||
    (input.backoffWorthyFailures ?? 0) > 0
  ) {
    return 'transportFailed';
  }
  const attribution = readSharedMemoryPhaseFailureAttribution(input);
  if (attribution) {
    if (attribution.transport > 0 || attribution.materialization > 0) {
      return 'transportFailed';
    }
    if (attribution.localBudget > 0 || input.localYield) return undefined;
    return 'empty';
  }
  // Compatibility edge for older producers that expose only the public
  // counters. Canonical in-process results take the typed branch above.
  const localYieldFailedPhases = input.localYield ? input.localYieldFailedPhases ?? 0 : 0;
  if (failedPhases > localYieldFailedPhases) return 'transportFailed';
  if (input.localYield) return undefined;
  return 'empty';
}

/**
 * The peer served data: it stored new data here, or sent some. Metadata
 * alone does not count (#3421): a peer that held a graph's metadata and not
 * its newest data answered every catch-up with it, was taken for a good
 * source, and was the only peer asked for ten minutes. A producer that
 * reports only a total keeps the old reading of it.
 */
function servedData(input: SwmCatchupPeerTelemetry): boolean {
  if ((input.insertedDataTriples ?? 0) > 0 || (input.fetchedDataTriples ?? 0) > 0) return true;
  return input.insertedDataTriples === undefined
    && input.fetchedDataTriples === undefined
    && input.fetchedMetaTriples === undefined
    && (input.insertedTriples ?? 0) > 0;
}

function cacheKey(contextGraphId: string, peerId: string): string {
  return `${contextGraphId}${KEY_SEPARATOR}${peerId}`;
}

function unique(peers: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const peer of peers) {
    if (!peer || seen.has(peer)) continue;
    seen.add(peer);
    out.push(peer);
  }
  return out;
}

function applyCuratorScope(candidatePeers: string[], privateCuratorPeerIds: readonly string[] | undefined): string[] {
  if (!privateCuratorPeerIds) return candidatePeers;
  const curatorPeers = new Set(privateCuratorPeerIds);
  return candidatePeers.filter((peerId) => curatorPeers.has(peerId));
}

function isDeniedMessage(message: string | undefined): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes('denied') || lower.includes('unauthorized') || lower.includes('not authorized');
}
