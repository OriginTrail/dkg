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
  /** The owner EOA the PCA was being minted to (the daemon's `wallets[0]`). */
  ownerEoa: string;
  /** `Date.now()` at submit, so stale markers can be surfaced/aged out. */
  submittedAt: number;
  /** The broadcast tx hash, when the daemon returned one (504 timeout body). */
  txHash?: string;
}

interface PcaState {
  /** Tracked account ids (deduped, insertion-ordered). */
  trackedIds: string[];
  /** The single in-flight create marker, or null. */
  createPending: PcaCreatePending | null;

  trackAccount: (id: string) => void;
  untrackAccount: (id: string) => void;
  isTracked: (id: string) => boolean;
  setCreatePending: (marker: PcaCreatePending) => void;
  clearCreatePending: () => void;
}

interface PersistedPca {
  trackedIds?: unknown;
  createPending?: unknown;
}

const DEFAULTS: { trackedIds: string[]; createPending: PcaCreatePending | null } = {
  trackedIds: [],
  createPending: null,
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

function loadPersisted(): { trackedIds: string[]; createPending: PcaCreatePending | null } {
  try {
    const raw = localStorage.getItem(PCA_STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as PersistedPca;
    return {
      trackedIds: sanitizeTrackedIds(parsed.trackedIds),
      createPending: sanitizeCreatePending(parsed.createPending),
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
function persistNow(state: PersistedPca): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    localStorage.setItem(PCA_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable (private mode, quota); silently skip.
  }
}

function snapshot(state: PcaState): PersistedPca {
  return {
    trackedIds: state.trackedIds,
    createPending: state.createPending,
  };
}

const initial = loadPersisted();

export const usePcaStore = create<PcaState>((set, get) => ({
  trackedIds: initial.trackedIds,
  createPending: initial.createPending,

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
    persistNow(snapshot(get()));
  },
  clearCreatePending: () => {
    set({ createPending: null });
    persist(snapshot(get()));
  },
}));
