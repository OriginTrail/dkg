// OT-RFC-61 §3.3/§8 — fleet/policy/scenario loading, validation, S2 credential check.
//
// Validation style: each loader collects EVERY problem it finds and throws a
// single Error whose message is the problems joined with '; ' — one round trip
// from a broken config file to a complete fix list.
//
// S6 hygiene: validation problems and credential-check evidence reference cores
// by alias (or array index) only — never by host, sshUser, or identity path.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── policy trip contract (mirrors policy.example.json; drift-guarded by test) ──
//
// `direction` states what LOOSER means for the trip's primary value:
//   ceiling  → a HIGHER value is looser (more pressure tolerated before abort)
//   floor    → a LOWER  value is looser (e.g. diskFreeFloorBytes: a lower floor
//              lets the harness run a shared core closer to disk-full)
//   boolean  → false is looser than true (false disables the trip)
// `knobs` are secondary tuning fields with their own looseness direction:
//   sustainSec ceiling                → longer sustain needed before PSI trips
//   consecutiveProbeFailures ceiling  → more failed probes tolerated
//   (admissionShedWindowSec is a ceiling: a longer window smooths transient
//    shed bursts below the fraction threshold, so higher = looser.)
export const POLICY_TRIPS = Object.freeze({
  memoryPsiSomeAvg10: { direction: 'ceiling', type: 'number', knobs: { sustainSec: 'ceiling' } },
  memoryCurrentVsHighFraction: { direction: 'ceiling', type: 'number' },
  oomKillDelta: { direction: 'ceiling', type: 'number' },
  coreUnreachableFromBaseline: { direction: 'ceiling', type: 'number' },
  acceptQueueRecvQAtBacklog: { direction: 'boolean', type: 'boolean', knobs: { consecutiveProbeFailures: 'ceiling' } },
  diskFreeFloorBytes: { direction: 'floor', type: 'number' },
  diskFreeFloorFraction: { direction: 'floor', type: 'number' },
  admissionShedWindowSec: { direction: 'ceiling', type: 'number' },
  admissionShedFractionOfAttempts: { direction: 'ceiling', type: 'number' },
  rpcExhaustionDeltaPerRun: { direction: 'ceiling', type: 'number' },
});

/** True when `value` is LOOSER than `bound` per the trip direction. Equal is never looser. */
export function isLooser(value, bound, direction) {
  if (direction === 'floor') return value < bound;
  if (direction === 'ceiling') return value > bound;
  if (direction === 'boolean') return value === false && bound === true;
  throw new Error(`unknown trip direction: ${direction}`);
}

/** sha256 hex digest of a file's bytes. @param {string} path */
export function fileDigest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ── shared low-level helpers ─────────────────────────────────────────────────

function readJsonWithDigest(path, label, problems) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    problems.push(`${label}: cannot read file: ${e.code || e.message}`);
    return { json: null, digest: null };
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  try {
    const json = JSON.parse(bytes.toString('utf8'));
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      problems.push(`${label}: top level must be a JSON object`);
      return { json: null, digest };
    }
    return { json, digest };
  } catch (e) {
    problems.push(`${label}: invalid JSON: ${e.message}`);
    return { json: null, digest };
  }
}

