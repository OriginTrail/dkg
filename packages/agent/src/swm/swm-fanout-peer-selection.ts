import type { CGMemberEnumeration } from './enumerate-cg-members.js';
import type { FanOutPeerRecord } from './substrate-fanout.js';

export type SwmFanoutPeerOutcome = 'good' | 'nonTerminal' | 'failed' | 'unsupported';

export const SWM_FANOUT_PEER_GOOD_TTL_MS = 10 * 60_000;
export const SWM_FANOUT_PEER_NEGATIVE_TTL_MS = 2 * 60_000;
export const SWM_FANOUT_UNKNOWN_PROBE_LIMIT = 3;

const DEFAULT_MAX_ENTRIES = 4096;
const KEY_SEPARATOR = '\0';

interface SwmFanoutPeerEntry {
  outcome: SwmFanoutPeerOutcome;
  expiresAt: number;
  updatedAt: number;
}

export interface SwmFanoutPeerSelectorOptions {
  goodTtlMs?: number;
  negativeTtlMs?: number;
  unknownProbeLimit?: number;
  maxEntries?: number;
}

export interface SelectSwmFanoutPeersInput {
  contextGraphId: string;
  candidatePeers: readonly string[];
  enumerationSource: CGMemberEnumeration['source'];
  now?: number;
  unknownProbeLimit?: number;
}

export interface SelectSwmFanoutPeersResult {
  selectedPeers: string[];
  knownGoodPeers: string[];
  unknownProbedPeers: string[];
  skippedRecentPeers: string[];
  candidatePeers: string[];
}

export class SwmFanoutPeerSelector {
  private readonly entries = new Map<string, SwmFanoutPeerEntry>();
  private readonly goodTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly unknownProbeLimit: number;
  private readonly maxEntries: number;

  constructor(options: SwmFanoutPeerSelectorOptions = {}) {
    this.goodTtlMs = options.goodTtlMs ?? SWM_FANOUT_PEER_GOOD_TTL_MS;
    this.negativeTtlMs = options.negativeTtlMs ?? SWM_FANOUT_PEER_NEGATIVE_TTL_MS;
    this.unknownProbeLimit = options.unknownProbeLimit ?? SWM_FANOUT_UNKNOWN_PROBE_LIMIT;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  record(contextGraphId: string, peerId: string, outcome: SwmFanoutPeerOutcome, now = Date.now()): void {
    const ttl = outcome === 'good' ? this.goodTtlMs : this.negativeTtlMs;
    const key = cacheKey(contextGraphId, peerId);
    if (ttl <= 0) {
      this.entries.delete(key);
      return;
    }
    this.prune(now);
    if (this.entries.size >= this.maxEntries) {
      const oldest = [...this.entries.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0]?.[0];
      if (oldest) this.entries.delete(oldest);
    }
    this.entries.set(key, {
      outcome,
      expiresAt: now + ttl,
      updatedAt: now,
    });
  }

  get(contextGraphId: string, peerId: string, now = Date.now()): SwmFanoutPeerOutcome | undefined {
    const key = cacheKey(contextGraphId, peerId);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.outcome;
  }

  select(input: SelectSwmFanoutPeersInput): SelectSwmFanoutPeersResult {
    const candidatePeers = unique(input.candidatePeers);
    if (input.enumerationSource !== 'topic-subscribers') {
      return {
        selectedPeers: candidatePeers,
        knownGoodPeers: [],
        unknownProbedPeers: [],
        skippedRecentPeers: [],
        candidatePeers,
      };
    }

    const now = input.now ?? Date.now();
    const unknownProbeLimit = Math.max(0, input.unknownProbeLimit ?? this.unknownProbeLimit);
    const knownGoodPeers: string[] = [];
    const unknownPeers: string[] = [];
    const skippedRecentPeers: string[] = [];

    for (const peerId of candidatePeers) {
      const outcome = this.get(input.contextGraphId, peerId, now);
      if (outcome === 'good') {
        knownGoodPeers.push(peerId);
      } else if (outcome) {
        skippedRecentPeers.push(peerId);
      } else {
        unknownPeers.push(peerId);
      }
    }

    const unknownProbedPeers = unknownPeers.slice(0, unknownProbeLimit);
    return {
      selectedPeers: [...knownGoodPeers, ...unknownProbedPeers],
      knownGoodPeers,
      unknownProbedPeers,
      skippedRecentPeers,
      candidatePeers,
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

export function createSwmFanoutPeerSelector(options?: SwmFanoutPeerSelectorOptions): SwmFanoutPeerSelector {
  return new SwmFanoutPeerSelector(options);
}

export function classifySwmFanoutPeerOutcome(record: Pick<FanOutPeerRecord, 'outcome' | 'error'>): SwmFanoutPeerOutcome {
  switch (record.outcome) {
    case 'delivered':
      return 'good';
    case 'retryable':
    case 'queued':
    case 'inFlight':
      return 'nonTerminal';
    case 'rejected':
    case 'failed':
      return isUnsupportedMessage(record.error) ? 'unsupported' : 'failed';
  }
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

function isUnsupportedMessage(message: string | undefined): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes('unsupported')
    || lower.includes('protocol negotiation')
    || lower.includes('protocol not supported')
    || lower.includes('no protocol')
    || lower.includes('not support protocol');
}
