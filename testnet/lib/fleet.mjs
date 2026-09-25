// OT-RFC-61 §9 — fleet snapshots, build-identity attestation, journal signature ledger.
// Depends on lib/ssh.mjs (transport) and fetch for the public /api/status.
// S6: every record produced here carries ONLY the fleet.json alias — no host,
// IP, ssh user, or key path; error strings are scrubbed of target references.

import { readFileSync } from 'node:fs';
import { sshExec, mapLimit, parseKvOutput, snapshotCommand, unitFullName } from './ssh.mjs';

/** journald cursor charset (rfc59): safe inside a single-quoted remote arg. */
export const JOURNAL_CURSOR_RE = /^[A-Za-z0-9_:;=.\-]+$/;

const LIGHT_SSH_TIMEOUT_MS = 20_000;
const FULL_SSH_TIMEOUT_MS = 70_000;
const STATUS_TIMEOUT_MS = 5_000;
const SIDECAR_CAP_BYTES = 65_536;

function intOrNull(v) {
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

function floatOrNull(v) {
  const n = Number.parseFloat(String(v ?? '').trim());
  return Number.isFinite(n) ? n : null;
}

/** systemd-style limits: 'max'/'infinity'/'[not set]'/'' -> null. */
function limitOrNull(v) {
  const t = String(v ?? '').trim().toLowerCase();
  if (!t || t === 'max' || t === 'infinity' || t === '[not set]') return null;
  return intOrNull(t);
}

function numOrNull(v) {
  const n = Number(v);
  return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? (Number.isFinite(n) ? n : null) : null;
}

/**
 * Remove target-identifying strings (host, ssh user, identity path) from a
 * transport error message so it can travel in main-stream evidence (S6).
 * Extra exported helper (not part of the frozen contract).
 * @param {string} text @param {object} core
 */
export function scrubTargetRefs(text, core) {
  let out = String(text ?? '');
  for (const needle of [core?.host, core?.sshUser, core?.sshIdentity]) {
    if (needle) out = out.split(String(needle)).join('[redacted]');
  }
  return out.length > 400 ? `${out.slice(0, 400)}...` : out;
}

function sshTarget(core) {
  return { host: core.host, sshUser: core.sshUser, sshIdentity: core.sshIdentity };
}

async function fetchStatus(core, fetchImpl, timeoutMs) {
  if (!core.apiPort) return { reachable: false, error: 'no_api_port' };
  try {
    const res = await fetchImpl(`http://${core.host}:${core.apiPort}/api/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { reachable: false, error: `http_${res.status}` };
    const body = await res.json();
    return { reachable: true, body: body && typeof body === 'object' ? body : {} };
  } catch (err) {
    const name = err?.name;
    if (name === 'TimeoutError' || name === 'AbortError') return { reachable: false, error: 'status_timeout' };
    const cause = err?.cause?.message ? `: ${err.cause.message}` : '';
    return { reachable: false, error: `${String(err?.message ?? err)}${cause}` };
  }
}

/** Defensive extraction of admission/chain counters from /api/status JSON. */
function apiCounters(status) {
  const adm = status?.admission;
  const chain = status?.chain;
  return {
    admissionRejected: numOrNull(adm?.rejected ?? adm?.rejectedTotal ?? adm?.rejectedCount ?? adm?.shed),
    rpcFailovers: numOrNull(chain?.rpcFailovers ?? status?.rpcFailovers),
    rpcExhaustions: numOrNull(chain?.rpcExhaustions ?? status?.rpcExhaustions),
  };
}

/**
 * Light or full snapshot of one core. Combines the SSH k=v snapshot with the
 * public HTTP /api/status (no auth; carries commit/buildTime/version + admission
 * + chain rpc counters). NEVER throws — unreachable => {alias, reachable:false}.
 * Returned record uses ONLY the alias (no host/IP — S6). Shape mirrors
 * schema/EVIDENCE.md `fleet_snapshot` per-core entry.
 * @param {object} core fleet.json core entry
 * @param {{light?: boolean, connectTimeoutSec?: number}} [opts]
 *   Optional extras: _sshExec/_fetch (injectable for tests), sshTimeoutMs,
 *   statusTimeoutMs.
 */
export async function snapshotCore(core, opts = {}) {
  const light = Boolean(opts.light);
  const alias = core?.alias ?? 'unknown';
  try {
    const exec = opts._sshExec ?? sshExec;
    const fetchImpl = opts._fetch ?? globalThis.fetch;
    const cmd = snapshotCommand(core, { light });
    const [sshRes, apiRes] = await Promise.all([
      exec(sshTarget(core), cmd, {
        timeoutMs: opts.sshTimeoutMs ?? (light ? LIGHT_SSH_TIMEOUT_MS : FULL_SSH_TIMEOUT_MS),
        connectTimeoutSec: opts.connectTimeoutSec ?? 8,
      }),
      fetchStatus(core, fetchImpl, opts.statusTimeoutMs ?? STATUS_TIMEOUT_MS),
    ]);
    const sshOk = Boolean(sshRes?.ok);
    const kv = sshOk ? parseKvOutput(sshRes.stdout) : {};
    const status = apiRes.reachable ? apiRes.body : {};
    const workerRssKb = intOrNull(kv.worker_rss_kb);
    const mainRssKb = intOrNull(kv.main_rss_kb);
    const usedPct = intOrNull(kv.disk_used_pct);
    const record = {
      alias,
      kind: light ? 'light' : 'full',
      ts: new Date().toISOString(),
      // A core is "reachable" for §3.3 purposes only when both observation
      // transports answered: the SSH snapshot AND the public /api/status.
      reachable: sshOk && apiRes.reachable,
      transport: { ssh: sshOk, api: apiRes.reachable },
      systemd: sshOk ? {
        activeState: kv.active_state || null,
        subState: kv.sub_state || null,
        execMainStartTs: kv.exec_main_start || null,
        nRestarts: intOrNull(kv.n_restarts),
        mainPid: intOrNull(kv.main_pid),
      } : null,
      workerPid: sshOk ? intOrNull(kv.worker_pid) : null,
      build: apiRes.reachable ? {
        commit: status.commit ?? status.commitShort ?? status.build?.commit ?? null,
        buildTime: status.buildTime ?? status.build?.time ?? null,
        version: status.version ?? null,
      } : null,
      // rss is BYTES (ps reports KiB; converted here) — cgroup fields and the
      // monitor formatter all speak bytes, so the snapshot does too.
      rss: (workerRssKb ?? mainRssKb) === null ? null : (workerRssKb ?? mainRssKb) * 1024,
      rssDetail: sshOk ? { mainKb: mainRssKb, workerKb: workerRssKb } : null,
      cgroup: sshOk ? {
        memoryCurrent: intOrNull(kv.memory_current),
        memoryPeak: intOrNull(kv.memory_peak),
        memoryHigh: limitOrNull(kv.memory_high),
        memoryMax: limitOrNull(kv.memory_max),
        oomKills: intOrNull(kv.oom_kills) ?? 0,
        psiSomeAvg10: floatOrNull(kv.psi_some_avg10),
      } : null,
      listen: sshOk ? {
        recvQ: intOrNull(kv.listen_recvq),
        backlog: intOrNull(kv.listen_backlog),
        connectProbeOk: kv.probe_ok === '1',
      } : null,
      diskFree: sshOk ? {
        bytes: intOrNull(kv.disk_avail_bytes),
        fraction: usedPct === null ? null : (100 - usedPct) / 100,
      } : null,
      api: { reachable: apiRes.reachable, ...apiCounters(status) },
    };
    if (!light && sshOk) {
      record.storeBytes = intOrNull(kv.store_bytes);
      record.journalCursor = kv.journal_cursor || null;
    }
    if (sshOk && kv.snapshot_complete !== '1') record.snapshotTruncated = true;
    if (!record.reachable) {
      const parts = [];
      if (!sshOk) {
        parts.push(sshRes?.timedOut
          ? 'ssh_timeout'
          : `ssh_failed(code=${sshRes?.code ?? 'null'})${sshRes?.stderr ? `: ${sshRes.stderr.slice(0, 200)}` : ''}`);
      }
      if (!apiRes.reachable) parts.push(`api_status: ${apiRes.error}`);
      record.error = scrubTargetRefs(parts.join('; '), core);
    }
    return record;
  } catch (err) {
    return { alias, reachable: false, error: scrubTargetRefs(String(err?.message ?? err), core) };
  }
}

/**
 * Snapshot all cores with bounded concurrency. Returns {ts, kind, cores: [...]}.
 * @param {object} fleet @param {{light?: boolean}} [opts]
 */
export async function snapshotFleet(fleet, opts = {}) {
  const cores = fleet?.cores ?? [];
  const perCore = { connectTimeoutSec: fleet?.sshConnectTimeoutSec, ...opts };
  const results = await mapLimit(cores, fleet?.sshConcurrency ?? 2, (core) => snapshotCore(core, perCore));
  return { ts: new Date().toISOString(), kind: opts.light ? 'light' : 'full', cores: results };
}

/**
 * Build-identity attestation (RFC-61 §3.1, review r1): identity is the
 * daemon-reported embedded commit/buildTime from /api/status, bound to worker
 * MainPID + ExecMainStartTimestamp from the same snapshot pass. Returns
 * {alias, commit, buildTime, workerPid, workerStartTs, attested: boolean,
 *  inconclusiveReason?: string}. Unknown/missing commit => attested:false.
 * @param {object} snapshotCoreResult
 */
export function attestBuildIdentity(snapshotCoreResult) {
  const s = snapshotCoreResult;
  const out = {
    alias: s?.alias ?? null,
    commit: s?.build?.commit ?? null,
    buildTime: s?.build?.buildTime ?? null,
    workerPid: s?.workerPid ?? s?.systemd?.mainPid ?? null,
    workerStartTs: s?.systemd?.execMainStartTs ?? null,
    attested: false,
  };
  if (!s || s.reachable !== true) return { ...out, inconclusiveReason: 'core_unreachable' };
  const commitText = String(out.commit ?? '').trim();
  if (!commitText || /^(unknown|null|undefined|none)$/i.test(commitText)) {
    return { ...out, inconclusiveReason: 'missing_build_identity' };
  }
  if (/dirty/i.test(commitText)) return { ...out, inconclusiveReason: 'dirty_build_identity' };
  if (!out.workerPid || !out.workerStartTs) return { ...out, inconclusiveReason: 'missing_process_binding' };
  return { ...out, attested: true };
}

/**
 * True when two attestations describe the SAME running artifact (commit equal,
 * pid equal, start ts equal). Used to detect mid-run SHA changes (§3.1: a
 * change invalidates all network-dependent SLIs).
 */
export function sameArtifact(a, b) {
  if (!a?.attested || !b?.attested) return false;
  if (a.alias != null && b.alias != null && a.alias !== b.alias) return false;
  return a.commit === b.commit && a.workerPid === b.workerPid && a.workerStartTs === b.workerStartTs;
}

/**
 * Capture per-core journal cursors (full snapshot includes them). Returns
 * {alias, cursor, valid}.
 * @param {object} fleet
 * @param {{_sshExec?: Function, timeoutMs?: number, connectTimeoutSec?: number}} [opts]
 */
export async function captureJournalCursors(fleet, opts = {}) {
  const exec = opts._sshExec ?? sshExec;
  return mapLimit(fleet?.cores ?? [], fleet?.sshConcurrency ?? 2, async (core) => {
    const unit = unitFullName(core.systemdUnit);
    const res = await exec(
      sshTarget(core),
      `journalctl -u ${unit} -n 0 --show-cursor --no-pager 2>/dev/null`,
      {
        timeoutMs: opts.timeoutMs ?? LIGHT_SSH_TIMEOUT_MS,
        connectTimeoutSec: opts.connectTimeoutSec ?? fleet?.sshConnectTimeoutSec ?? 8,
      },
    );
    const m = res?.ok ? String(res.stdout).match(/^-- cursor: (.+)$/m) : null;
    const cursor = m ? m[1].trim() : null;
    return { alias: core.alias, cursor, valid: Boolean(cursor && JOURNAL_CURSOR_RE.test(cursor)) };
  });
}

/**
 * Compose the single-pass awk program that counts every ledger class into a
 * per-class variable and prints `sig_<id>=<n>` lines. One journal read, one
 * regex test per class per line, against the lowercased line — semantics kept
 * identical to signatureCountsFromText (a test asserts awk/JS parity).
 * Extra exported helper (not part of the frozen contract).
 * @param {object} ledger validated ledger
 */
export function composeSignatureAwk(ledger) {
  const inits = ledger.classes.map((_, i) => `c${i}=0`).join('; ');
  const body = ledger.classes.map((cls, i) => `if (l ~ /${cls.pattern}/) c${i}++`);
  const prints = ledger.classes.map((cls, i) => `print "sig_${cls.id}=" c${i}`).join('; ');
  return [`BEGIN { ${inits} }`, '{ l=tolower($0)', ...body, '}', `END { ${prints} }`].join('; ');
}

/**
 * Local JS twin of the remote awk pass: count ledger classes per line over
 * lowercased text. Used by tests and for local (edge) log deltas.
 * Extra exported helper (not part of the frozen contract).
 * @param {string} text @param {object} ledger
 * @returns {Record<string, number>}
 */
export function signatureCountsFromText(text, ledger) {
  validateLedger(ledger);
  const matchers = ledger.classes.map((cls) => ({ id: cls.id, re: new RegExp(cls.pattern) }));
  const counts = Object.fromEntries(ledger.classes.map((cls) => [cls.id, 0]));
  for (const raw of String(text ?? '').split('\n')) {
    if (!raw) continue;
    const line = raw.toLowerCase();
    for (const { id, re } of matchers) if (re.test(line)) counts[id] += 1;
  }
  return counts;
}

/**
 * Count forbidden-signature classes strictly after per-core cursors
 * (`journalctl -u <unit> --after-cursor=<c> -o cat` piped to a single awk/grep
 * program composed from ledger.json). Exit status checked: a vacuumed/invalid
 * cursor yields {cursorValid:false} and the caller scores INCONCLUSIVE — never
 * silent zeroes (§9.2). Raw matched lines go to the sidecar via the provided
 * callback, never returned in counts.
 * @param {object} fleet
 * @param {Array<{alias: string, cursor: string}>} cursors
 * @param {{ledger: object, sidecar?: (alias: string, lines: string[]) => void}} opts
 *   Optional extras: _sshExec (injectable for tests), timeoutMs.
 * @returns {Promise<Array<{alias, cursorValid, counts: Record<string, number>, gatedTotal, recordedTotal}>>}
 */
export async function journalSignatureDeltas(fleet, cursors, opts) {
  const { ledger, sidecar, _sshExec, timeoutMs = 45_000 } = opts ?? {};
  validateLedger(ledger);
  const exec = _sshExec ?? sshExec;
  const byAlias = new Map((fleet?.cores ?? []).map((core) => [core.alias, core]));
  const awk = composeSignatureAwk(ledger);
  return mapLimit(cursors ?? [], fleet?.sshConcurrency ?? 2, async (entry) => {
    const alias = entry?.alias ?? 'unknown';
    // Totals are null (never zero) whenever counting could not run — silent
    // zeroes are exactly what §9.2 forbids.
    const inconclusive = (error) => ({
      alias, cursorValid: false, counts: {}, gatedTotal: null, recordedTotal: null,
      ledgerVersion: ledger.version, error,
    });
    const core = byAlias.get(alias);
    if (!core) return inconclusive('unknown_alias');
    const cursor = entry?.cursor;
    if (!cursor || !JOURNAL_CURSOR_RE.test(cursor)) return inconclusive('missing_or_invalid_journal_cursor');
    const unit = unitFullName(core.systemdUnit);
    const execOpts = { timeoutMs, connectTimeoutSec: fleet?.sshConnectTimeoutSec ?? 8 };
    // Capture journalctl before piping so a stale/vacuumed cursor cannot be
    // converted into an apparently clean set of awk zeroes (rfc59 mechanic).
    const remote =
      `logs=$(journalctl -u ${unit} --after-cursor='${cursor}' --no-pager -o cat 2>&1); ` +
      'journal_status=$?; echo journal_status=$journal_status; ' +
      'if [ "$journal_status" -ne 0 ]; then echo cursor_valid=0; ' +
      `else echo cursor_valid=1; printf '%s\\n' "$logs" | awk '${awk}'; fi`;
    const res = await exec(sshTarget(core), remote, execOpts);
    if (!res?.ok) return inconclusive(res?.timedOut ? 'ssh_timeout' : 'ssh_failed');
    const kv = parseKvOutput(res.stdout);
    if (kv.cursor_valid !== '1') return inconclusive('cursor_vacuumed_or_invalid');
    const counts = {};
    for (const cls of ledger.classes) {
      const n = Number.parseInt(kv[`sig_${cls.id}`] ?? '', 10);
      // A missing/garbled per-class count is ledger or transport breakage —
      // INCONCLUSIVE, never a zero (§9.2 wording-drift rule).
      if (!Number.isFinite(n)) return inconclusive('signature_output_incomplete');
      counts[cls.id] = n;
    }
    let gatedTotal = 0;
    let recordedTotal = 0;
    for (const cls of ledger.classes) {
      if (cls.disposition === 'gated') gatedTotal += counts[cls.id];
      else recordedTotal += counts[cls.id];
    }
    if (sidecar && gatedTotal + recordedTotal > 0) {
      // Second, capped pass ONLY when a sidecar wants raw lines. Matched text
      // never enters the main-stream record (S6).
      const combined = ledger.classes.map((cls) => `(${cls.pattern})`).join('|');
      const rawRes = await exec(
        sshTarget(core),
        `journalctl -u ${unit} --after-cursor='${cursor}' --no-pager -o cat 2>/dev/null | ` +
        `grep -iE '${combined}' | head -c ${SIDECAR_CAP_BYTES}`,
        execOpts,
      );
      if (rawRes?.ok) {
        const lines = String(rawRes.stdout).split('\n').filter((l) => l.trim().length > 0);
        try { sidecar(alias, lines); } catch { /* sidecar failures never poison counts */ }
      }
    }
    return { alias, cursorValid: true, counts, gatedTotal, recordedTotal, ledgerVersion: ledger.version };
  });
}

/**
 * Validate a parsed ledger object (shape per loadLedger). Throws with a list
 * of problems. Extra exported helper (not part of the frozen contract).
 * @param {object} ledger @param {string} [label]
 */
export function validateLedger(ledger, label = 'ledger') {
  const problems = [];
  if (!ledger || typeof ledger !== 'object') {
    problems.push('not an object');
  } else {
    if (!Number.isInteger(ledger.version) || ledger.version < 1) problems.push('version must be an integer >= 1');
    if (!Array.isArray(ledger.classes) || ledger.classes.length === 0) {
      problems.push('classes must be a non-empty array');
    } else {
      const seen = new Set();
      ledger.classes.forEach((cls, i) => {
        const where = `classes[${i}]`;
        if (!cls || typeof cls !== 'object') { problems.push(`${where}: not an object`); return; }
        if (typeof cls.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(cls.id)) {
          problems.push(`${where}: id must match /^[a-z][a-z0-9_]*$/`);
        } else if (seen.has(cls.id)) {
          problems.push(`${where}: duplicate id ${cls.id}`);
        } else {
          seen.add(cls.id);
        }
        if (cls.disposition !== 'gated' && cls.disposition !== 'recorded') {
          problems.push(`${where}: disposition must be 'gated' or 'recorded'`);
        }
        if (typeof cls.description !== 'string' || cls.description.trim().length === 0) {
          problems.push(`${where}: description required`);
        }
        if (typeof cls.pattern !== 'string' || cls.pattern.length === 0) {
          problems.push(`${where}: pattern required`);
        } else {
          if (cls.pattern.includes("'") || cls.pattern.includes('/')) {
            problems.push(`${where}: pattern must not contain single quotes or slashes (embedded in a single-quoted remote awk program)`);
          }
          try {
            void new RegExp(cls.pattern);
          } catch (err) {
            problems.push(`${where}: pattern does not compile: ${err.message}`);
          }
        }
      });
    }
  }
  if (problems.length > 0) throw new Error(`${label}: ${problems.join('; ')}`);
  return ledger;
}

/**
 * Load + validate ledger.json: {version, classes: [{id, disposition:
 * 'gated'|'recorded', pattern (RegExp source, applied per line), description}]}.
 * @param {string} path
 */
export function loadLedger(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`ledger ${path}: ${err.message}`);
  }
  return validateLedger(parsed, `ledger ${path}`);
}
