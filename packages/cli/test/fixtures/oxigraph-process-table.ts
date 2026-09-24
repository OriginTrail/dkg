import { vi } from 'vitest';
import type { OrphanedOxigraphIo } from '../../src/daemon/oxigraph-orphan.js';

/**
 * An injected process table for the orphan reclaim: processes with argv,
 * parent, start time and whether they hold the store lock. Signals take effect
 * at once; `sleep` advances a fake clock.
 */
export interface FakeProcess {
  ppid: number;
  argv: string[];
  holdsLock: boolean;
  /** Only `ps`-style display text is available for this process. */
  displayOnly?: boolean;
  /** Start-time token; defaults to `t<pid>`. */
  start?: string;
  ignoresTerm?: boolean;
  alive: boolean;
}

export function processTable(
  entries: Record<number, Omit<FakeProcess, 'alive'>>,
  hooks: { onInspect?: (pid: number, table: Map<number, FakeProcess>) => void } = {},
) {
  const table = new Map<number, FakeProcess>(
    Object.entries(entries).map(([pid, entry]) => [Number(pid), { ...entry, alive: true }]),
  );
  let clock = 0;
  const signals: Array<[number, NodeJS.Signals]> = [];
  const io: OrphanedOxigraphIo = {
    listLockHolders: vi.fn(async () =>
      [...table].filter(([, entry]) => entry.alive && entry.holdsLock).map(([pid]) => pid)),
    inspectProcess: async (pid) => {
      const entry = table.get(pid);
      const instance = entry?.alive
        ? {
            pid,
            start: entry.start ?? `t${pid}`,
            ppid: entry.ppid,
            argv: entry.displayOnly ? null : entry.argv,
            command: entry.argv.join(' '),
          }
        : null;
      hooks.onInspect?.(pid, table);
      return instance;
    },
    isSameInstance: async ({ pid, start }) => {
      const entry = table.get(pid);
      return entry?.alive === true && (entry.start ?? `t${pid}`) === start;
    },
    signal: (pid, signal) => {
      signals.push([pid, signal]);
      const entry = table.get(pid);
      if (!entry?.alive) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      if (signal === 'SIGKILL' || !entry.ignoresTerm) entry.alive = false;
    },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  return { table, signals, io };
}