function throwIfProblems(problems) {
  if (problems.length) throw new Error(problems.join('; '));
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const isPort = (v) => isInt(v) && v >= 1 && v <= 65535;

// ── fleet ────────────────────────────────────────────────────────────────────

const ALIAS_RE_CORE = /^core-\d+$/;
const ALIAS_RE_GENERIC = /^[a-z][a-z0-9-]*$/;
const NETWORK_RE = /^[a-z][a-z0-9-]*:\d+$/;
const CORE_ROLES = new Set(['core', 'relay']);
const EDGE_KEYS = ['driver', 'observer', 'nonMember'];

/**
 * Load + validate fleet.json (see fleet.example.json). Throws with a list of
 * problems on invalid shape. Returns {cores, edges, seeds, sshConcurrency,
 * sshConnectTimeoutSec, network, digest} where digest = sha256 of file bytes.
 * Aliases must be unique and match /^core-\d+$/ or /^[a-z][a-z0-9-]*$/.
 * @param {string} path
 */
export function loadFleet(path) {
  const problems = [];
  const { json, digest } = readJsonWithDigest(path, 'fleet', problems);
  if (!json) throwIfProblems(problems);

  if (json.schemaVersion !== 1) problems.push('fleet: schemaVersion must be 1');
  if (!isNonEmptyStr(json.network) || !NETWORK_RE.test(json.network)) {
    problems.push("fleet: network must be a '<chain>:<id>' string (e.g. base:84532)");
  }

  if (!Array.isArray(json.cores) || json.cores.length === 0) {
    problems.push('fleet: cores must be a non-empty array');
  } else {
    const seen = new Set();
    json.cores.forEach((core, i) => {
      const where = isNonEmptyStr(core?.alias) ? `cores[${i}] (${core.alias})` : `cores[${i}]`;
      if (!isObj(core)) { problems.push(`${where}: must be an object`); return; }
      if (!isNonEmptyStr(core.alias) || !(ALIAS_RE_CORE.test(core.alias) || ALIAS_RE_GENERIC.test(core.alias))) {
        problems.push(`cores[${i}]: alias must match /^core-\\d+$/ or /^[a-z][a-z0-9-]*$/`);
      } else if (seen.has(core.alias)) {
        problems.push(`cores[${i}]: duplicate alias '${core.alias}'`);
      } else {
        seen.add(core.alias);
      }
      // S6: never echo the VALUES of host/sshUser/sshIdentity into error text.
      if (!isNonEmptyStr(core.host)) problems.push(`${where}: host must be a non-empty string`);
      if (!isNonEmptyStr(core.sshUser)) problems.push(`${where}: sshUser must be a non-empty string`);
      if (!isNonEmptyStr(core.sshIdentity)) problems.push(`${where}: sshIdentity must be a non-empty string`);
      if (!isNonEmptyStr(core.systemdUnit)) problems.push(`${where}: systemdUnit must be a non-empty string`);
      if (!isPort(core.apiPort)) problems.push(`${where}: apiPort must be an integer in 1..65535`);
      if (!isPort(core.listenPort)) problems.push(`${where}: listenPort must be an integer in 1..65535`);
      if (!isNonEmptyStr(core.storeFilesystem)) problems.push(`${where}: storeFilesystem must be a non-empty string`);
      if (!Array.isArray(core.roles) || core.roles.length === 0) {
        problems.push(`${where}: roles must be a non-empty array`);
      } else {
        for (const role of core.roles) {
          if (!CORE_ROLES.has(role)) problems.push(`${where}: unknown role '${role}' (allowed: core, relay)`);
        }
      }
    });
  }

  if (!isObj(json.edges)) {
    problems.push('fleet: edges must be an object with driver/observer/nonMember keys');
  } else {
    for (const key of EDGE_KEYS) {
      if (!(key in json.edges)) { problems.push(`fleet: edges.${key} missing (use null when absent)`); continue; }
      const edge = json.edges[key];
      if (edge === null) continue;
      if (!isObj(edge)) { problems.push(`fleet: edges.${key} must be null or an object`); continue; }
      if (!isNonEmptyStr(edge.dkgHome)) problems.push(`fleet: edges.${key}.dkgHome must be a non-empty string`);
      if (!isPort(edge.apiPort)) problems.push(`fleet: edges.${key}.apiPort must be an integer in 1..65535`);
    }
  }

  if (!Array.isArray(json.seeds)) problems.push('fleet: seeds must be an array');
  if (!isInt(json.sshConcurrency) || json.sshConcurrency < 1) {
    problems.push('fleet: sshConcurrency must be an integer >= 1');
  }
  if (!isFiniteNum(json.sshConnectTimeoutSec) || json.sshConnectTimeoutSec <= 0) {
    problems.push('fleet: sshConnectTimeoutSec must be a number > 0');
  }

  throwIfProblems(problems);
  return {
    cores: json.cores,
    edges: json.edges,
    seeds: json.seeds,
    sshConcurrency: json.sshConcurrency,
    sshConnectTimeoutSec: json.sshConnectTimeoutSec,
    network: json.network,
    digest,
  };
}

// ── policy ───────────────────────────────────────────────────────────────────

function validateNumField(obj, name, label, problems, { min = null, integer = false } = {}) {
  const v = obj?.[name];
  if (!isFiniteNum(v) || (integer && !isInt(v)) || (min !== null && v < min)) {
    problems.push(`${label}.${name} must be a ${integer ? 'integer' : 'number'}${min !== null ? ` >= ${min}` : ''}`);
    return false;
  }
  return true;
}

/**
 * Load + validate policy.json against policy.example.json's shape: every trip in
 * the example MUST be present; values looser than hardMax are rejected (part of
 * the collected error list — S3 hard maxima are non-negotiable).
 * Returns {trips, quiesce, safetyAbort, permanentData, faucet, digest}.
 * @param {string} path
 */
export function loadPolicy(path) {
  const problems = [];
  const { json, digest } = readJsonWithDigest(path, 'policy', problems);
  if (!json) throwIfProblems(problems);

  if (json.schemaVersion !== 1) problems.push('policy: schemaVersion must be 1');

  if (!isObj(json.trips)) {
    problems.push('policy: trips must be an object');
  } else {
    for (const [name, spec] of Object.entries(POLICY_TRIPS)) {
      const trip = json.trips[name];
      if (!isObj(trip)) { problems.push(`policy.trips.${name} missing (every trip in policy.example.json is required)`); continue; }
      const typeOk = typeof trip.default === spec.type && typeof trip.hardMax === spec.type
        && (spec.type !== 'number' || (isFiniteNum(trip.default) && isFiniteNum(trip.hardMax)));
      if (!typeOk) {
        problems.push(`policy.trips.${name}: default and hardMax must both be ${spec.type}s`);
      } else if (isLooser(trip.default, trip.hardMax, spec.direction)) {
        problems.push(`policy.trips.${name}: default ${trip.default} is LOOSER than hardMax ${trip.hardMax} `
          + `(direction: ${spec.direction === 'floor' ? 'lower floor is looser' : spec.direction === 'ceiling' ? 'higher ceiling is looser' : 'false is looser than true'})`);
      }
      for (const knob of Object.keys(spec.knobs ?? {})) {
        if (!isFiniteNum(trip[knob]) || trip[knob] <= 0) {
          problems.push(`policy.trips.${name}.${knob} must be a number > 0`);
        }
      }
    }
    for (const name of Object.keys(json.trips)) {
      if (name.startsWith('$')) continue;
      if (!POLICY_TRIPS[name]) problems.push(`policy.trips.${name}: unknown trip (not in the policy.example.json contract)`);
    }
  }

  if (!isObj(json.quiesce)) {
    problems.push('policy: quiesce must be an object');
  } else {
    validateNumField(json.quiesce, 'flatCounterConfirmSec', 'policy.quiesce', problems, { min: 1 });
    validateNumField(json.quiesce, 'edgeShutdownTimeoutSec', 'policy.quiesce', problems, { min: 1 });
  }
  if (!isObj(json.safetyAbort)) {
    problems.push('policy: safetyAbort must be an object');
  } else {
    validateNumField(json.safetyAbort, 'cooldownMin', 'policy.safetyAbort', problems, { min: 0 });
  }
  if (!isObj(json.permanentData)) {
    problems.push('policy: permanentData must be an object');
  } else {
    validateNumField(json.permanentData, 'lifetimeBudgetBytes', 'policy.permanentData', problems, { min: 1, integer: true });
    validateNumField(json.permanentData, 'rollingWindowDays', 'policy.permanentData', problems, { min: 1 });
    validateNumField(json.permanentData, 'rollingBudgetBytes', 'policy.permanentData', problems, { min: 1, integer: true });
  }
  if (!isObj(json.faucet)) {
    problems.push('policy: faucet must be an object');
  } else {
    validateNumField(json.faucet, 'maxTopUpsPerRun', 'policy.faucet', problems, { min: 0, integer: true });
    validateNumField(json.faucet, 'perWalletPer24h', 'policy.faucet', problems, { min: 0, integer: true });
  }

  throwIfProblems(problems);
  return {
    trips: json.trips,
    quiesce: json.quiesce,
    safetyAbort: json.safetyAbort,
    permanentData: json.permanentData,
    faucet: json.faucet,
    digest,
  };
}

// ── scenario ─────────────────────────────────────────────────────────────────

const SCENARIO_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const SCENARIO_LANES = new Set(['public', 'private']);
// Top-level shape contract per scenarios/certify-100.json.
const SCENARIO_REQUIRED_KEYS = ['schemaVersion', 'scenario', 'lanes', 'cg', 'workload', 'measure', 'readback', 'soakSeconds', 'gates'];

/** Tighten-only check for one scenario trip override vs the loaded policy value. */
function checkOverrideTightens(problems, tripName, key, direction, overrideValue, policyValue, where) {
  if (isLooser(overrideValue, policyValue, direction)) {
    problems.push(`${where}: ${overrideValue} LOOSENS policy ${tripName}${key ? `.${key}` : ''} (${policyValue}) — S3 permits tighten-only`);
  }
}

/**
 * Load + validate a scenario by name from scenarios/<name>.json and check it is
 * listed in scenarios.json. Scenario trip overrides may only TIGHTEN policy
 * (S3) — validate against the loaded policy. Returns {scenario, digest}.
 * @param {string} name @param {{policy: object, baseDir?: string}} opts
 */
export function loadScenario(name, opts) {
  const { policy, baseDir = PKG_ROOT } = opts ?? {};
  if (!isObj(policy) || !isObj(policy.trips)) throw new Error('loadScenario: opts.policy must be a policy loaded via loadPolicy');
  if (!isNonEmptyStr(name) || !SCENARIO_NAME_RE.test(name)) {
    throw new Error(`scenario name '${name}' must match /^[a-z0-9][a-z0-9-]*$/`);
  }

  const problems = [];
  const { json: manifest } = readJsonWithDigest(join(baseDir, 'scenarios.json'), 'scenarios.json', problems);
  throwIfProblems(problems);
  if (!Array.isArray(manifest.scenarios) || !manifest.scenarios.every(isNonEmptyStr)) {
    throw new Error('scenarios.json: scenarios must be an array of names');
  }
  if (!manifest.scenarios.includes(name)) {
    throw new Error(`scenario '${name}' is not listed in scenarios.json (drift guard: file and manifest must agree)`);
  }

  const { json: sc, digest } = readJsonWithDigest(join(baseDir, 'scenarios', `${name}.json`), `scenario ${name}`, problems);
  if (!sc) throwIfProblems(problems);

  for (const key of SCENARIO_REQUIRED_KEYS) {
    if (!(key in sc)) problems.push(`scenario ${name}: missing required key '${key}' (shape per scenarios/certify-100.json)`);
  }
  if ('schemaVersion' in sc && sc.schemaVersion !== 1) problems.push(`scenario ${name}: schemaVersion must be 1`);
  if ('scenario' in sc && sc.scenario !== name) problems.push(`scenario ${name}: 'scenario' field must equal the file basename (got '${sc.scenario}')`);

  let lanes = [];
  if ('lanes' in sc) {
    if (!Array.isArray(sc.lanes) || sc.lanes.length === 0 || !sc.lanes.every((l) => SCENARIO_LANES.has(l))) {
      problems.push(`scenario ${name}: lanes must be a non-empty array drawn from [public, private]`);
    } else {
      lanes = sc.lanes;
    }
  }
  if ('cg' in sc) {
    if (!isObj(sc.cg)) {
      problems.push(`scenario ${name}: cg must be an object`);
    } else {
      for (const lane of lanes) {
        if (!isNonEmptyStr(sc.cg[lane])) problems.push(`scenario ${name}: cg.${lane} must be a non-empty string`);
      }
    }
  }
  if ('workload' in sc) {
    if (!isObj(sc.workload)) {
      problems.push(`scenario ${name}: workload must be an object`);
    } else {
      const w = sc.workload;
      if (!isNonEmptyStr(w.op)) problems.push(`scenario ${name}: workload.op must be a non-empty string`);
      validateNumField(w, 'waves', `scenario ${name}: workload`, problems, { min: 1, integer: true });
      if (!isObj(w.perWave)) {
        problems.push(`scenario ${name}: workload.perWave must be an object`);
      } else {
        for (const lane of lanes) {
          if (!isInt(w.perWave[lane]) || w.perWave[lane] < 1) {
            problems.push(`scenario ${name}: workload.perWave.${lane} must be an integer >= 1`);
          }
        }
      }
      if (!isNonEmptyStr(w.entityShape)) problems.push(`scenario ${name}: workload.entityShape must be a non-empty string`);
      validateNumField(w, 'controlFixtureEvery', `scenario ${name}: workload`, problems, { min: 0, integer: true });
      // S3: every scenario declares max concurrency.
      validateNumField(w, 'concurrency', `scenario ${name}: workload`, problems, { min: 1, integer: true });
      if (!isNonEmptyStr(w.arrival)) problems.push(`scenario ${name}: workload.arrival must be a non-empty string`);
    }
  }
  if ('measure' in sc && (!Array.isArray(sc.measure) || sc.measure.length === 0 || !sc.measure.every(isNonEmptyStr))) {
    problems.push(`scenario ${name}: measure must be a non-empty array of strings`);
  }
  if ('readback' in sc) {
    if (!isObj(sc.readback)) {
      problems.push(`scenario ${name}: readback must be an object`);
    } else {
      if (!isNonEmptyStr(sc.readback.where)) problems.push(`scenario ${name}: readback.where must be a non-empty string`);
      if (typeof sc.readback.byteExact !== 'boolean') problems.push(`scenario ${name}: readback.byteExact must be a boolean`);
      validateNumField(sc.readback, 'chunkSize', `scenario ${name}: readback`, problems, { min: 1, integer: true });
    }
  }
  if ('soakSeconds' in sc && (!isFiniteNum(sc.soakSeconds) || sc.soakSeconds < 0)) {
    problems.push(`scenario ${name}: soakSeconds must be a number >= 0`);
  }
  if ('gates' in sc && !isObj(sc.gates)) problems.push(`scenario ${name}: gates must be an object`);

  // ── S3 tighten-only: optional scenario.trips overrides vs loaded policy ──
  if ('trips' in sc) {
    if (!isObj(sc.trips)) {
      problems.push(`scenario ${name}: trips must be an object of policy-trip overrides`);
    } else {
      for (const [tripName, override] of Object.entries(sc.trips)) {
        if (tripName.startsWith('$')) continue;
        const spec = POLICY_TRIPS[tripName];
        const policyTrip = policy.trips[tripName];
        if (!spec || !isObj(policyTrip)) {
          problems.push(`scenario ${name}: trips.${tripName} is not a known policy trip`);
          continue;
        }
        const where = `scenario ${name}: trips.${tripName}`;
        if (typeof override === spec.type) {
          checkOverrideTightens(problems, tripName, null, spec.direction, override, policyTrip.default, where);
        } else if (isObj(override)) {
          if ('default' in override) {
            if (typeof override.default !== spec.type) {
              problems.push(`${where}.default must be a ${spec.type}`);
            } else {
              checkOverrideTightens(problems, tripName, 'default', spec.direction, override.default, policyTrip.default, `${where}.default`);
            }
          }
          for (const [knob, value] of Object.entries(override)) {
            if (knob === 'default' || knob.startsWith('$')) continue;
            const knobDirection = spec.knobs?.[knob];
            if (!knobDirection) { problems.push(`${where}.${knob} is not a known knob for this trip`); continue; }
            if (!isFiniteNum(value)) { problems.push(`${where}.${knob} must be a number`); continue; }
            checkOverrideTightens(problems, tripName, knob, knobDirection, value, policyTrip[knob], `${where}.${knob}`);
          }
        } else {
          problems.push(`${where} must be a ${spec.type} or an object override`);
        }
      }
    }
  }

  // ── S3 tighten-only: gates.fleet keys that shadow policy trips (e.g. oomKillDelta) ──
  if (isObj(sc.gates) && isObj(sc.gates.fleet)) {
    for (const [gate, value] of Object.entries(sc.gates.fleet)) {
      const spec = POLICY_TRIPS[gate];
      const policyTrip = policy.trips[gate];
      if (!spec || !isObj(policyTrip)) continue; // plain gate, not a trip shadow
      const where = `scenario ${name}: gates.fleet.${gate}`;
      if (typeof value !== spec.type) {
        problems.push(`${where} must be a ${spec.type} (shadows a policy trip)`);
      } else {
        checkOverrideTightens(problems, gate, null, spec.direction, value, policyTrip.default, where);
      }
    }
  }

  throwIfProblems(problems);
  return { scenario: sc, digest };
}

// ── S2 credential-isolation check ────────────────────────────────────────────

function expandTilde(p, env) {
  const home = env?.HOME || homedir();
  return p.replace(/^~(?=\/|$)/, home);
}

/** Default exec: never throws; resolves {code, stdout, stderr, timedOut}. */
function defaultExec(file, args, { timeoutMs = 20000, env } = {}) {
  return new Promise((resolvePromise) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env }, (err, stdout, stderr) => {
      if (!err) return resolvePromise({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '', timedOut: false });
      const timedOut = Boolean(err.killed || err.signal === 'SIGTERM');
      const code = typeof err.code === 'number' ? err.code : 255; // ENOENT etc. → transport-class failure
      resolvePromise({ code: timedOut ? null : code, stdout: stdout ?? '', stderr: stderr ?? '', timedOut });
    });
  });
}

