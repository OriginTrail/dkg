import React, { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { fetchConfig } from '../api.js';

export interface RepoInfo {
  owner: string;
  repo: string;
  paranetId: string;
  syncEnabled: boolean;
  webhookSecret: string | null;
  pollIntervalMs: number;
  syncScope: string[];
}

interface RepoContextValue {
  repos: RepoInfo[];
  selectedRepo: RepoInfo | null;
  selectRepo: (repoKey: string) => void;
  refreshRepos: () => Promise<void>;
  loading: boolean;
}

const RepoContext = createContext<RepoContextValue>({
  repos: [],
  selectedRepo: null,
  selectRepo: () => {},
  refreshRepos: async () => {},
  loading: true,
});

export function useRepo() {
  return useContext(RepoContext);
}

export function repoKey(r: RepoInfo): string {
  return `${r.owner}/${r.repo}`;
}

export function RepoProvider({ children }: { children: ReactNode }) {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshRepos = useCallback(async () => {
    try {
      const config = await fetchConfig();
      const list: RepoInfo[] = config.repos ?? [];
      setRepos(list);
      // Auto-select first repo if nothing selected or current selection removed
      if (list.length > 0) {
        const keys = list.map(r => `${r.owner}/${r.repo}`);
        setSelectedKey(prev => (prev && keys.includes(prev)) ? prev : keys[0]);
      } else {
        setSelectedKey(null);
      }
    } catch {
      setRepos([]);
      setSelectedKey(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refreshRepos(); }, [refreshRepos]);

  const selectedRepo = repos.find(r => `${r.owner}/${r.repo}` === selectedKey) ?? null;

  const selectRepo = useCallback((key: string) => {
    setSelectedKey(key);
  }, []);

  return (
    <RepoContext.Provider value={{ repos, selectedRepo, selectRepo, refreshRepos, loading }}>
      {children}
    </RepoContext.Provider>
  );
}
