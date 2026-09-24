/**
 * Unix process-table probes shared by the managed-Oxigraph checks: listener
 * ownership (`oxigraph-listen-port.ts`) and lock-holder reclaim
 * (`oxigraph-orphan.ts`).
 *
 * Linux reads `/proc`, which minimal images always have even when `ps`,
 * `lsof`, `ss` and `fuser` are missing. Other Unix hosts use one `ps` call.
 * Every variant is exported so tests can run each one on any host that
 * supports it, not only on the host that selects it by default.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** One observation of a running process, taken from a single read. */
export interface ProcessInstance {
  pid: number;
  /** Start-time token; with the PID it names this process across PID reuse. */
  start: string;
  ppid: number;
  /**
   * The exact argv where the platform exposes it (`/proc`), or null where
   * only display text is available (`ps`, which joins argv with spaces).
   */
  argv: readonly string[] | null;
  /** argv joined by single spaces, for logs. */
  command: string;
}

export type ProcessTreeWalker = (rootPid: number) => Promise<Set<number>>;
/** Null when the process has exited. */
export type ProcessInspector = (pid: number) => Promise<ProcessInstance | null>;
/**
 * An opaque start-time token, or null when the process is gone. With the PID
 * it names one process, so a recycled PID does not match a recorded one.
 */
export type ProcessStartProbe = (pid: number) => Promise<string | null>;

/** Every PID visible in `/proc` (Linux). */
export async function procPids(): Promise<number[]> {
  return (await readdir('/proc'))
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * Whether one of a process's open descriptors points at a target `matches`
 * accepts (Linux). Stops at the first match; a process that exits or cannot
 * be read has none.
 */
export async function procHasFdTarget(
  pid: number,
  matches: (target: string) => boolean,
): Promise<boolean> {
  let fds: string[];
  try {
    fds = await readdir(`/proc/${pid}/fd`);
  } catch {
    return false;
  }
  for (const fd of fds) {
    const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => null);
    if (target !== null && matches(target)) return true;
  }
  return false;
}

export const linuxProcessTree: ProcessTreeWalker = async (rootPid) => {
  const pids = new Set<number>([rootPid]);
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    try {
      const children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8'))
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
        .filter((value) => Number.isInteger(value) && value > 0);
      for (const childPid of children) {
        if (pids.has(childPid)) continue;
        pids.add(childPid);
        pending.push(childPid);
      }
    } catch {
      continue;
    }
  }
  return pids;
};

/** Descendants from one `ps` snapshot, for Unix hosts without `/proc`. */
export const psProcessTree: ProcessTreeWalker = async (rootPid) => {
  const pids = new Set<number>([rootPid]);
  const childrenOf = new Map<number, number[]>();
  try {
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 2_000 });
    for (const line of stdout.split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
      const siblings = childrenOf.get(ppid);
      if (siblings) siblings.push(pid);
      else childrenOf.set(ppid, [pid]);
    }
  } catch {
    // Without a snapshot only the root itself is known.
  }
  const pending = [rootPid];
  while (pending.length > 0) {
    for (const childPid of childrenOf.get(pending.pop()!) ?? []) {
      if (pids.has(childPid)) continue;
      pids.add(childPid);
      pending.push(childPid);
    }
  }
  return pids;
};

// `ps` prints lstart as five fields in the C locale: `Wed Sep  3 23:14:58 2026`.
const PS_ENV = { ...process.env, LC_ALL: 'C' };
const normalizeLstart = (lstart: string): string => lstart.trim().split(/\s+/).join(' ');

/** `/proc/<pid>/stat` after `(comm)`, which may itself contain spaces and parens. */
async function procStatFields(pid: number): Promise<string[]> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
}

// Fields after `(comm)`: state is field 3, ppid field 4, starttime field 22
// (clock ticks since boot). A zombie has exited even though its entry remains.
export const procInspectProcess: ProcessInspector = async (pid) => {
  try {
    const fields = await procStatFields(pid);
    const ppid = Number(fields[1]);
    const start = fields[19];
    if (fields[0] === 'Z' || !Number.isInteger(ppid) || !start) return null;
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
    if (argv.at(-1) === '') argv.pop();
    return { pid, start, ppid, argv, command: argv.join(' ') };
  } catch {
    return null;
  }
};

export const psInspectProcess: ProcessInspector = async (pid) => {
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-ww', '-o', 'ppid=,lstart=,command=', '-p', String(pid)],
      { timeout: 2_000, env: PS_ENV },
    );
    const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/s.exec(stdout.trimEnd());
    return match
      ? { pid, start: normalizeLstart(match[2]), ppid: Number(match[1]), argv: null, command: match[3] }
      : null;
  } catch {
    return null;
  }
};

export const procProcessStart: ProcessStartProbe = async (pid) => {
  try {
    const fields = await procStatFields(pid);
    return fields[0] === 'Z' ? null : fields[19] ?? null;
  } catch {
    return null;
  }
};

export const psProcessStart: ProcessStartProbe = async (pid) => {
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { timeout: 2_000, env: PS_ENV },
    );
    return normalizeLstart(stdout) || null;
  } catch {
    return null;
  }
};

export function processTreeWalker(platform: NodeJS.Platform): ProcessTreeWalker {
  return platform === 'linux' ? linuxProcessTree : psProcessTree;
}

export function processInspector(platform: NodeJS.Platform): ProcessInspector {
  return platform === 'linux' ? procInspectProcess : psInspectProcess;
}

export function processStartProbe(platform: NodeJS.Platform): ProcessStartProbe {
  return platform === 'linux' ? procProcessStart : psProcessStart;
}
