import { create } from 'zustand';

/**
 * The create and join Context Graph dialogs. They belong to the shell, not the
 * left panel: both navigate before their last step, and a narrow screen closes
 * the panel on navigation.
 */
interface ContextGraphDialogsState {
  createOpen: boolean;
  joinOpen: boolean;
  /** Prefills the join dialog's invite code. */
  joinContextGraphId?: string;
  openCreate: () => void;
  openJoin: (contextGraphId?: string) => void;
  closeCreate: () => void;
  closeJoin: () => void;
}

export const useContextGraphDialogs = create<ContextGraphDialogsState>((set) => ({
  createOpen: false,
  joinOpen: false,
  joinContextGraphId: undefined,
  openCreate: () => set({ createOpen: true }),
  openJoin: (contextGraphId) => set({ joinOpen: true, joinContextGraphId: contextGraphId }),
  closeCreate: () => set({ createOpen: false }),
  closeJoin: () => set({ joinOpen: false, joinContextGraphId: undefined }),
}));
