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

    const knownGood: string[] = [];
    const unknown: string[] = [];
    const negative: string[] = [];
    for (const peerId of protocolCandidates) {
      const outcome = this.get(input.contextGraphId, peerId, now);
      if (outcome === 'good') knownGood.push(peerId);
      else if (outcome) negative.push(peerId);
      else unknown.push(peerId);
    }

    let selectedPeers: string[];
    if (knownGood.length > 0) {
      selectedPeers = knownGood;
    } else if (unknown.length > 0) {
      selectedPeers = unknown.slice(0, Math.max(0, fallbackProbeLimit));
    } else {
      selectedPeers = negative.slice(0, Math.max(0, fallbackProbeLimit));
    }

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

export function classifySwmCatchupPeerOutcome(input: {
  insertedTriples?: number;
  fetchedDataTriples?: number;
  fetchedMetaTriples?: number;
  deniedPhases?: number;
  failedPeers?: number;
  failedPhases?: number;
  timedOutPhases?: number;
  backoffWorthyFailures?: number;
  errorMessage?: string;
}): SwmCatchupPeerOutcome {
  if ((input.insertedTriples ?? 0) > 0 || (input.fetchedDataTriples ?? 0) > 0 || (input.fetchedMetaTriples ?? 0) > 0) {
    return 'good';
  }
  if ((input.deniedPhases ?? 0) > 0 || isDeniedMessage(input.errorMessage)) {
    return 'denied';
  }
  if (
    input.errorMessage ||
    (input.failedPeers ?? 0) > 0 ||
    (input.failedPhases ?? 0) > 0 ||
    (input.timedOutPhases ?? 0) > 0 ||
    (input.backoffWorthyFailures ?? 0) > 0
  ) {
    return 'transportFailed';
  }
  return 'empty';
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
