#!/usr/bin/env node
/**
 * WM persistence regression repro
 * ===============================
 *
 * Reproduces the symptom called out in PR #602 / issue #596: WM (working-memory)
 * assertions written via /api/assertion/<name>/{create,write} sometimes do NOT
 * survive a daemon stop → start cycle. The script writes a parameterised pile
 * of triples into a throwaway context graph, snapshots the sub-graph counts,
 * cycles the daemon (clean SIGTERM via /api/shutdown OR hard SIGKILL on the
 * daemon PID), and diffs the counts to see what was lost.
 *
 * Strict isolation contract (see REPRO.md):
 *   - Runs against DKG_HOME / DKG_API_PORT only. Hard-refuses to talk to the
 *     default 9200 port so the kill cycle can never nuke the other agent's
 *     daemon on ~/.dkg-dev:9200.
 *   - Defaults to DKG_HOME=<repo-root>/.dkg-repro and DKG_API_PORT=54293 if
 *     neither env var nor CLI flag is set. Both defaults are still validated
 *     against the 9200 ban.
 *
 * Lifecycle modes:
 *   - --spawn (default true):     spawn a daemon child via the configured
 *                                 start command, wait for /api/status, then
 *                                 use the daemon PID file (and the harness-
 *                                 owned supervisor pgid) for kill cycles.
 *                                 REFUSES to reuse a pre-existing daemon at
 *                                 the configured port — if you want to keep
 *                                 your daemon up, clean-stop it first or use
 *                                 --no-spawn.
 *   - --no-spawn:                 assume the daemon is already running at
 *                                 DKG_API_PORT; use /api/shutdown for clean
 *                                 restarts. Incompatible with
 *                                 --restart-mode=kill and --matrix because
 *                                 the harness does not own the supervisor's
 *                                 process group and cannot SIGKILL it safely.
 *
 * Workload:
 *   - --num-assertions N (default 5)
 *   - --quads-per-assertion M (default 1000)
 *   - --quad-shape <code|generic> (default generic; "code" matches the shape
 *     used by .dkg/scripts/scan-code.mjs and PR #602's importer)
 *
 * Restart matrix:
 *   - --restart-mode clean|kill   (default clean)
 *   - --pause-ms <ms>             (delay between stop and restart; default 0)
 *   - --wait-for-exit-ms <ms>     (timeout the harness gives the daemon to
 *                                 exit before SIGKILL-falling-back; default
 *                                 300000 = 5min. Small/medium runs settle in
 *                                 seconds, but a 1M-quad WM flush can legitimately
 *                                 take minutes; lower this on fast disks to
 *                                 surface real hangs.)
 *   - --matrix                    run the full matrix
 *                                   (clean × kill) × (small/medium/large)
 *                                   × (pause=0 / pause=30000) and write a
 *                                 combined JSON report. Overrides the
 *                                 single-run knobs.
 *
 * Output:
 *   - --report <path>             write a JSON report (default:
 *                                 ./.dkg-repro-reports/<ts>.json under the
 *                                 worktree, never inside DKG_HOME).
 *   - --keep-cg                   keep the throwaway context graph (default).
 *                                 The V10 daemon has no context-graph delete
 *                                 endpoint; each run picks a fresh CG id, and
 *                                 the operator wipes state via `rm -rf
 *                                 $DKG_HOME/store.nq ...` (see REPRO.md).
 *
 * Usage examples:
 *   node scripts/repro/wm-persistence-regression.mjs           # single small run
 *   node scripts/repro/wm-persistence-regression.mjs --no-spawn # use existing daemon
 *   node scripts/repro/wm-persistence-regression.mjs --matrix   # full matrix
 *   node scripts/repro/wm-persistence-regression.mjs --num-assertions=50 --quads-per-assertion=10000 --restart-mode=kill
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// ─── arg parsing ───────────────────────────────────────────────────

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    out[m[1]] = m[2] === undefined ? 'true' : m[2];
  }
  return out;
}

const args = parseArgs();
const HOME_DIR = args.home ?? process.env.DKG_HOME ?? join(REPO_ROOT, '.dkg-repro');
const PORT = Number(args.port ?? process.env.DKG_API_PORT ?? 54293);
const SPAWN_DAEMON = args.spawn !== 'false' && args['no-spawn'] !== 'true';
const RESTART_MODE = args['restart-mode'] ?? 'clean';
const NUM_ASSERTIONS = Number(args['num-assertions'] ?? 5);
const QUADS_PER_ASSERTION = Number(args['quads-per-assertion'] ?? 1000);
const PAUSE_MS = Number(args['pause-ms'] ?? 0);
// 300s default — small/medium runs settle in seconds, but a 1M-quad WM
// flush during clean shutdown can legitimately spend several minutes.
// Operators on faster disks may lower this to surface real hangs.
const WAIT_FOR_EXIT_MS = Number(args['wait-for-exit-ms'] ?? 300_000);
const QUAD_SHAPE = args['quad-shape'] ?? 'generic';
const KEEP_CG = args['keep-cg'] === 'true';
const RUN_MATRIX = args.matrix === 'true';
const CG_ID_OVERRIDE = args['cg-id'] ?? null;
const SUBGRAPH = args.subgraph ?? 'repro';
// Default to the globally-installed `dkg` binary on PATH (npm-global install
// or symlink from the monorepo CLI). Override with --start-cmd if you've
// built the workspace and want to use the source tree's CLI directly.
const START_CMD = args['start-cmd'] ?? 'dkg start --foreground';
const REPORT_PATH = args.report ?? join(REPO_ROOT, '.dkg-repro-reports', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

// ─── safety ────────────────────────────────────────────────────────

if (PORT === 9200) {
  console.error(
    `\n[FATAL] DKG_API_PORT=${PORT} matches the default port used by the other agent's daemon ` +
    `(~/.dkg-dev). This script does kill -9 cycles and must never run against that daemon. ` +
    `Set DKG_API_PORT (or pass --port) to something else — REPRO.md proposes 54293.\n`,
  );
  process.exit(2);
}
if (!Number.isFinite(PORT) || PORT < 1024 || PORT > 65535) {
  console.error(`[FATAL] invalid port ${PORT}. Must be in [1024, 65535].`);
  process.exit(2);
}
if (!HOME_DIR) {
  console.error('[FATAL] DKG_HOME is empty.');
  process.exit(2);
}
// Resolve to a fully-resolved absolute path (including following symlinks
// on any ancestor that already exists). The earlier literal-string check
// (`HOME_DIR === '~/.dkg'`) only caught the bare tilde form — it accepted
// `/Users/aleatoric/.dkg`, `~/.dkg/`, symlinks to the default home, etc.,
// any of which would let the SIGKILL cycle target the operator's real node.
const HOME_ABS = ((dir) => {
  const absRaw = resolve(dir);
  let probe = absRaw;
  while (probe !== dirname(probe)) {
    if (existsSync(probe)) {
      try {
        const real = realpathSync(probe);
        return resolve(real, absRaw.slice(probe.length).replace(/^\//, ''));
      } catch { /* fall through to next ancestor */ }
    }
    probe = dirname(probe);
  }
  return absRaw;
})(HOME_DIR);
const FORBIDDEN_HOMES = (() => {
  const candidates = [join(homedir(), '.dkg'), join(homedir(), '.dkg-dev')];
  const out = new Set();
  for (const c of candidates) {
    out.add(resolve(c));
    if (existsSync(c)) {
      try { out.add(resolve(realpathSync(c))); } catch { /* ok */ }
    }
  }
  return out;
})();
for (const forbidden of FORBIDDEN_HOMES) {
  if (HOME_ABS === forbidden || HOME_ABS.startsWith(forbidden + '/')) {
    console.error(
      `[FATAL] DKG_HOME resolves to ${HOME_ABS}, which is inside or equal to ` +
      `a real DKG node home (${forbidden}). The script does kill -9 cycles and ` +
      `MUST run against a dedicated throwaway home — see REPRO.md.`,
    );
    process.exit(2);
  }
}

