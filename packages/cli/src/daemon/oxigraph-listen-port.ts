/**
 * Verify a child process owns a TCP listen socket on a port.
 *
 * HTTP 200 on loopback alone is not enough — another local SPARQL service
 * can answer while our `oxigraph serve` child died on EADDRINUSE. We try
 * platform-specific probes in order and require a match on the child process
 * tree selected by the caller.
 *
 * `lsof` is preferred on Unix but often missing in minimal Linux/container
 * images; Linux fallbacks use `ss`, `fuser`, then `/proc` inode matching.
 * On Unix hosts Oxigraph runs under a tiny parent watchdog, so callers may
 * explicitly permit a descendant PID while still rejecting unrelated local
 * listeners.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import {
  procHasFdTarget,
  processTreeWalker,
  type ProcessTreeWalker,
} from './process-probe.js';

const execFileAsync = promisify(execFile);

/**
 * Hex port token as it appears in the `local_address` field of
 * `/proc/net/tcp`. Only the IPv4 address is byte-swapped there; the port is
 * printed in normal big-endian hex (e.g. 8080 → `1F90`, 7878 → `1EC6`).
 */
export function procNetLocalPortHex(port: number): string {
  return port.toString(16).toUpperCase().padStart(4, '0');
}

async function lsofListenOwnerPid(pids: ReadonlySet<number>, port: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'],
      { timeout: 2_000 },
    );
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[1]);
      if (parts.length >= 2 && pids.has(pid)) return pid;
    }
    return null;
  } catch {
    return null;
  }
}

async function ssListenOwnerPid(pids: ReadonlySet<number>, port: number): Promise<number | null> {
  try {
    // `-p` is required for the `users:(("proc",pid=N,fd=M))` process column;
    // without it `ss` never emits `pid=` and this probe is dead code. Our own
    // child runs as the same user, so no elevation is needed to see its pid.
    const { stdout } = await execFileAsync(
      'ss',
      ['-ltnpH', `sport = :${port}`],
      { timeout: 2_000 },
    );
    for (const line of stdout.split('\n')) {
      const m = line.match(/pid=(\d+)/);
      const pid = Number(m?.[1]);
      if (m && pids.has(pid)) return pid;
    }
    return null;
  } catch {
    return null;
  }
}

async function fuserListenOwnerPid(pids: ReadonlySet<number>, port: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('fuser', [`${port}/tcp`], {
      timeout: 2_000,
    });
    return stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .find((pid) => pids.has(pid)) ?? null;
  } catch {
    return null;
  }
}

async function procfsListenOwnerPid(pids: ReadonlySet<number>, port: number): Promise<number | null> {
  try {
    const portHex = procNetLocalPortHex(port);
    const tcp = await readFile('/proc/net/tcp', 'utf8');
    let listenInode: string | null = null;
    for (const line of tcp.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      const local = cols[1];
      const state = cols[3];
      if (state !== '0A') continue;
      const [, portField] = local.split(':');
      if (portField?.toUpperCase() === portHex) {
        listenInode = cols[9];
        break;
      }
    }
    if (!listenInode) return null;

    const socketNeedle = `socket:[${listenInode}]`;
    for (const pid of pids) {
      if (await procHasFdTarget(pid, (target) => target.includes(socketNeedle))) return pid;
    }
    return null;
  } catch {
    return null;
  }
}

async function windowsListenOwnerPid(pid: number, port: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'], { timeout: 3_000 });
    const suffix = `:${port}`;
    for (const line of stdout.split('\n')) {
      if (!line.includes('LISTENING') || !line.includes(suffix)) continue;
      const parts = line.trim().split(/\s+/);
      const rowPid = Number(parts[parts.length - 1]);
      if (rowPid === pid) return pid;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Return the PID when `child` (or, when explicitly enabled, one of its Unix
 * descendants) is alive and owns the TCP listener on `port`.
 * For non-loopback hosts a child-only caller only requires the child to be
 * alive (tests); a process-tree caller still needs the listening descendant,
 * never the wrapper.
 * `processTree` overrides the host's descendant walker, so each walker can be
 * exercised on any Unix host.
 */
export async function findListenOwnerPid(
  child: ChildProcess,
  port: number,
  host: string,
  ownership: 'child-only' | 'process-tree' = 'child-only',
  processTree: ProcessTreeWalker = processTreeWalker(process.platform),
): Promise<number | null> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return null;
  }
  if (host !== '127.0.0.1' && host !== 'localhost' && ownership === 'child-only') return child.pid;

  const pid = child.pid;
  if (process.platform === 'win32') {
    return windowsListenOwnerPid(pid, port);
  }
  const pids = ownership === 'child-only' ? new Set([pid]) : await processTree(pid);

  const lsofOwner = await lsofListenOwnerPid(pids, port);
  if (lsofOwner !== null) return lsofOwner;

  if (process.platform === 'linux') {
    const ssOwner = await ssListenOwnerPid(pids, port);
    if (ssOwner !== null) return ssOwner;
    const fuserOwner = await fuserListenOwnerPid(pids, port);
    if (fuserOwner !== null) return fuserOwner;
    const procfsOwner = await procfsListenOwnerPid(pids, port);
    if (procfsOwner !== null) return procfsOwner;
  }

  return null;
}

export async function childOwnsListenPort(
  child: ChildProcess,
  port: number,
  host: string,
  ownership: 'child-only' | 'process-tree' = 'child-only',
): Promise<boolean> {
  return (await findListenOwnerPid(child, port, host, ownership)) !== null;
}
