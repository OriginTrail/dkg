import { useSyncExternalStore } from 'react';
import { create } from 'zustand';

interface LayoutState {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  bottomCollapsed: boolean;
  bottomMaximised: boolean;
  leftSectionMarketplaceOpen: boolean;
  leftSectionMyProjectsOpen: boolean;
  leftSectionContextOracleOpen: boolean;
  leftSectionIntegrationsOpen: boolean;
  theme: 'dark' | 'light';
  leftWidth: number;
  rightWidth: number;
  bottomHeight: number;
  /** The one panel open on a narrow screen. Never saved, so desktop panels keep their state. */
  narrowPanel: 'left' | 'right' | null;

  toggleLeft: () => void;
  toggleRight: () => void;
  closeNarrowPanel: () => void;
  toggleBottom: () => void;
  toggleBottomMaximised: () => void;
  toggleLeftSectionMarketplace: () => void;
  toggleLeftSectionMyProjects: () => void;
  toggleLeftSectionContextOracle: () => void;
  toggleLeftSectionIntegrations: () => void;
  setTheme: (t: 'dark' | 'light') => void;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
  setBottomHeight: (h: number) => void;
}

const LAYOUT_STORAGE_KEY = 'dkg-layout';

/** Below this width the side panels float over the page (02-shell-header.css). */
const NARROW_QUERY = '(max-width: 860px)';

function narrowMedia(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_QUERY) : null;
}
const isNarrowViewport = () => narrowMedia()?.matches ?? false;

interface PersistedLayout {
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
  bottomCollapsed?: boolean;
  leftSectionMarketplaceOpen?: boolean;
  leftSectionMyProjectsOpen?: boolean;
  leftSectionContextOracleOpen?: boolean;
  leftSectionIntegrationsOpen?: boolean;
  leftWidth?: number;
  rightWidth?: number;
  bottomHeight?: number;
}

const BOTTOM_HEIGHT_DEFAULT = 260;