// ─── daemon helpers ────────────────────────────────────────────────

const API_BASE = `http://127.0.0.1:${PORT}`;

function log(...m) { console.log('[repro]', ...m); }
function warn(...m) { console.warn('[repro][warn]', ...m); }
function err(...m) { console.error('[repro][err]', ...m); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function readAuthToken() {
  const tokenPath = join(HOME_ABS, 'auth.token');
  if (!existsSync(tokenPath)) return null;
  try {
    const raw = await readFile(tokenPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t.length > 0 && !t.startsWith('#')) return t;
    }
  } catch { /* unreadable */ }
  return null;
}

async function readDaemonPid() {
  const p = join(HOME_ABS, 'daemon.pid');
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf-8');
    const n = Number(raw.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Return the pid that is currently listening on `port` according to `lsof`,
 * or null if lsof reports nothing (or is unavailable). This is the source
 * of truth for "is daemon.pid actually the daemon we think it is?" — bare
 * `process.kill(pid, 0)` only proves the pid exists, not that it owns the
 * port (which is the exact PID-reuse hazard Codex flagged).
 */
function listenerPidOnPort(port) {
  // `lsof -nP -i 4TCP:<port> -sTCP:LISTEN -t` prints just the listening pids.
  // Available on macOS by default and on most Linuxes; the harness already
  // assumes a POSIX-y env (spawn `dkg`, etc.) so this isn't a new dependency.
  let res;
  try {
    res = spawnSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN', '-t'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3_000,
    });
  } catch {
    return null;
  }
  if (!res || res.status !== 0) return null;
  const lines = String(res.stdout || '').trim().split(/\s+/).filter(Boolean);
  if (lines.length === 0) return null;
  const n = Number(lines[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function apiFetch(method, path, body) {
  const token = await readAuthToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
  if (!res.ok) {
    const e = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    e.status = res.status;
    e.body = parsed;
    throw e;
  }
  return parsed;
}

async function pingStatus(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${API_BASE}/api/status`, { method: 'GET' });
      // /api/status requires auth — a 401 is just as good a "daemon is up" signal as a 200.
      if (r.ok || r.status === 401) return true;
    } catch { /* not yet */ }
    await sleep(250);
  }
  return false;
}

async function ensureNoForeignDaemon() {
  // Reject if a daemon is responding at our port but we cannot prove it
  // belongs to HOME_ABS. The previous "pid file points at a live process"
  // check is unsafe under PID reuse — a stale pid file could happen to
  // match an unrelated long-running process (a shell, a watcher, …) and
  // the kill cycle would later SIGKILL it. The fix is to cross-reference
  // the pid that's actually listening on PORT.
  let healthy;
  try {
    const r = await fetch(`${API_BASE}/api/status`);
    healthy = r.ok || r.status === 401;
  } catch { healthy = false; }
  if (!healthy) return; // nothing listening — safe.

  const pidFile = await readDaemonPid();
  const listener = listenerPidOnPort(PORT);

  if (!pidFile) {
    throw new Error(
      `Port ${PORT} is occupied but ${join(HOME_ABS, 'daemon.pid')} does not exist. ` +
      `The harness cannot prove ownership of the listener — refusing to proceed. ` +
      `Either free port ${PORT}, or write the correct daemon.pid into ${HOME_ABS}.`,
    );
  }
  if (listener == null) {
    throw new Error(
      `Port ${PORT} appears occupied (HTTP responded) but \`lsof\` could not name the ` +
      `listener. The harness needs lsof to prove pid-vs-port ownership before it is ` +
      `allowed to SIGKILL anything. Install lsof or run the matrix on a machine that has it.`,
    );
  }
  if (listener !== pidFile) {
    throw new Error(
      `Port ${PORT} is owned by pid ${listener}, but ${join(HOME_ABS, 'daemon.pid')} ` +
      `says ${pidFile}. The pid file does NOT belong to the listener — refusing to ` +
      `proceed because killing pid ${pidFile} would not stop the daemon AND killing ` +
      `pid ${listener} would target a process the harness does not own.`,
    );
  }
  // pidFile === listener AND it's alive → our daemon.
}

let spawnedChild = null;
// The pid we will SIGKILL on a hard-restart. Recorded ONCE after spawn
// + pingStatus + listener cross-check so PID reuse between then and the
// kill cannot redirect us at an unrelated process. Same for the
// supervisor (spawnedChild) — that one we kill via its process group.
let expectedWorkerPid = null;
let expectedSupervisorPgid = null;

async function spawnDaemon() {
  log(`spawning daemon: ${START_CMD} (HOME=${HOME_ABS}, PORT=${PORT})`);
  const env = {
    ...process.env,
    DKG_HOME: HOME_ABS,
    DKG_API_PORT: String(PORT),
  };
  const [cmd, ...rest] = START_CMD.split(/\s+/);
  // detached: true puts the daemon (and its supervisor) into a NEW
  // process group whose pgid equals spawnedChild.pid. That lets us
  // signal the whole group atomically via `process.kill(-pgid, …)`
  // on hard restart — otherwise SIGKILLing the worker alone lets the
  // foreground supervisor respawn a fresh worker and the matrix would
  // measure the auto-restarted daemon instead of the one it killed.
  spawnedChild = spawn(cmd, rest, {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
  });
  spawnedChild.on('exit', (code, signal) => {
    log(`daemon child exited (code=${code}, signal=${signal})`);
    spawnedChild = null;
  });
  expectedSupervisorPgid = spawnedChild.pid;
  const ok = await pingStatus(120_000);
  if (!ok) throw new Error('daemon did not become responsive at /api/status within 120s');
  // Give the OS a tick to flush the spawned child's 'exit' event if it
  // died early (e.g. "Daemon already running, PID NNNN" — the new daemon
  // exits milliseconds after spawn but the event handler is async).
  // Without this sleep, the next check races and the matrix would
  // happily talk to a foreign/leftover daemon.
  await sleep(500);
  if (spawnedChild === null) {
    throw new Error(
      'spawned daemon exited before /api/status came up — a leftover daemon at ' +
      `port ${PORT} is serving the matrix's status probes. Run \`rm -rf ${HOME_ABS}\` ` +
      'and confirm no stray dkg processes are running.',
    );
  }
  // Then cross-check identity: daemon.pid must exist AND match the pid
  // actually listening on PORT, otherwise we cannot safely SIGKILL later.
  const workerPid = await readDaemonPid();
  const listener = listenerPidOnPort(PORT);
  if (!workerPid) {
    throw new Error(`spawn succeeded but ${join(HOME_ABS, 'daemon.pid')} is missing — refusing to continue without provable identity.`);
  }
  if (listener != null && listener !== workerPid) {
    throw new Error(
      `spawn succeeded but the listener on port ${PORT} (pid ${listener}) does not ` +
      `match daemon.pid (${workerPid}). Aborting — the harness will not trust an ` +
      `identity it cannot verify.`,
    );
  }
  expectedWorkerPid = workerPid;
  log(`daemon is up (worker=${expectedWorkerPid}, supervisor-pgid=${expectedSupervisorPgid}).`);
}

async function stopDaemonClean() {
  log('clean-stopping daemon via /api/shutdown ...');
  try {
    await apiFetch('POST', '/api/shutdown', {});
  } catch (e) {
    // The daemon kills itself ~100ms after responding 200 OK; the response
    // sometimes fails to read on a fast machine. Treat connection errors as success.
    warn(`shutdown returned ${e.message}; relying on PID death`);
  }
  await waitForDaemonExit({ timeoutMs: WAIT_FOR_EXIT_MS });
  expectedWorkerPid = null;
  expectedSupervisorPgid = null;
}

async function killDaemonHard() {
  // Re-verify identity at kill time, not just at spawn time, to defend
  // against PID reuse during a long matrix run. If daemon.pid drifted
  // from expectedWorkerPid (because the supervisor respawned without us
  // noticing, or someone hand-restarted the daemon), refuse.
  const pidFile = await readDaemonPid();
  const listener = listenerPidOnPort(PORT);
  if (expectedWorkerPid != null && pidFile != null && pidFile !== expectedWorkerPid) {
    throw new Error(
      `daemon.pid (${pidFile}) no longer matches the pid recorded at spawn ` +
      `(${expectedWorkerPid}). The supervisor may have respawned the worker or ` +
      `something else restarted the daemon — refusing to SIGKILL the new process.`,
    );
  }
  if (listener != null && pidFile != null && listener !== pidFile) {
    throw new Error(
      `Port ${PORT} is now owned by pid ${listener} but daemon.pid says ${pidFile}. ` +
      `Refusing the kill — see ensureNoForeignDaemon for the symmetric guard.`,
    );
  }
  const target = expectedWorkerPid ?? pidFile ?? listener;
  if (!target) {
    warn('no provable daemon pid to kill — skipping');
    return;
  }
  // 1) Kill the supervisor process group FIRST so it cannot respawn the
  //    worker once we kill it. `process.kill(-pgid, ...)` on a negative
  //    pid signals the entire group; we only have a valid pgid if the
  //    daemon was spawned by THIS harness (we did `detached: true`).
  if (expectedSupervisorPgid && isAlive(expectedSupervisorPgid)) {
    log(`SIGKILL supervisor process group (pgid=${expectedSupervisorPgid})`);
    try { process.kill(-expectedSupervisorPgid, 'SIGKILL'); }
    catch (e) {
      // Fall back to a per-pid kill if pgid signalling is unsupported.
      warn(`process-group kill failed (${e.message}); falling back to per-pid SIGKILL`);
      try { process.kill(expectedSupervisorPgid, 'SIGKILL'); } catch { /* */ }
    }
  }
  // 2) Belt-and-braces: SIGKILL the worker directly. If the supervisor
  //    is already gone the worker may have died too, but this is harmless.
  if (isAlive(target)) {
    log(`SIGKILL daemon worker pid=${target}`);
    try { process.kill(target, 'SIGKILL'); } catch (e) {
      warn(`kill -9 ${target} failed: ${e.message}`);
    }
  }
  await waitForDaemonExit({ timeoutMs: WAIT_FOR_EXIT_MS });
  // 3) After-kill assertion: port must be free AND the worker pid we
  //    targeted must be dead. If either is still up, fail loud.
  const stillListening = listenerPidOnPort(PORT);
  if (stillListening != null) {
    throw new Error(
      `after SIGKILL, port ${PORT} is still owned by pid ${stillListening}. ` +
      `The daemon (or a respawned worker) is still alive — abort.`,
    );
  }
  if (isAlive(target)) {
    throw new Error(`after SIGKILL, target pid ${target} is still alive. Abort.`);
  }
  // Reset state so the next spawnDaemon doesn't carry stale identity.
  expectedWorkerPid = null;
  expectedSupervisorPgid = null;
}

async function waitForDaemonExit({ timeoutMs } = {}) {
  // The shutdown sequence in packages/cli/src/daemon/lifecycle.ts calls
  // `server.close()` first (closes the HTTP port) and only then
  // `await agent.stop()` (which flushes WM to disk via OxigraphStore.close()).
  // For a 1M-quad WM the flush can take a few minutes on a laptop, so we
  // must NOT give up just because /api/status stops responding — the PID
  // is still alive and the daemon is busy doing the durable thing. The
  // default is 5 min; callers (stopDaemonClean / killDaemonHard) pass in
  // the operator-configurable WAIT_FOR_EXIT_MS.
  //
  // We can't rely on `process.kill(pid, 0)` alone for "is it gone yet"
  // because Node's spawn() reaps the child for us; the more reliable signal
  // is `spawnedChild` being nulled out by the 'exit' handler. And we
  // cross-check against the listener-on-port so that even if the pid file
  // disappeared the daemon is genuinely no longer serving traffic.
  const effectiveTimeout = timeoutMs ?? 300_000;
  const deadline = Date.now() + effectiveTimeout;
  while (Date.now() < deadline) {
    let alive = false;
    try { await fetch(`${API_BASE}/api/status`); alive = true; } catch { alive = false; }
    const pid = await readDaemonPid();
    const pidAlive = pid != null && isAlive(pid);
    const childGone = spawnedChild === null;
    const listener = listenerPidOnPort(PORT);
    if (!alive && !pidAlive && childGone && listener == null) {
      // HTTP, pid file, spawned-child handle, AND listener-on-port all
      // agree the daemon is gone. Give the OS another tick to clean up
      // port-bind state.
      await sleep(250);
      return;
    }
    await sleep(250);
  }
  // Timeout fallback: SIGKILL whatever's still hanging on so the next
  // matrix cell does not measure an auto-restarted or still-flushing
  // zombie. Codex flagged the previous warn-and-continue path as unsafe
  // (the snapshot could record false post-restart results); the
  // SIGKILL-then-confirm shape is the matrix-survivable equivalent.
  warn(
    `daemon did not exit cleanly within ${effectiveTimeout}ms — SIGKILLing it so the next ` +
    'matrix cell starts clean. (Loss attributed to THIS cell may include ' +
    'unflushed inserts; treat results with care.)',
  );
  const pid = await readDaemonPid();
  if (pid && isAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* */ }
  }
  if (spawnedChild?.pid && isAlive(spawnedChild.pid)) {
    try { process.kill(spawnedChild.pid, 'SIGKILL'); } catch { /* */ }
  }
  // Wait briefly for OS to release port + clean pid file.
  await sleep(2_000);
  // After-SIGKILL assertion: the port MUST be free or we have a real
  // ownership problem and downstream measurements are invalid.
  const finalListener = listenerPidOnPort(PORT);
  if (finalListener != null) {
    throw new Error(
      `even after SIGKILL fallback, port ${PORT} is still owned by pid ${finalListener}. ` +
      'Aborting the run rather than silently measuring a foreign daemon.',
    );
  }
}

