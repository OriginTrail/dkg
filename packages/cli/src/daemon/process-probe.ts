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

/**
 * What one read of a PID found. `gone` is confirmed absence: no such
 * process, or a zombie. `unknown` is a read that failed (a timeout, a
 * permission error, output that does not parse), which never proves that
 * the process exited.
 */
export type ProcessLookup =
  | { state: 'running'; process: ProcessInstance }
  | { state: 'gone' }
  | { state: 'unknown'; reason: string };

export type ProcessTreeWalker = (rootPid: number) => Promise<Set<number>>;
export type ProcessInspector = (pid: number) => Promise<ProcessLookup>;

const errorReason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

// A `/proc` entry that vanished between listing and reading: the process
// exited. Any other error leaves its state unknown.
const procEntryGone = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ESRCH';
};

// Fields after `(comm)`, which may itself contain spaces and parens: state
// is field 3, ppid field 4, starttime field 22 (clock ticks since boot). A
// zombie has exited even though its entry remains.
export const procInspectProcess: ProcessInspector = async (pid) => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return { state: 'gone' };
    const ppid = Number(fields[1]);
    const start = fields[19];
    if (!Number.isInteger(ppid) || !start) {
      return { state: 'unknown', reason: `unexpected /proc/${pid}/stat contents` };
    }
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
    if (argv.at(-1) === '') argv.pop();
    return { state: 'running', process: { pid, start, ppid, argv, command: argv.join(' ') } };
  } catch (error) {
    return procEntryGone(error) ? { state: 'gone' } : { state: 'unknown', reason: errorReason(error) };
  }
};

// `ps -p` exits 1 with no output when no such process exists; any other
// failure (a timeout, a missing `ps`, a message on stderr) is not proof of
// exit.
export const psInspectProcess: ProcessInspector = async (pid) => {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'ps',
      ['-ww', '-o', 'ppid=,stat=,lstart=,command=', '-p', String(pid)],
      { timeout: 2_000, env: PS_ENV },
    ));
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: unknown; stderr?: unknown; killed?: boolean };
    const noSuchProcess = failed.code === 1 && failed.killed !== true
      && String(failed.stdout ?? '').trim() === '' && String(failed.stderr ?? '').trim() === '';
    return noSuchProcess ? { state: 'gone' } : { state: 'unknown', reason: `ps: ${errorReason(error)}` };
  }
  const match = /^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/s.exec(stdout.trimEnd());
  if (!match) return { state: 'unknown', reason: 'ps: unexpected output' };
  if (match[2].startsWith('Z')) return { state: 'gone' };
  return {
    state: 'running',
    process: { pid, start: normalizeLstart(match[3]), ppid: Number(match[1]), argv: null, command: match[4] },
  };
};

export function processTreeWalker(platform: NodeJS.Platform): ProcessTreeWalker {
  return platform === 'linux' ? linuxProcessTree : psProcessTree;
}

export function processInspector(platform: NodeJS.Platform): ProcessInspector {
  return platform === 'linux' ? procInspectProcess : psInspectProcess;
}
