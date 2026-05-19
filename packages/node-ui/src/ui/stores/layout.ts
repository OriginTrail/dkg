import { create } from 'zustand';

interface LayoutState {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  bottomCollapsed: boolean;
  theme: 'dark' | 'light';
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;

  toggleLeft: () => void;
  toggleRight: () => void;
  toggleBottom: () => void;
  setTheme: (t: 'dark' | 'light') => void;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
  setBottomHeight: (h: number) => void;
}

const LAYOUT_STORAGE_KEY = 'dkg-layout';

interface PersistedLayout {
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
  bottomCollapsed?: boolean;
  leftWidth?: number;
  rightWidth?: number;
  bottomHeight?: number;
}

const DEFAULTS = {
  leftCollapsed: false,
  rightCollapsed: false,
  bottomCollapsed: true,
  leftWidth: 240,
  rightWidth: 360,
  bottomHeight: 200,
};

// Must match the live drag handlers in App.tsx (`useDragResize`); without
// clamping on load, a stale or manually edited `dkg-layout` entry like
// `{"leftWidth":2000}` would reload into an unusable shell that can't be
// recovered without clearing storage.
const LEFT_WIDTH_MIN = 140;
const LEFT_WIDTH_MAX = 400;
const RIGHT_WIDTH_MIN = 200;
const RIGHT_WIDTH_MAX = 500;
const BOTTOM_HEIGHT_MIN = 120;
const BOTTOM_HEIGHT_MAX = 600;
// Minimum vertical space the center pane must keep. The static 600 cap
// is storage sanity only; the *effective* max is also clamped to the
// viewport so a height persisted on a tall screen can't squeeze the
// center pane out of view after reload on a shorter one (Codex / ui-lead).
const CENTER_MIN_HEIGHT = 240;
// The bottom panel lives inside `.v10-app-body`, which sits *below* the
// fixed-height header — so the space available to it is the viewport
// minus the shell chrome, not the full `innerHeight`. Must stay in sync
// with `--header-h` in styles.css; without subtracting it the panel
// could grow ~44px too tall and squeeze the center pane below
// CENTER_MIN_HEIGHT (Codex).
const SHELL_CHROME_HEIGHT = 44;
export function maxBottomHeight(): number {
  const vh = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : Infinity;
  const avail = vh === Infinity ? Infinity : vh - SHELL_CHROME_HEIGHT;
  return Math.max(BOTTOM_HEIGHT_MIN, Math.min(BOTTOM_HEIGHT_MAX, avail - CENTER_MIN_HEIGHT));
}
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
function clampWidth(parsed: unknown, fallback: number, min: number, max: number): number {
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return clamp(parsed, min, max);
}

function loadPersisted(): Required<PersistedLayout> {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as PersistedLayout;
    return {
      leftCollapsed: typeof parsed.leftCollapsed === 'boolean' ? parsed.leftCollapsed : DEFAULTS.leftCollapsed,
      rightCollapsed: typeof parsed.rightCollapsed === 'boolean' ? parsed.rightCollapsed : DEFAULTS.rightCollapsed,
      bottomCollapsed: typeof parsed.bottomCollapsed === 'boolean' ? parsed.bottomCollapsed : DEFAULTS.bottomCollapsed,
      leftWidth: clampWidth(parsed.leftWidth, DEFAULTS.leftWidth, LEFT_WIDTH_MIN, LEFT_WIDTH_MAX),
      rightWidth: clampWidth(parsed.rightWidth, DEFAULTS.rightWidth, RIGHT_WIDTH_MIN, RIGHT_WIDTH_MAX),
      bottomHeight: clampWidth(parsed.bottomHeight, DEFAULTS.bottomHeight, BOTTOM_HEIGHT_MIN, BOTTOM_HEIGHT_MAX),
    };
  } catch {
    return DEFAULTS;
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function persist(state: PersistedLayout): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // localStorage may be unavailable (private mode, quota); silently skip
    }
  }, 150);
}

const initial = loadPersisted();

export const useLayoutStore = create<LayoutState>((set, get) => ({
  leftCollapsed: initial.leftCollapsed,
  rightCollapsed: initial.rightCollapsed,
  bottomCollapsed: initial.bottomCollapsed,
  theme: (localStorage.getItem('dkg-theme') as 'dark' | 'light') || 'dark',
  leftWidth: initial.leftWidth,
  rightWidth: initial.rightWidth,
  bottomHeight: initial.bottomHeight,

  toggleLeft: () => {
    set((s) => ({ leftCollapsed: !s.leftCollapsed }));
    const { leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth, bottomHeight } = get();
    persist({ leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth, bottomHeight });
  },
  toggleRight: () => {
    set((s) => ({ rightCollapsed: !s.rightCollapsed }));
    const { leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth, bottomHeight } = get();
    persist({ leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth, bottomHeight });
  },
  toggleBottom: () => {
    set((s) => ({ bottomCollapsed: !s.bottomCollapsed }));
    const { leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth, bottomHeight } = get();
    persist({ leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth, bottomHeight });
  },
  setTheme: (t) => {
    localStorage.setItem('dkg-theme', t);
    set({ theme: t });
  },
  setLeftWidth: (w) => {
    // Clamp at the setter boundary so the store itself enforces the layout
    // contract — any caller (not just the drag handler in App.tsx) pushes
    // values within the supported bounds, and persisted state stays
    // consistent with what loadPersisted accepts on reload.
    set({ leftWidth: clamp(w, LEFT_WIDTH_MIN, LEFT_WIDTH_MAX) });
    const { leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth, bottomHeight } = get();
    persist({ leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth, bottomHeight });
  },
  setRightWidth: (w) => {
    set({ rightWidth: clamp(w, RIGHT_WIDTH_MIN, RIGHT_WIDTH_MAX) });
    const { leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth, bottomHeight } = get();
    persist({ leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth, bottomHeight });
  },
  setBottomHeight: (h) => {
    set({ bottomHeight: clamp(h, BOTTOM_HEIGHT_MIN, BOTTOM_HEIGHT_MAX) });
    const { leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth, bottomHeight } = get();
    persist({ leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth, bottomHeight });
  },
}));