// ─── workload ──────────────────────────────────────────────────────

function genQuads(assertionIdx, count, shape) {
  const out = new Array(count);
  if (shape === 'code') {
    // Mimic .dkg/scripts/scan-code.mjs: a "file" node + a handful of
    // edges + a "package" container. Each quad is one triple in the
    // /write payload (subGraphName is supplied at the request level).
    const owner = 'repro';
    const name = 'wm-persistence';
    for (let i = 0; i < count; i++) {
      const fileUri = `urn:dkg:code:file:${owner}/${name}/a${assertionIdx}/f${i}.ts`;
      // Cycle 5 different predicates so the quad set isn't all one shape.
      switch (i % 5) {
        case 0:
          out[i] = {
            subject: fileUri,
            predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
            object: 'http://dkg.io/ontology/code/File',
          };
          break;
        case 1:
          out[i] = {
            subject: fileUri,
            predicate: 'http://www.w3.org/2000/01/rdf-schema#label',
            object: `"f${i}.ts"`,
          };
          break;
        case 2:
          out[i] = {
            subject: fileUri,
            predicate: 'http://dkg.io/ontology/code/lineCount',
            object: `"${(i * 13) % 999}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
          };
          break;
        case 3:
          out[i] = {
            subject: fileUri,
            predicate: 'http://dkg.io/ontology/code/inPackage',
            object: `urn:dkg:code:package:${owner}/${name}/pkg-${(i >> 4) % 32}`,
          };
          break;
        case 4:
          out[i] = {
            subject: fileUri,
            predicate: 'http://purl.org/dc/terms/modified',
            object: `"2025-01-01T00:00:00Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>`,
          };
          break;
      }
    }
  } else {
    // Generic: one assertion -> count distinct subjects with a label + a payload.
    for (let i = 0; i < count; i++) {
      const subject = `urn:dkg:repro:wm:${assertionIdx}:${i}`;
      out[i] = {
        subject,
        predicate: 'http://www.w3.org/2000/01/rdf-schema#label',
        object: `"a${assertionIdx}-q${i}"`,
      };
    }
  }
  return out;
}

