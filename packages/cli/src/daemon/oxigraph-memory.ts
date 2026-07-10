import { readFileSync } from 'node:fs';

/**
 * Best-effort memory observability for the managed oxigraph child.
 *
 * Every export is NON-THROWING and returns null / null-fields on any
 * unsupported platform (non-Linux, cgroup-v1) or read failure — callers use it
 * purely for logging/telemetry, never for control flow.
 *
 * On Linux cgroup-v2 it reads the process's own cgroup accounting
 * (`memory.current` / `memory.max` / `memory.events`). When an operator has
 * applied a unit-level `MemoryHigh`/`MemoryMax` drop-in (the 2026-07 beacon-OOM
 * remediation), a cap-induced kill increments `memory.events` `oom_kill` — so
 * the daemon can tell an OOM-kill (by the memory cap, or the host) apart from a
 * plain crash in its restart logs, which today requires an operator to SSH in
 * and read `journalctl`/`/proc`.
 */

export interface CgroupMemoryEvents {
  /** times usage was throttled at memory.high */
  high: number;
  /** times an allocation would have exceeded memory.max */
  max: number;
  /** processes in the cgroup killed by the cgroup OOM killer */
  oomKill: number;
}

export interface OxigraphMemoryStats {
  /** Resident set size of the process, bytes. null if unreadable. */
  rssBytes: number | null;
  /** cgroup-v2 accounting for the process's cgroup; null if unavailable. */
  cgroup: {
    /** Absolute cgroup dir under /sys/fs/cgroup (persists after the process exits). */
    dir: string;
    /** memory.current, bytes. */
    currentBytes: number | null;
    /** memory.max (the hard cap), bytes; null when uncapped ("max"). */
    maxBytes: number | null;
    events: CgroupMemoryEvents;
  } | null;
}

export interface MemoryReaderIo {
  /** Read a file as UTF-8; MUST throw on missing/unreadable. */
  readTextSync: (path: string) => string;
  /** process.platform */
  platform: NodeJS.Platform | string;
}

const defaultIo: MemoryReaderIo = {
  readTextSync: (p) => readFileSync(p, 'utf-8'),
  platform: process.platform,
};

/** Full stats for a live pid (rss + its cgroup accounting). */
export function readOxigraphMemoryStats(
  pid: number,
  io: MemoryReaderIo = defaultIo,
): OxigraphMemoryStats | null {
  if (io.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return null;
  const rssBytes = readRssBytes(pid, io);
  const cgroup = readCgroupForPid(pid, io);
  if (rssBytes === null && cgroup === null) return null;
  return { rssBytes, cgroup };
}

/**
 * Read `memory.events` from a known cgroup dir. Used at process EXIT, when
 * /proc/<pid> is already gone but the cgroup dir still exists — so the caller
 * captures the dir at spawn and re-reads events here to detect an OOM-kill.
 */
export function readCgroupEvents(dir: string, io: MemoryReaderIo = defaultIo): CgroupMemoryEvents | null {
  if (io.platform !== 'linux' || !dir) return null;
  return readEvents(`${dir}/memory.events`, io);
}

function readRssBytes(pid: number, io: MemoryReaderIo): number | null {
  try {
    const m = io.readTextSync(`/proc/${pid}/status`).match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function readCgroupForPid(pid: number, io: MemoryReaderIo): OxigraphMemoryStats['cgroup'] {
  const dir = resolveCgroupDir(pid, io);
  if (!dir) return null;
  const events = readEvents(`${dir}/memory.events`, io);
  const currentBytes = readIntFile(`${dir}/memory.current`, io);
  if (events === null && currentBytes === null) return null; // not a v2 memory cgroup we can read
  return {
    dir,
    currentBytes,
    maxBytes: readMaxFile(`${dir}/memory.max`, io),
    events: events ?? { high: 0, max: 0, oomKill: 0 },
  };
}

function resolveCgroupDir(pid: number, io: MemoryReaderIo): string | null {
  try {
    // cgroup-v2 has a single entry `0::<relative-path>`.
    const line = io
      .readTextSync(`/proc/${pid}/cgroup`)
      .split('\n')
      .find((l) => l.startsWith('0::'));
    if (!line) return null; // cgroup-v1 or unexpected format
    const rel = line.slice('0::'.length).trim();
    if (!rel.startsWith('/')) return null;
    return `/sys/fs/cgroup${rel === '/' ? '' : rel}`;
  } catch {
    return null;
  }
}

function readIntFile(path: string, io: MemoryReaderIo): number | null {
  try {
    const n = Number(io.readTextSync(path).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function readMaxFile(path: string, io: MemoryReaderIo): number | null {
  try {
    const v = io.readTextSync(path).trim();
    if (v === 'max' || v === '') return null; // uncapped
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function readEvents(path: string, io: MemoryReaderIo): CgroupMemoryEvents | null {
  try {
    const map: Record<string, number> = {};
    for (const line of io.readTextSync(path).split('\n')) {
      const [k, v] = line.trim().split(/\s+/);
      if (k && v !== undefined) {
        const n = Number(v);
        if (Number.isFinite(n)) map[k] = n;
      }
    }
    if (Object.keys(map).length === 0) return null;
    return { high: map.high ?? 0, max: map.max ?? 0, oomKill: map.oom_kill ?? 0 };
  } catch {
    return null;
  }
}
