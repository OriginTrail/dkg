import { create } from 'zustand';

// Persisted Publishing Conviction Account (PCA) state.
//
// There is no backend enumeration of "PCAs I own / am approved on" yet (P4 /
// gaps B1/B2), so the overview is driven by a LOCALLY-TRACKED set of account
// ids: seeded on Create and via "Track by ID", resolved per-id with
// `fetchPca`. This store owns that durable set so the `conviction` tab re-opens
// with the same accounts after a refresh.
//
// It also owns the CREATE-PENDING marker — the double-mint guard for S2. A
// create whose receipt times out comes back as HTTP 504 with the broadcast
// `txHash` (GROUND-TRUTH §2.1); we persist that here so a reload still knows a
// create is in flight and must reconcile-before-retry rather than minting a
// second fund-locked PCA.
//
// Mirrors `stores/layout.ts`: zustand `create` + a hand-rolled localStorage
// loader and a debounced writer (NOT the zustand persist middleware), so the
// persistence is testable the same way (`vi.resetModules()` + a fresh import).

const PCA_STORAGE_KEY = 'dkg-pca';
const PERSIST_DEBOUNCE_MS = 150;

/**
 * Marker for an in-flight Create whose confirmation was lost. Persisted so a
 * page reload can still reconcile against the chain before allowing a retry.
 */
export interface PcaCreatePending {
  /** The owner EOA the PCA was being minted to. */
  ownerEoa: string;
  /** `Date.now()` at submit, so stale markers can be surfaced/aged out. */
  submittedAt: number;
  /** The broadcast tx hash, when the daemon returned one (504 timeout body). */
  txHash?: string;
}

/**
 * Marker for an in-flight top-up whose confirmation was lost. Unlike create,
 * top-up mints no account id, so recovery is anchored to the broadcast txHash.
 */
export interface PcaTopUpPending {
  accountId: string;
  ownerEoa: string;
  submittedAt: number;
  txHash: string;
  tokens?: string;
  previousTopUpBufferTrac?: string;
}

interface PcaState {
  /** Tracked account ids (deduped, insertion-ordered). */
  trackedIds: string[];
  /** The single in-flight create marker, or null. */
  createPending: PcaCreatePending | null;
  /** In-flight top-up markers keyed by PCA account id. */
  topUpPending: Record<string, PcaTopUpPending>;
  /**
   * T3 — whether the current `createPending` marker was actually WRITTEN to
   * localStorage (false when storage is disabled/full). The reconcile screen reads
   * this to avoid falsely claiming "this guard survives a refresh".
   */
  createPendingPersisted: boolean;

  trackAccount: (id: string) => void;
  untrackAccount: (id: string) => void;
  isTracked: (id: string) => boolean;
  setCreatePending: (marker: PcaCreatePending) => void;
  clearCreatePending: () => void;
  setTopUpPending: (marker: PcaTopUpPending) => void;
  clearTopUpPending: (accountId: string) => void;
  /**
   * P1 — atomically finalize a confirmed create: clear the marker AND track the new
   * id in ONE synchronous write (persistNow). The split trackAccount+clearCreatePending
   * were both debounced, so a crash/reload in the 150ms window resurrected the stale
   * create-pending marker (→ reconcile screen) AND lost the new id, enabling a second mint.
   */
  finishCreate: (accountId: string) => void;
}

interface PersistedPca {
  trackedIds?: unknown;
  createPending?: unknown;
  topUpPending?: unknown;
}

const DEFAULTS: {
  trackedIds: string[];
  createPending: PcaCreatePending | null;
  topUpPending: Record<string, PcaTopUpPending>;
} = {
  trackedIds: [],
  createPending: null,
  topUpPending: {},
};