function sshProbeArgs(core, remoteCmd, connectTimeoutSec, identityPath) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none',
    '-o', `ConnectTimeout=${connectTimeoutSec}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-i', identityPath,
    `${core.sshUser}@${core.host}`,
    '--', remoteCmd,
  ];
}

/**
 * S2 credential-isolation check for AUTONOMOUS mode (RFC-61 §8 S2).
 * Verifies, without mutating anything:
 *  1. No ambient SSH agent (SSH_AUTH_SOCK unset or empty agent).
 *  2. The configured sshIdentity exists and is the ONLY credential offered
 *     (BatchMode, IdentitiesOnly=yes; probes additionally pin IdentityAgent=none).
 *  3. A mutation probe is REFUSED: `ssh <core> -- sudo -n true` must fail AND
 *     an arbitrary command (`echo x`) must NOT round-trip verbatim if a forced
 *     command is configured (forced command returns snapshot output instead).
 * Returns {ok: boolean, checks: Array<{id, pass, evidence}>}. NEVER throws on
 * probe failure — reports. Interactive mode skips this and records mode.
 * Optional (test) opts: _exec(file, args, {timeoutMs, env}) → {code, stdout,
 * stderr, timedOut}; _env to replace process.env.
 * @param {object} fleet @param {{mode: 'autonomous'|'interactive'}} opts
 */
export async function verifyCredentialIsolation(fleet, opts) {
  const { mode, _exec = defaultExec, _env = process.env } = opts ?? {};
  if (mode !== 'autonomous' && mode !== 'interactive') {
    throw new Error("verifyCredentialIsolation: opts.mode must be 'autonomous' or 'interactive'");
  }
  if (mode === 'interactive') {
    return {
      ok: true,
      checks: [{
        id: 'mode-interactive',
        pass: true,
        evidence: { mode: 'interactive', skipped: 'S2 isolation verification applies to autonomous runs only' },
      }],
    };
  }

  const checks = [];
  const cores = Array.isArray(fleet?.cores) ? fleet.cores : [];
  const connectTimeoutSec = isFiniteNum(fleet?.sshConnectTimeoutSec) && fleet.sshConnectTimeoutSec > 0
    ? fleet.sshConnectTimeoutSec : 8;

  // 1 — no ambient SSH agent.
  const authSock = (_env.SSH_AUTH_SOCK || '').trim();
  if (!authSock) {
    checks.push({ id: 'no-agent', pass: true, evidence: { authSockSet: false } });
  } else {
    const res = await _exec('ssh-add', ['-l'], { timeoutMs: 10000, env: { ..._env } });
    if (res.code === 1) {
      // "The agent has no identities." — socket exists but offers nothing.
      checks.push({ id: 'no-agent', pass: true, evidence: { authSockSet: true, agentEmpty: true } });
    } else if (res.code === 0) {
      const agentIdentities = res.stdout.split('\n').filter((l) => /\S/.test(l)).length;
      checks.push({ id: 'no-agent', pass: false, evidence: { authSockSet: true, agentIdentities } });
    } else {
      // Cannot prove the agent is empty → fail closed (S2: refuse when unverifiable).
      checks.push({ id: 'no-agent', pass: false, evidence: { authSockSet: true, reason: 'agent-state-unverifiable', code: res.code } });
    }
  }

  // 2 — every core has a configured identity and the file exists.
  // S6: evidence carries aliases and counts only, never identity paths.
  const coresMissingIdentity = [];
  const identityByAlias = new Map();
  for (const core of cores) {
    if (!isNonEmptyStr(core.sshIdentity)) { coresMissingIdentity.push(core.alias); continue; }
    const path = expandTilde(core.sshIdentity, _env);
    if (!existsSync(path)) { coresMissingIdentity.push(core.alias); continue; }
    identityByAlias.set(core.alias, path);
  }
  checks.push({
    id: 'identity-only',
    pass: cores.length > 0 && coresMissingIdentity.length === 0,
    evidence: {
      cores: cores.length,
      identitiesFound: identityByAlias.size,
      coresMissingIdentity,
      identitiesOnly: true, // probes force BatchMode + IdentitiesOnly=yes + IdentityAgent=none
    },
  });

  // 3 — per-core mutation-refusal probes. Sequential: never a connection storm.
  for (const core of cores) {
    const alias = core.alias;
    const identityPath = identityByAlias.get(alias);
    if (!identityPath) {
      checks.push({ id: `sudo-refused:${alias}`, pass: false, evidence: { alias, reason: 'identity-missing-not-probed' } });
      checks.push({ id: `no-verbatim-exec:${alias}`, pass: false, evidence: { alias, reason: 'identity-missing-not-probed' } });
      continue;
    }

    const sudoRes = await _exec(
      'ssh', sshProbeArgs(core, 'sudo -n true', connectTimeoutSec, identityPath),
      { timeoutMs: (connectTimeoutSec + 15) * 1000 },
    );
    if (sudoRes.timedOut || sudoRes.code === null || sudoRes.code === 255) {
      // Transport failure: refusal unproven → fail closed.
      checks.push({ id: `sudo-refused:${alias}`, pass: false, evidence: { alias, code: sudoRes.code, reason: 'ssh-transport-error-cannot-verify' } });
    } else {
      const passwordPrompt = /a password is required/i.test(`${sudoRes.stdout}\n${sudoRes.stderr}`);
      checks.push({
        id: `sudo-refused:${alias}`,
        pass: sudoRes.code !== 0 || passwordPrompt,
        evidence: { alias, code: sudoRes.code, passwordPrompt },
      });
    }

    const echoRes = await _exec(
      'ssh', sshProbeArgs(core, 'echo x', connectTimeoutSec, identityPath),
      { timeoutMs: (connectTimeoutSec + 15) * 1000 },
    );
    if (echoRes.timedOut || echoRes.code === null || echoRes.code === 255) {
      checks.push({ id: `no-verbatim-exec:${alias}`, pass: false, evidence: { alias, code: echoRes.code, reason: 'ssh-transport-error-cannot-verify' } });
    } else {
      // Verbatim 'x' back ⇒ the remote actually RAN our command ⇒ no forced command.
      const verbatim = echoRes.stdout.replace(/\r?\n$/, '') === 'x';
      checks.push({
        id: `no-verbatim-exec:${alias}`,
        pass: !verbatim,
        evidence: { alias, code: echoRes.code, verbatim, stdoutBytes: Buffer.byteLength(echoRes.stdout) },
      });
    }
  }

  return { ok: checks.length > 0 && checks.every((c) => c.pass), checks };
}
