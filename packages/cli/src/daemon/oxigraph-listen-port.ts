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
 * Managed memory scopes use a tiny parent watchdog, so callers may explicitly
 * permit a descendant PID while still rejecting unrelated local listeners.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

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
      try {
        const fdDir = `/proc/${pid}/fd`;
        const fds = await readdir(fdDir);
        for (const fd of fds) {
          try {
            const target = await readlink(`${fdDir}/${fd}`);
            if (target.includes(socketNeedle)) return pid;
          } catch {
            continue;
          }
        }
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function linuxProcessTree(rootPid: number): Promise<Set<number>> {
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
}

async function windowsProcessTree(rootPid: number): Promise<Set<number>> {
  const pids = new Set<number>([rootPid]);
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "{0} {1}" -f $_.ProcessId,$_.ParentProcessId }',
      ],
      { timeout: 3_000 },
    );
    const children = new Map<number, number[]>();
    for (const line of stdout.split('\n')) {
      const [rawPid, rawParentPid] = line.trim().split(/\s+/);
      const pid = Number(rawPid);
      const parentPid = Number(rawParentPid);
      if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) continue;
      const list = children.get(parentPid) ?? [];
      list.push(pid);
      children.set(parentPid, list);
    }
    const pending = [rootPid];
    while (pending.length > 0) {
      for (const childPid of children.get(pending.pop()!) ?? []) {
        if (pids.has(childPid)) continue;
        pids.add(childPid);
        pending.push(childPid);
      }
    }
  } catch {
    // Fall back to the wrapper PID. Readiness then fails closed rather than
    // trusting an unrelated listener on the configured port.
  }
  return pids;
}

async function windowsListenOwnerPid(
  pids: ReadonlySet<number>,
  port: number,
): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'], { timeout: 3_000 });
    const suffix = `:${port}`;
    for (const line of stdout.split('\n')) {
      if (!line.includes('LISTENING') || !line.includes(suffix)) continue;
      const parts = line.trim().split(/\s+/);
      const rowPid = Number(parts[parts.length - 1]);
      if (pids.has(rowPid)) return rowPid;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Return the PID when `child` (or, when explicitly enabled, one of its Linux
 * descendants) is alive and owns the TCP listener on `port`.
 * For non-loopback hosts we only require the child to be alive (tests).
 */
export async function findListenOwnerPid(
  child: ChildProcess,
  port: number,
  host: string,
  ownership: 'child-only' | 'process-tree' = 'child-only',
): Promise<number | null> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return null;
  }
  if (host !== '127.0.0.1' && host !== 'localhost') return child.pid;

  const pid = child.pid;
  const pids = ownership === 'process-tree'
    ? process.platform === 'linux'
      ? await linuxProcessTree(pid)
      : process.platform === 'win32'
        ? await windowsProcessTree(pid)
        : new Set([pid])
    : new Set([pid]);

  if (process.platform === 'win32') {
    return windowsListenOwnerPid(pids, port);
  }

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
