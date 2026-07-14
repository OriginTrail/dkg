// Bounded-concurrency read-only SSH exec + k=v snapshot parsing (rfc59 port).
// OT-RFC-61 §9.1 transport layer. Zero deps; Node >= 20 built-ins only.
//
// S2 note: this module is transport only and never composes sudo/systemctl/
// write commands. snapshotCommand() is audited read-only by test/ssh.test.mjs.

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const UNIT_RE = /^[A-Za-z0-9@:._-]+$/;
const PATH_RE = /^[A-Za-z0-9/._-]+$/;

/**
 * Validate a systemd unit name for safe shell interpolation and normalize it
 * to its full `<name>.service` form. Throws TypeError on unsafe input.
 * (Extra helper beyond the frozen contract; also used by lib/fleet.mjs.)
 * @param {string} unit
 */
export function unitFullName(unit) {
  const u = String(unit ?? '').trim();
  if (!u || !UNIT_RE.test(u)) {
    throw new TypeError(`unsafe systemd unit name: ${JSON.stringify(unit)}`);
  }
  return u.endsWith('.service') ? u : `${u}.service`;
}

function spawnOnce(spawnImpl, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(result);
    };
    let child;
    try {
      child = spawnImpl('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      finish({ ok: false, code: null, stdout: '', stderr: String(err?.message ?? err), timedOut: false });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ ok: false, code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { if (stdout.length < MAX_CAPTURE_BYTES) stdout += d; });
    child.stderr?.on('data', (d) => { if (stderr.length < MAX_CAPTURE_BYTES) stderr += d; });
    child.on('error', (err) => {
      finish({ ok: false, code: null, stdout, stderr: stderr || String(err?.message ?? err), timedOut });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Run one remote command over SSH. STRICTLY read-only by convention — this
 * module never composes sudo/systemctl/write commands (S2 lives in config +
 * the snapshot script; this is just transport).
 * Options: BatchMode=yes, IdentitiesOnly=yes when identity given,
 * ConnectTimeout from fleet config, StrictHostKeyChecking=accept-new,
 * 2 attempts on connect failure.
 * @param {{host: string, sshUser: string, sshIdentity?: string}} target
 * @param {string} remoteCmd
 * @param {{timeoutMs?: number, connectTimeoutSec?: number}} [opts]
 *   Optional extras: _spawn (injectable spawn for tests), _retryDelayMs.
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
export async function sshExec(target, remoteCmd, opts = {}) {
  const {
    timeoutMs = 30_000,
    connectTimeoutSec = 8,
    _spawn = spawn,
    _retryDelayMs = 1500,
  } = opts;
  if (!target?.host || !target?.sshUser) {
    return { ok: false, code: null, stdout: '', stderr: 'sshExec: target requires host and sshUser', timedOut: false };
  }
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${Math.max(1, Math.floor(connectTimeoutSec))}`,
    ...(target.sshIdentity ? ['-i', target.sshIdentity, '-o', 'IdentitiesOnly=yes'] : []),
    `${target.sshUser}@${target.host}`,
    '--',
    String(remoteCmd),
  ];
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await spawnOnce(_spawn, args, timeoutMs);
    // ssh exits 255 on connection/transport failure; anything else means the
    // remote command actually ran (or the local spawn failed) — do not retry.
    if (last.code !== 255) return last;
    if (attempt === 0 && _retryDelayMs > 0) await delay(_retryDelayMs);
  }
  return last;
}

/**
 * Map over targets with a concurrency cap (fleet.sshConcurrency, default 2 —
 * avoid tailnet connection storms). Never rejects; per-target result or
 * {ok:false, error} placeholder.
 * @template T,R @param {T[]} targets @param {number} limit @param {(t:T)=>Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(targets, limit, fn) {
  const items = Array.from(targets ?? []);
  const results = new Array(items.length);
  const cap = Math.max(1, Math.floor(Number(limit)) || 1);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        results[i] = { ok: false, error: String(err?.message ?? err) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(cap, items.length) }, () => worker()));
  return results;
}

const KV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Parse `key=value` lines (one per line) from snapshot command output into an
 * object. Values may be base64-wrapped as b64:<data> (paths, multiline) —
 * decoded transparently. Unknown lines ignored. (rfc59 k=v pattern.)
 * @param {string} stdout @returns {Record<string, string>}
 */
export function parseKvOutput(stdout) {
  const out = {};
  for (const rawLine of String(stdout ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    if (!KV_KEY_RE.test(key)) continue;
    let value = line.slice(i + 1).trim();
    if (value.startsWith('b64:')) {
      value = Buffer.from(value.slice(4), 'base64').toString('utf8').trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Compose the ONE compound read-only snapshot command for a core (light or
 * full). Emits k=v lines. Light: systemd show (ActiveState, MainPID,
 * NRestarts, ExecMainStartTimestamp), worker pid + rss (ps), cgroup
 * memory.current/peak/high/max + memory.events oom_kill + memory.pressure
 * (some avg10), `ss -tln` recv-q/backlog for listenPort, TCP connect probe
 * (bash /dev/tcp with timeout), df -B1 of storeFilesystem.
 * Full adds: store dir du -sb (via unit WorkingDirectory heuristic), journal
 * cursor (`journalctl -u <unit> -n 0 --show-cursor`).
 * MUST NOT contain sudo, systemctl (other than `systemctl show`), redirects to
 * files, or any state-changing construct — a test greps for this.
 *
 * S6 note: no remote path/hostname/username values are emitted in a form the
 * per-core record keeps — spaced values (timestamps) travel as b64:<data>
 * (remote is Linux, so `base64 -w0` is safe; never rely on macOS flags here).
 * @param {{systemdUnit: string, listenPort: number, storeFilesystem: string}} core
 * @param {{light?: boolean}} [opts] @returns {string}
 */
export function snapshotCommand(core, opts = {}) {
  const { light = false } = opts;
  const unit = unitFullName(core.systemdUnit);
  const port = Number(core.listenPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new TypeError(`invalid listenPort: ${JSON.stringify(core.listenPort)}`);
  }
  const storeFs = String(core.storeFilesystem ?? '/');
  if (!PATH_RE.test(storeFs)) {
    throw new TypeError(`unsafe storeFilesystem path: ${JSON.stringify(core.storeFilesystem)}`);
  }
  const show = (prop) => `systemctl show ${unit} --property=${prop} --value 2>/dev/null`;
  const parts = [
    `echo active_state=$(${show('ActiveState')})`,
    `echo sub_state=$(${show('SubState')})`,
    `echo n_restarts=$(${show('NRestarts')})`,
    // ExecMainStartTimestamp contains spaces -> b64-wrap.
    `echo exec_main_start=b64:$(${show('ExecMainStartTimestamp')} | base64 -w0)`,
    `pid=$(${show('MainPID')}); echo main_pid=$pid`,
    `if [ -n "$pid" ] && [ "$pid" != 0 ]; then echo main_rss_kb=$(ps -o rss= -p "$pid" 2>/dev/null | awk '{print $1+0}'); else echo main_rss_kb=; fi`,
    // The userland supervisor absorbs worker deaths (§9.1) — capture the
    // foreground worker separately so PID deltas surface restarts.
    `worker_pid=$(pgrep -P "$pid" -f daemon-foreground-worker 2>/dev/null | head -1); echo worker_pid=$worker_pid`,
    `if [ -n "$worker_pid" ]; then echo worker_rss_kb=$(ps -o rss= -p "$worker_pid" 2>/dev/null | awk '{print $1+0}'); else echo worker_rss_kb=; fi`,
    // cgroup path resolved from the systemd unit; ControlGroup via
    // `systemctl show` first, static /system.slice/<unit> path as fallback.
    `cg=$(${show('ControlGroup')}); [ -n "$cg" ] || cg=/system.slice/${unit}; cg_dir=/sys/fs/cgroup$cg`,
    `echo memory_current=$(cat "$cg_dir/memory.current" 2>/dev/null)`,
    `echo memory_peak=$(cat "$cg_dir/memory.peak" 2>/dev/null)`,
    `echo memory_high=$(cat "$cg_dir/memory.high" 2>/dev/null)`,
    `echo memory_max=$(cat "$cg_dir/memory.max" 2>/dev/null)`,
    `echo oom_kills=$(awk '$1=="oom_kill" {print $2}' "$cg_dir/memory.events" 2>/dev/null)`,
    `echo psi_some_avg10=$(awk '$1=="some" {sub("avg10=","",$2); print $2}' "$cg_dir/memory.pressure" 2>/dev/null)`,
    // Listener accept-queue state (review-mandated §9.1 field): for LISTEN
    // sockets ss reports Recv-Q = current accept-queue depth, Send-Q = backlog.
    `ss_line=$(ss -H -tln sport = :${port} 2>/dev/null | head -1)`,
    `echo listen_recvq=$(printf '%s' "$ss_line" | awk '{print $2}')`,
    `echo listen_backlog=$(printf '%s' "$ss_line" | awk '{print $3}')`,
    // Out-of-band TCP connect probe — catches the wedge ss cannot show.
    `timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port}' 2>/dev/null && echo probe_ok=1 || echo probe_ok=0`,
    // Disk floor input (S3): GNU df --output first, POSIX df -P fallback.
    `df_line=$(df -B1 --output=avail,pcent ${storeFs} 2>/dev/null | tail -1); [ -n "$df_line" ] || df_line=$(df -P -B1 ${storeFs} 2>/dev/null | awk 'NR==2 {print $4" "$5}')`,
    `echo disk_avail_bytes=$(printf '%s' "$df_line" | awk '{print $1+0}')`,
    `echo disk_used_pct=$(printf '%s' "$df_line" | awk '{gsub("%","",$2); print $2+0}')`,
  ];
  if (!light) {
    parts.push(
      // Store size via unit WorkingDirectory heuristic (full mode only — du is
      // too heavy for the light loop). The path itself is NOT emitted (S6: a
      // WorkingDirectory under /home/<user> would leak the username).
      `wd=$(${show('WorkingDirectory')}); if [ -z "$wd" ] || [ "$wd" = "/" ]; then wd=$(readlink -f /proc/$pid/cwd 2>/dev/null); fi`,
      `store_bytes=$(du -sb "$wd/data" 2>/dev/null | awk '{print $1+0}'); [ -n "$store_bytes" ] || store_bytes=$(du -sb "$wd" 2>/dev/null | awk '{print $1+0}'); echo store_bytes=$store_bytes`,
      `echo journal_cursor=$(journalctl -u ${unit} -n 0 --show-cursor --no-pager 2>/dev/null | sed -n 's/^-- cursor: //p' | tail -1)`,
    );
  }
  parts.push('echo snapshot_complete=1');
  return parts.join('; ');
}