async function ensureContextGraph(cgId) {
  try {
    await apiFetch('POST', '/api/context-graph/create', {
      id: cgId,
      name: cgId,
      description: 'Throwaway repro CG for wm-persistence-regression',
    });
    log(`created CG ${cgId}`);
  } catch (e) {
    if (String(e.message).includes('already exists') || (e.body?.error && String(e.body.error).includes('already exists'))) {
      log(`CG ${cgId} already exists, reusing`);
    } else {
      throw e;
    }
  }
}

async function ensureSubGraph(cgId, name) {
  try {
    await apiFetch('POST', '/api/sub-graph/create', { contextGraphId: cgId, subGraphName: name });
  } catch (e) {
    if (!String(e.message).includes('already exists')) throw e;
  }
}

async function deleteCg(cgId) {
  // V10 daemon does not expose a context-graph/delete route; each repro run
  // gets a unique id so leftover CGs don't interfere across runs. Cleanup is
  // a manual operator step on the throwaway DKG_HOME (just `rm -rf` it).
  log(`skipping CG delete for ${cgId} (no daemon endpoint); rm -rf ${HOME_ABS} between matrix runs if needed`);
}

async function writeAssertionBatch(cgId, name, quads, subGraph) {
  // Create + write in two calls (mirrors the protocol importers use).
  // Some shapes prefer the one-shot /create with quads; we use the explicit
  // two-call shape since that's what PR #602's failing path used.
  await apiFetch('POST', '/api/assertion/create', {
    contextGraphId: cgId,
    name,
    subGraphName: subGraph,
  });
  // Chunk writes to keep individual requests under the JSON body limit.
  const CHUNK = 5000;
  for (let i = 0; i < quads.length; i += CHUNK) {
    const batch = quads.slice(i, i + CHUNK);
    await apiFetch('POST', `/api/assertion/${encodeURIComponent(name)}/write`, {
      contextGraphId: cgId,
      quads: batch,
      subGraphName: subGraph,
    });
  }
}

