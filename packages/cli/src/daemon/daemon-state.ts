import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DAEMON_STATE_FILE = '.network-state.json';

/** Persisted boot state shared by reset and configuration-switch guards. */
export interface PersistedDaemonState {
  chainResetMarker: string | null;
  lastBackend?: string | null;
  lastNetworkConfig?: string | null;
  savedAt: number;
}

export function readPersistedDaemonState(dataDir: string): PersistedDaemonState | null {
  try {
    const raw = readFileSync(join(dataDir, DAEMON_STATE_FILE), 'utf8');
    const state = JSON.parse(raw) as PersistedDaemonState;
    if (
      typeof state?.chainResetMarker !== 'string'
      && state?.chainResetMarker !== null
    ) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function updatePersistedDaemonState(
  dataDir: string,
  patch: Partial<Omit<PersistedDaemonState, 'savedAt'>>,
): void {
  const existing = readPersistedDaemonState(dataDir) ?? {
    chainResetMarker: null,
    savedAt: 0,
  };
  writeFileSync(
    join(dataDir, DAEMON_STATE_FILE),
    JSON.stringify(
      {
        ...existing,
        ...patch,
        savedAt: Date.now(),
      } satisfies PersistedDaemonState,
      null,
      2,
    ),
  );
}

export function readPersistedStoreBackend(dataDir: string): string | null {
  const state = readPersistedDaemonState(dataDir);
  return typeof state?.lastBackend === 'string' && state.lastBackend.length > 0
    ? state.lastBackend
    : null;
}

export function readPersistedNetworkConfig(dataDir: string): string | null {
  const state = readPersistedDaemonState(dataDir);
  return typeof state?.lastNetworkConfig === 'string' && state.lastNetworkConfig.length > 0
    ? state.lastNetworkConfig
    : null;
}

export function writePersistedChainResetMarker(dataDir: string, marker: string | null): void {
  updatePersistedDaemonState(dataDir, { chainResetMarker: marker });
}

export function writePersistedStoreBackend(dataDir: string, backend: string): void {
  updatePersistedDaemonState(dataDir, { lastBackend: backend });
}

export function writePersistedNetworkConfig(dataDir: string, networkConfig: string): void {
  updatePersistedDaemonState(dataDir, { lastNetworkConfig: networkConfig });
}
