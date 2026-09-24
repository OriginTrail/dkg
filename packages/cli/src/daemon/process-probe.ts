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

export interface ProcessDescription {
  ppid: number;
  /** argv joined by single spaces. */
  command: string;
}

export type ProcessTreeWalker = (rootPid: number) => Promise<Set<number>>;
export type ProcessDescriber = (pid: number) => Promise<ProcessDescription | null>;
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

/** Targets of a process's open descriptors (Linux); empty when unreadable. */
export async function procFdTargets(pid: number): Promise<string[]> {
  let fds: string[];
  try {
    fds = await readdir(`/proc/${pid}/fd`);
  } catch {
    return [];
  }
  const targets: string[] = [];
  for (const fd of fds) {
    const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => null);
    if (target !== null) targets.push(target);
  }
  return targets;
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

export const procDescribeProcess: ProcessDescriber = async (pid) => {
  try {
    // `pid (comm) state ppid …`; comm may itself contain spaces and parens.
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
    if (argv.at(-1) === '') argv.pop();
    return Number.isInteger(ppid) ? { ppid, command: argv.join(' ') } : null;
  } catch {
    return null;
  }
};

export const psDescribeProcess: ProcessDescriber = async (pid) => {
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-ww', '-o', 'ppid=,command=', '-p', String(pid)],
      { timeout: 2_000 },
    );
    const match = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trimEnd());
    return match ? { ppid: Number(match[1]), command: match[2] } : null;
  } catch {
    return null;
  }
};

export const procProcessStart: ProcessStartProbe = async (pid) => {
  try {
    // After `(comm)`: state is field 3 and starttime field 22 (clock ticks
    // since boot). A zombie has exited even though its entry remains.
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? null : fields[19] ?? null;
  } catch {
    return null;
  }
};

export const psProcessStart: ProcessStartProbe = async (pid) => {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 2_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

export function processTreeWalker(platform: NodeJS.Platform): ProcessTreeWalker {
  return platform === 'linux' ? linuxProcessTree : psProcessTree;
}

export function processDescriber(platform: NodeJS.Platform): ProcessDescriber {
  return platform === 'linux' ? procDescribeProcess : psDescribeProcess;
}

export function processStartProbe(platform: NodeJS.Platform): ProcessStartProbe {
  return platform === 'linux' ? procProcessStart : psProcessStart;
}
