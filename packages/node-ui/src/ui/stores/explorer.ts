import { create } from 'zustand';

export type StatusFilter = 'all' | 'synced' | 'pending';

export interface ExplorerFilters {
  search: string;
  statusFilter: StatusFilter;
  sortBy: 'name' | 'triples' | 'lastSynced';
  sortDir: 'asc' | 'desc';
}

interface ExplorerState {
  filters: ExplorerFilters;
  setSearch: (search: string) => void;
  setStatusFilter: (v: StatusFilter) => void;
  setSortBy: (field: ExplorerFilters['sortBy']) => void;
}

export const useExplorerStore = create<ExplorerState>((set, get) => ({
  filters: {
    search: '',
    statusFilter: 'all',
    sortBy: 'name',
    sortDir: 'asc',
  },
  setSearch: (search) => set((s) => ({ filters: { ...s.filters, search } })),
  setStatusFilter: (v) => set((s) => ({ filters: { ...s.filters, statusFilter: v } })),
  setSortBy: (field) => {
    const { filters } = get();
    if (filters.sortBy === field) {
      set({ filters: { ...filters, sortDir: filters.sortDir === 'asc' ? 'desc' : 'asc' } });
    } else {
      set({ filters: { ...filters, sortBy: field, sortDir: 'asc' } });
    }
  },
}));