// Account ids are non-negative integer strings (the daemon's accountId is a
// uint). Normalise/validate so a corrupt blob can't seed junk ids that every
// `fetchPca` would then 400 on.
function isValidAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function sanitizeTrackedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of value) {
    if (isValidAccountId(v) && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function sanitizeCreatePending(value: unknown): PcaCreatePending | null {
  if (value == null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.ownerEoa !== 'string' || v.ownerEoa.length === 0) return null;
  if (typeof v.submittedAt !== 'number' || !Number.isFinite(v.submittedAt)) return null;
  return {
    ownerEoa: v.ownerEoa,
    submittedAt: v.submittedAt,
    ...(typeof v.txHash === 'string' && v.txHash.length > 0 ? { txHash: v.txHash } : {}),
  };
}

function sanitizeTopUpPending(value: unknown): Record<string, PcaTopUpPending> {
  if (value == null || typeof value !== 'object') return {};
  const out: Record<string, PcaTopUpPending> = {};
  for (const [accountId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isValidAccountId(accountId) || raw == null || typeof raw !== 'object') continue;
    const v = raw as Record<string, unknown>;
    if (v.accountId !== accountId) continue;
    if (typeof v.ownerEoa !== 'string' || v.ownerEoa.length === 0) continue;
    if (typeof v.txHash !== 'string' || v.txHash.length === 0) continue;
    if (typeof v.submittedAt !== 'number' || !Number.isFinite(v.submittedAt)) continue;
    out[accountId] = {
      accountId,
      ownerEoa: v.ownerEoa,
      txHash: v.txHash,
      submittedAt: v.submittedAt,
      ...(typeof v.tokens === 'string' ? { tokens: v.tokens } : {}),
      ...(typeof v.previousTopUpBufferTrac === 'string'
        ? { previousTopUpBufferTrac: v.previousTopUpBufferTrac }
        : {}),
    };
  }
  return out;
}

function loadPersisted(): {
  trackedIds: string[];
  createPending: PcaCreatePending | null;
  topUpPending: Record<string, PcaTopUpPending>;
} {
  try {
    const raw = localStorage.getItem(PCA_STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as PersistedPca;
    return {
      trackedIds: sanitizeTrackedIds(parsed.trackedIds),
      createPending: sanitizeCreatePending(parsed.createPending),
      topUpPending: sanitizeTopUpPending(parsed.topUpPending),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persist(state: PersistedPca): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(PCA_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // localStorage may be unavailable (private mode, quota); silently skip.
    }
  }, PERSIST_DEBOUNCE_MS);
}

/**
 * C2 — SYNCHRONOUS write for the highest-stakes marker. The debounced `persist`
 * leaves a ≤150ms window where a crash/hard-refresh after the create POST is
 * dispatched (the daemon mints regardless) but before the timer fires would lose
 * the create-pending marker → a second fund-locking mint on reopen. A lost
 * marker fails toward DANGER, so `setCreatePending` must write NOW. Cancels any
 * queued debounced write so it subsumes (no lost-update / double-write).
 */
function persistNow(state: PersistedPca): boolean {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    localStorage.setItem(PCA_STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    // T3 — localStorage may be unavailable (private mode, quota). Report the FAILURE
    // so the reconcile screen can warn the marker won't survive a refresh (vs falsely
    // claiming it's saved). NON-blocking — the in-memory guard still covers the session.
    return false;
  }
}

function snapshot(state: PcaState): PersistedPca {
  return {
    trackedIds: state.trackedIds,
    createPending: state.createPending,
    topUpPending: state.topUpPending,
  };
}

const initial = loadPersisted();

export const usePcaStore = create<PcaState>((set, get) => ({
  trackedIds: initial.trackedIds,
  createPending: initial.createPending,
  topUpPending: initial.topUpPending,
  // A loaded marker came FROM localStorage, so it's persisted by definition.
  createPendingPersisted: initial.createPending != null,

  trackAccount: (id) => {
    if (!isValidAccountId(id)) return;
    set((s) => (s.trackedIds.includes(id) ? s : { trackedIds: [...s.trackedIds, id] }));
    persist(snapshot(get()));
  },
  untrackAccount: (id) => {
    set((s) =>
      s.trackedIds.includes(id) ? { trackedIds: s.trackedIds.filter((x) => x !== id) } : s,
    );
    persist(snapshot(get()));
  },
  isTracked: (id) => get().trackedIds.includes(id),
  setCreatePending: (marker) => {
    set({ createPending: marker });
    // C2 — write synchronously: this is the double-mint guard; it must survive a
    // crash/refresh inside the debounce window before the create POST resolves.
    // T3 — record whether the write actually succeeded (false in a no-storage env).
    set({ createPendingPersisted: persistNow(snapshot(get())) });
  },
  clearCreatePending: () => {
    set({ createPending: null, createPendingPersisted: false });
    persist(snapshot(get()));
  },
  setTopUpPending: (marker) => {
    if (!isValidAccountId(marker.accountId)) return;
    set((s) => ({
      topUpPending: {
        ...s.topUpPending,
        [marker.accountId]: marker,
      },
    }));
    persistNow(snapshot(get()));
  },
  clearTopUpPending: (accountId) => {
    set((s) => {
      if (!s.topUpPending[accountId]) return s;
      const next = { ...s.topUpPending };
      delete next[accountId];
      return { topUpPending: next };
    });
    persist(snapshot(get()));
  },
  finishCreate: (id) => {
    // P1 — clear the marker AND track the id in ONE set(), then write synchronously
    // so a reload can never resurrect the stale marker or lose the new id.
    set((s) => ({
      createPending: null,
      createPendingPersisted: false,
      trackedIds:
        isValidAccountId(id) && !s.trackedIds.includes(id) ? [...s.trackedIds, id] : s.trackedIds,
    }));
    persistNow(snapshot(get()));
  },
}));