async function snapshotCounts(cgId, subGraph) {
  // Two probes:
  //   (a) /api/sub-graph/list — same shape the UI uses, gives sub-graph-level totals.
  //   (b) raw COUNT(*) SPARQL over every named graph that belongs to <cgId>/<subGraph>/...
  let viaList = null;
  try {
    const list = await apiFetch('GET', `/api/sub-graph/list?contextGraphId=${encodeURIComponent(cgId)}`);
    const entry = (list?.subGraphs ?? []).find((sg) => sg.name === subGraph);
    viaList = entry ? { entityCount: entry.entityCount, tripleCount: entry.tripleCount } : null;
  } catch (e) {
    warn(`sub-graph/list probe failed: ${e.message}`);
  }

  // The /api/query endpoint already scopes the query to <cgId>. Sum every
  // graph in the response so we don't depend on the on-disk URI shape (which
  // is `did:dkg:context-graph:<cg>/<subgraph>/...` for bare-id CGs but
  // `did:dkg:context-graph:<wallet>/<cg>/<subgraph>/...` for wallet-scoped
  // ones). Bucket per-graph entries so the per-assertion view still works.
  //
  // Pass `view: 'working-memory'` explicitly: the daemon's default routing
  // when no view is supplied is "everything visible to the caller", which on
  // a fresh node can include only finalized/promoted graphs and miss WM
  // assertions for an auth-disabled / node-level caller — exactly the case
  // we're trying to measure here.
  let viaSparql = null;
  let perAssertion = null;
  try {
    const sparql = `
      SELECT ?g (COUNT(*) AS ?triples) WHERE {
        GRAPH ?g { ?s ?p ?o }
      } GROUP BY ?g
    `;
    // No `view` passed: the daemon defaults to its "everything visible to the
    // caller" view, which on a single-node auth-disabled daemon includes WM.
    // /api/sub-graph/list uses the same shape and we know that one finds the
    // WM graphs.
    const response = await apiFetch('POST', '/api/query', {
      sparql,
      contextGraphId: cgId,
    });
    // /api/query wraps the SPARQL result in { result, phases } — the
    // bindings live at response.result.bindings, not response.bindings.
    const result = response?.result ?? response;
    // /api/query intentionally returns every named graph the caller can see,
    // regardless of `contextGraphId`. We filter to graphs that belong to
    // THIS cgId so prior repro runs in the same DKG_HOME don't inflate the
    // count. Wallet-scoped CGs surface as
    //   did:dkg:context-graph:<wallet>/<cgId>/...
    // and bare ids as
    //   did:dkg:context-graph:<cgId>/...
    // — `:cgId/` matches the bare form, `/cgId/` matches the wallet form.
    const wantsCg = (g) =>
      g && (g.includes(`:${cgId}/`) || g.includes(`/${cgId}/`));
    const subGraphSegment = `/${subGraph}/`;
    let total = 0;
    const assertions = [];
    const allGraphs = [];
    for (const row of result?.bindings ?? []) {
      const g = typeof row.g === 'string' ? row.g : row.g?.value;
      const tv = row.triples;
      const ts = typeof tv === 'string' ? tv : tv?.value ?? '';
      const m = String(ts).match(/^"?(\d+)/);
      const triples = m ? Number(m[1]) : 0;
      if (wantsCg(g)) {
        allGraphs.push({ g, triples });
        if (g.includes(subGraphSegment)) {
          total += triples;
          if (g.includes('/assertion/')) {
            assertions.push({ g, triples });
          }
        }
      }
    }
    viaSparql = { triples: total, allGraphs };
    perAssertion = assertions;
  } catch (e) {
    warn(`SPARQL count probe failed: ${e.message}`);
  }

  return { viaList, viaSparql, perAssertion };
}

// ─── single run ────────────────────────────────────────────────────

async function ensureWalletScope() {
  // listContextGraphs is wallet-scoped, but /api/context-graph/create accepts
  // either a bare id or a wallet-scoped one. We use a bare slug for the throwaway
  // CG since the repro doesn't need wallet semantics; the daemon happily reads
  // and writes under that id. (See scripts/lib/dkg-daemon.mjs for the "phantom"
  // discussion — we're intentionally hitting the phantom path here because it's
  // the same write path PR #602's importer used.)
  return null;
}

async function runOnce(spec) {
  const startTs = Date.now();
  const cgId = CG_ID_OVERRIDE ?? `repro-wm-persistence-${startTs.toString(36)}`;
  log(`run: cg=${cgId} N=${spec.numAssertions} M=${spec.quadsPerAssertion} restart=${spec.restartMode} pause=${spec.pauseMs}ms shape=${spec.quadShape}`);

  await ensureWalletScope();
  await ensureContextGraph(cgId);
  await ensureSubGraph(cgId, SUBGRAPH);

  const writeStart = Date.now();
  const assertionNames = [];
  for (let i = 0; i < spec.numAssertions; i++) {
    const name = `repro-${i.toString().padStart(4, '0')}`;
    assertionNames.push(name);
    const quads = genQuads(i, spec.quadsPerAssertion, spec.quadShape);
    await writeAssertionBatch(cgId, name, quads, SUBGRAPH);
    if ((i + 1) % 10 === 0 || i === spec.numAssertions - 1) {
      log(`  wrote ${i + 1}/${spec.numAssertions} assertions`);
    }
  }
  const writeMs = Date.now() - writeStart;

  // Force the storage worker to flush its outstanding work before we measure.
  await sleep(500);

  const preStop = await snapshotCounts(cgId, SUBGRAPH);
  log(`pre-stop: triples=${preStop.viaSparql?.triples ?? '?'} (list: entities=${preStop.viaList?.entityCount ?? '?'}, triples=${preStop.viaList?.tripleCount ?? '?'}, assertions=${preStop.perAssertion?.length ?? '?'})`);

  // Restart cycle ---------------------------------------------------
  const stopStart = Date.now();
  if (spec.restartMode === 'clean') {
    await stopDaemonClean();
  } else if (spec.restartMode === 'kill') {
    await killDaemonHard();
  } else {
    throw new Error(`unknown restart-mode: ${spec.restartMode}`);
  }
  const stopMs = Date.now() - stopStart;

  if (spec.pauseMs > 0) {
    log(`pause ${spec.pauseMs}ms before restart`);
    await sleep(spec.pauseMs);
  }

  const restartStart = Date.now();
  if (SPAWN_DAEMON) {
    await spawnDaemon();
  } else {
    warn('--no-spawn: waiting for operator to restart the daemon ...');
    const ok = await pingStatus(300_000);
    if (!ok) throw new Error('daemon did not come back within 300s (--no-spawn)');
  }
  const restartMs = Date.now() - restartStart;

  // Give the index time to re-open and any post-load fsync to settle.
  await sleep(1000);

  const postStart = await snapshotCounts(cgId, SUBGRAPH);
  log(`post-restart: triples=${postStart.viaSparql?.triples ?? '?'} (list: entities=${postStart.viaList?.entityCount ?? '?'}, triples=${postStart.viaList?.tripleCount ?? '?'}, assertions=${postStart.perAssertion?.length ?? '?'})`);

  const expected = spec.numAssertions * spec.quadsPerAssertion;
  const observedPre = preStop.viaSparql?.triples ?? null;
  const observedPost = postStart.viaSparql?.triples ?? null;
  const lostTriples = observedPre != null && observedPost != null ? observedPre - observedPost : null;
  const failed = observedPre != null && observedPost != null && observedPost < observedPre;

  if (!KEEP_CG) {
    await deleteCg(cgId);
  }

  return {
    spec,
    cgId,
    subGraph: SUBGRAPH,
    expectedTriples: expected,
    preStop,
    postStart,
    lostTriples,
    failed,
    timings: { writeMs, stopMs, restartMs, totalMs: Date.now() - startTs },
  };
}

// ─── matrix ────────────────────────────────────────────────────────

function matrixSpecs() {
  const sizes = [
    { numAssertions: 5, quadsPerAssertion: 1000, tag: 'small' },           // 5k
    { numAssertions: 25, quadsPerAssertion: 5000, tag: 'medium' },         // 125k
    { numAssertions: 50, quadsPerAssertion: 20000, tag: 'large' },         // 1M (heavy)
  ];
  const restartModes = ['clean', 'kill'];
  const pauses = [0, 30_000];
  const out = [];
  for (const m of restartModes) {
    for (const p of pauses) {
      for (const s of sizes) {
        out.push({
          tag: `${s.tag}-${m}-pause${p}`,
          numAssertions: s.numAssertions,
          quadsPerAssertion: s.quadsPerAssertion,
          quadShape: QUAD_SHAPE,
          restartMode: m,
          pauseMs: p,
        });
      }
    }
  }
  return out;
}

// ─── main ──────────────────────────────────────────────────────────

async function main() {
  log(`HOME=${HOME_ABS}`);
  log(`PORT=${PORT}`);
  log(`SPAWN_DAEMON=${SPAWN_DAEMON}`);

  await ensureNoForeignDaemon();

  if (SPAWN_DAEMON) {
    const pid = await readDaemonPid();
    if (pid && isAlive(pid)) {
      // A pre-existing daemon at our port was passing the
      // ensureNoForeignDaemon() listener-pid cross-check (so it's
      // "ours" in the HOME-ABS sense), but we did NOT spawn it
      // ourselves and therefore do NOT know its supervisor pgid.
      // If we then run --restart-mode=kill, killDaemonHard() would
      // SIGKILL just the worker; if the daemon was started under
      // `dkg start --foreground`, the supervisor would respawn a
      // fresh worker and the matrix would silently measure the
      // restart instead of the kill. Refuse rather than measure
      // garbage.
      throw new Error(
        `daemon pid ${pid} is already running at port ${PORT} but was not spawned by this harness. ` +
        `Running the kill cycle against a daemon whose supervisor we don't own would let a ` +
        `\`dkg start --foreground\` supervisor respawn it mid-test and silently produce wrong results. ` +
        `Either: (a) clean-stop it first via \`curl -X POST .../api/shutdown\` and re-run; ` +
        `(b) re-run with --no-spawn --restart-mode=clean (kill mode is unsafe without a known pgid).`,
      );
    }
    await spawnDaemon();
  } else {
    const ok = await pingStatus(5_000);
    if (!ok) throw new Error(`--no-spawn but daemon at ${API_BASE} is not responding`);
    // In --no-spawn mode the harness does not own the supervisor, so it
    // cannot kill the process group atomically. Reject kill mode + the
    // matrix (which exercises kill cells) to avoid the supervisor-respawn
    // confound. clean-mode (/api/shutdown) is fine: the daemon shuts down
    // its own supervisor.
    if (RESTART_MODE === 'kill' || RUN_MATRIX) {
      throw new Error(
        `--no-spawn is incompatible with restart-mode=kill / --matrix. ` +
        `The harness needs the supervisor's pgid (set via the harness's own \`detached: true\` spawn) ` +
        `to kill the whole process group; a daemon started outside this harness cannot be safely SIGKILLed. ` +
        `Use --restart-mode=clean with --no-spawn, or drop --no-spawn for kill / --matrix runs.`,
      );
    }
    log('using pre-existing daemon (clean-restart mode only)');
  }

  // Verify the auth token can be read; many endpoints require it.
  const token = await readAuthToken();
  if (!token) {
    warn(`no auth.token found under ${HOME_ABS}. If auth is enabled on this daemon, write operations will 401.`);
  }

  const runs = [];

  if (RUN_MATRIX) {
    const specs = matrixSpecs();
    log(`running matrix: ${specs.length} runs`);
    for (const spec of specs) {
      try {
        const r = await runOnce(spec);
        runs.push({ tag: spec.tag, ok: true, ...r });
        log(`  matrix run ${spec.tag}: ${r.failed ? 'FAILED' : 'ok'} (lost=${r.lostTriples})`);
      } catch (e) {
        warn(`matrix run ${spec.tag} threw: ${e.message}`);
        runs.push({ tag: spec.tag, ok: false, error: e.message });
      }
    }
  } else {
    const spec = {
      tag: 'single',
      numAssertions: NUM_ASSERTIONS,
      quadsPerAssertion: QUADS_PER_ASSERTION,
      quadShape: QUAD_SHAPE,
      restartMode: RESTART_MODE,
      pauseMs: PAUSE_MS,
    };
    const r = await runOnce(spec);
    runs.push({ tag: 'single', ok: true, ...r });
  }

  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    home: HOME_ABS,
    port: PORT,
    spawnedDaemon: SPAWN_DAEMON,
    runs,
  };

  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  log(`report written to ${REPORT_PATH}`);

  const failures = runs.filter((r) => r.failed || !r.ok);
  if (failures.length > 0) {
    log(`SUMMARY: ${failures.length}/${runs.length} run(s) reproduced the regression`);
    process.exitCode = 1;
  } else {
    log(`SUMMARY: 0/${runs.length} runs reproduced the regression`);
  }

  // Clean up child if we own it.
  if (spawnedChild && spawnedChild.pid && isAlive(spawnedChild.pid)) {
    log('terminating spawned daemon child ...');
    try { process.kill(spawnedChild.pid, 'SIGTERM'); } catch { /* */ }
  }
}

main().catch((e) => {
  err(e.stack ?? e.message);
  if (spawnedChild && spawnedChild.pid && isAlive(spawnedChild.pid)) {
    try { process.kill(spawnedChild.pid, 'SIGTERM'); } catch { /* */ }
  }
  process.exit(1);
});
