import { readFileSync } from 'node:fs';

/**
 * Best-effort OOM-kill detection for the managed oxigraph child, narrowed to
 * exactly what the supervisor's restart logging needs.
 *
 * Every export is NON-THROWING and returns null on any unsupported platform
 * (non-Linux, cgroup-v1) or read failure — it is used purely to annotate a
 * restart log, never for control flow.
 *
 * The supervisor captures a snapshot (cgroup dir + `oom_kill` count) while the
 * child is alive, then best-effort re-reads `oom_kill` when the child exits.
 * A dedicated scope may disappear as soon as its final process exits, so the
 * scoped watchdog performs the same comparison while it is still resident.
 * An increase means the kernel
 * cgroup-OOM-killed oxigraph — typically the operator's unit-level `MemoryMax`
 * cap engaging (the 2026-07 beacon remediation), or a host OOM — which the
 * supervisor surfaces so operators can tell it apart from a plain crash without
 * SSHing in to correlate journald + /proc.
 */

export interface CgroupOomSnapshot {
  /** Absolute cgroup dir under /sys/fs/cgroup. */
  dir: string;
  /** `memory.events` oom_kill count at capture time. */
  oomKill: number;
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

/**
 * Spawn-time capture (pid must be alive): resolve the process's cgroup-v2 dir
 * and read its current `oom_kill` count. Returns null on non-Linux, cgroup-v1,
 * or any read failure.
 */
export function readCgroupOomSnapshot(
  pid: number,
  io: MemoryReaderIo = defaultIo,
): CgroupOomSnapshot | null {
  if (io.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return null;
  const dir = resolveCgroupDir(pid, io);
  if (!dir) return null;
  const oomKill = readOomKill(dir, io);
  if (oomKill === null) return null;
  return { dir, oomKill };
}

/**
 * Exit-time re-read of `oom_kill` from a captured cgroup dir. Returns null on
 * non-Linux, read failure, or when systemd already removed an empty scope.
 */
export function readCgroupOomKill(dir: string, io: MemoryReaderIo = defaultIo): number | null {
  if (io.platform !== 'linux' || !dir) return null;
  return readOomKill(dir, io);
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

function readOomKill(dir: string, io: MemoryReaderIo): number | null {
  try {
    for (const raw of io.readTextSync(`${dir}/memory.events`).split('\n')) {
      const [key, value] = raw.trim().split(/\s+/);
      if (key === 'oom_kill' && value !== undefined) {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}