const DEFAULTS = {
  leftCollapsed: false,
  rightCollapsed: false,
  bottomCollapsed: true,
  // Sidebar sections: Marketplace and My Context Graphs are primary
  // navigation surfaces, while Public graphs and Integrations stay
  // collapsed until the user needs them.
  leftSectionMarketplaceOpen: true,
  leftSectionMyProjectsOpen: true,
  leftSectionContextOracleOpen: false,
  leftSectionIntegrationsOpen: false,
  leftWidth: 240,
  rightWidth: 360,
  bottomHeight: BOTTOM_HEIGHT_DEFAULT,
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
// Read a CSS custom property (px) at runtime so the JS clamp doesn't
// duplicate the layout numbers and silently drift if the CSS values
// change (Codex). Falls back when the document isn't available or the
// var is unset.
export function readPxVar(name: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function maxBottomHeight(): number {
  // Shell chrome (header) and the bottom-panel tab strip live in CSS
  // (`--header-h`, `--tab-h`); read them at runtime rather than copying
  // the numbers here so a CSS tweak can't silently break the clamp.
  const SHELL_CHROME_HEIGHT = readPxVar('--header-h', 44);
  const vh = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 0;
  // No window (SSR/tests): only the storage-sanity cap applies.
  if (!vh) return BOTTOM_HEIGHT_MAX;
  // Real space the panel may occupy without pushing the center pane
  // below its minimum. On short viewports this can fall below
  // BOTTOM_HEIGHT_MIN — we must NOT floor it back up to 120 (that's a
  // storage-sanity constant, enforced on load, not a viewport rule):
  // doing so would let the panel overrun the center pane. Returning
  // the true available space lets the panel shrink (toward 0 →
  // effectively collapsed) so the center keeps CENTER_MIN_HEIGHT (Codex).
  const avail = vh - SHELL_CHROME_HEIGHT - CENTER_MIN_HEIGHT;
  return Math.max(0, Math.min(BOTTOM_HEIGHT_MAX, avail));
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
      leftSectionMarketplaceOpen: typeof parsed.leftSectionMarketplaceOpen === 'boolean'
        ? parsed.leftSectionMarketplaceOpen
        : DEFAULTS.leftSectionMarketplaceOpen,
      leftSectionMyProjectsOpen: typeof parsed.leftSectionMyProjectsOpen === 'boolean'
        ? parsed.leftSectionMyProjectsOpen
        : DEFAULTS.leftSectionMyProjectsOpen,
      leftSectionContextOracleOpen: typeof parsed.leftSectionContextOracleOpen === 'boolean'
        ? parsed.leftSectionContextOracleOpen
        : DEFAULTS.leftSectionContextOracleOpen,
      leftSectionIntegrationsOpen: typeof parsed.leftSectionIntegrationsOpen === 'boolean'
        ? parsed.leftSectionIntegrationsOpen
        : DEFAULTS.leftSectionIntegrationsOpen,
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

// Pull only the persistable fields off the live state so callers don't
// have to re-list every field in every action. Theme is intentionally
// excluded — it has its own `dkg-theme` key.
function snapshot(state: LayoutState): PersistedLayout {
  return {
    leftCollapsed: state.leftCollapsed,
    rightCollapsed: state.rightCollapsed,
    bottomCollapsed: state.bottomCollapsed,
    leftSectionMarketplaceOpen: state.leftSectionMarketplaceOpen,
    leftSectionMyProjectsOpen: state.leftSectionMyProjectsOpen,
    leftSectionContextOracleOpen: state.leftSectionContextOracleOpen,
    leftSectionIntegrationsOpen: state.leftSectionIntegrationsOpen,
    leftWidth: state.leftWidth,
    rightWidth: state.rightWidth,
    bottomHeight: state.bottomHeight,
  };
}

const initial = loadPersisted();

export const useLayoutStore = create<LayoutState>((set, get) => ({
  leftCollapsed: initial.leftCollapsed,
  rightCollapsed: initial.rightCollapsed,
  bottomCollapsed: initial.bottomCollapsed,
  bottomMaximised: false,
  leftSectionMarketplaceOpen: initial.leftSectionMarketplaceOpen,
  leftSectionMyProjectsOpen: initial.leftSectionMyProjectsOpen,
  leftSectionContextOracleOpen: initial.leftSectionContextOracleOpen,
  leftSectionIntegrationsOpen: initial.leftSectionIntegrationsOpen,
  theme: (localStorage.getItem('dkg-theme') as 'dark' | 'light') || 'dark',
  leftWidth: initial.leftWidth,
  rightWidth: initial.rightWidth,
  bottomHeight: initial.bottomHeight,
  narrowPanel: null,

  toggleLeft: () => {
    if (isNarrowViewport()) {
      set((s) => ({ narrowPanel: s.narrowPanel === 'left' ? null : 'left' }));
      return;
    }
    set((s) => ({ leftCollapsed: !s.leftCollapsed }));
    persist(snapshot(get()));
  },
  toggleRight: () => {
    if (isNarrowViewport()) {
      set((s) => ({ narrowPanel: s.narrowPanel === 'right' ? null : 'right' }));
      return;
    }
    set((s) => ({ rightCollapsed: !s.rightCollapsed }));
    persist(snapshot(get()));
  },
  closeNarrowPanel: () => set({ narrowPanel: null }),
  toggleBottom: () => {
    set((s) => ({ bottomCollapsed: !s.bottomCollapsed, bottomMaximised: false }));
    persist(snapshot(get()));
  },
  toggleBottomMaximised: () => {
    set((s) => ({ bottomMaximised: !s.bottomMaximised, bottomCollapsed: false }));
    persist(snapshot(get()));
  },
  toggleLeftSectionMarketplace: () => {
    set((s) => ({ leftSectionMarketplaceOpen: !s.leftSectionMarketplaceOpen }));
    persist(snapshot(get()));
  },
  toggleLeftSectionMyProjects: () => {
    set((s) => ({ leftSectionMyProjectsOpen: !s.leftSectionMyProjectsOpen }));
    persist(snapshot(get()));
  },
  toggleLeftSectionContextOracle: () => {
    set((s) => ({ leftSectionContextOracleOpen: !s.leftSectionContextOracleOpen }));
    persist(snapshot(get()));
  },
  toggleLeftSectionIntegrations: () => {
    set((s) => ({ leftSectionIntegrationsOpen: !s.leftSectionIntegrationsOpen }));
    persist(snapshot(get()));
  },
  setTheme: (t) => {
    localStorage.setItem('dkg-theme', t);
    set({ theme: t });
  },
  setLeftWidth: (w) => {
    set({ leftWidth: clamp(w, LEFT_WIDTH_MIN, LEFT_WIDTH_MAX) });
    persist(snapshot(get()));
  },
  setRightWidth: (w) => {
    set({ rightWidth: clamp(w, RIGHT_WIDTH_MIN, RIGHT_WIDTH_MAX) });
    persist(snapshot(get()));
  },
  setBottomHeight: (h) => {
    const lo = Math.min(BOTTOM_HEIGHT_MIN, maxBottomHeight());
    set({ bottomHeight: clamp(h, lo, BOTTOM_HEIGHT_MAX) });
    persist(snapshot(get()));
  },
}));

function subscribeNarrow(listener: () => void): () => void {
  const media = narrowMedia();
  media?.addEventListener('change', listener);
  return () => media?.removeEventListener('change', listener);
}

/** Which side panels show now: narrow screens start with both closed and open one at a time. */
export function useShellPanels(): { narrow: boolean; leftOpen: boolean; rightOpen: boolean } {
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrowViewport, () => false);
  const leftCollapsed = useLayoutStore((s) => s.leftCollapsed);
  const rightCollapsed = useLayoutStore((s) => s.rightCollapsed);
  const narrowPanel = useLayoutStore((s) => s.narrowPanel);
  return narrow
    ? { narrow, leftOpen: narrowPanel === 'left', rightOpen: narrowPanel === 'right' }
    : { narrow, leftOpen: !leftCollapsed, rightOpen: !rightCollapsed };
}
