import { create } from 'zustand';

interface LayoutState {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  bottomCollapsed: boolean;
  theme: 'dark' | 'light';
  leftWidth: number;
  rightWidth: number;

  toggleLeft: () => void;
  toggleRight: () => void;
  toggleBottom: () => void;
  setTheme: (t: 'dark' | 'light') => void;
  setLeftWidth: (w: number) => void;
  setRightWidth: (w: number) => void;
}

const LAYOUT_STORAGE_KEY = 'dkg-layout';

interface PersistedLayout {
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
  bottomCollapsed?: boolean;
  leftWidth?: number;
  rightWidth?: number;
}

const DEFAULTS = {
  leftCollapsed: false,
  rightCollapsed: false,
  bottomCollapsed: true,
  leftWidth: 240,
  rightWidth: 360,
};

function loadPersisted(): Required<PersistedLayout> {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as PersistedLayout;
    return {
      leftCollapsed: typeof parsed.leftCollapsed === 'boolean' ? parsed.leftCollapsed : DEFAULTS.leftCollapsed,
      rightCollapsed: typeof parsed.rightCollapsed === 'boolean' ? parsed.rightCollapsed : DEFAULTS.rightCollapsed,
      bottomCollapsed: typeof parsed.bottomCollapsed === 'boolean' ? parsed.bottomCollapsed : DEFAULTS.bottomCollapsed,
      leftWidth: typeof parsed.leftWidth === 'number' && Number.isFinite(parsed.leftWidth) ? parsed.leftWidth : DEFAULTS.leftWidth,
      rightWidth: typeof parsed.rightWidth === 'number' && Number.isFinite(parsed.rightWidth) ? parsed.rightWidth : DEFAULTS.rightWidth,
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

  toggleLeft: () => {
    set((s) => ({ leftCollapsed: !s.leftCollapsed }));
    const { leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth } = get();
    persist({ leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth });
  },
  toggleRight: () => {
    set((s) => ({ rightCollapsed: !s.rightCollapsed }));
    const { leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth } = get();
    persist({ leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth });
  },
  toggleBottom: () => {
    set((s) => ({ bottomCollapsed: !s.bottomCollapsed }));
    const { leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth } = get();
    persist({ leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth });
  },
  setTheme: (t) => {
    localStorage.setItem('dkg-theme', t);
    set({ theme: t });
  },
  setLeftWidth: (w) => {
    set({ leftWidth: w });
    const { leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth } = get();
    persist({ leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth });
  },
  setRightWidth: (w) => {
    set({ rightWidth: w });
    const { leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth } = get();
    persist({ leftCollapsed, rightCollapsed, bottomCollapsed, leftWidth, rightWidth });
  },
}));
