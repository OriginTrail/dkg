// OT-RFC-61 §4.4 — append-only JSONL evidence stream + run manifest.
// CONTRACT FILE: implementors replace TODO bodies; signatures are frozen.
// See schema/EVIDENCE.md for the record-type contract (schema_version 1).

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { isoBasic } from './util.mjs';

export const SCHEMA_VERSION = 1;

/**
 * Failure classes — closed enum (RFC-61 §6). `error:<class>` is composed, not listed.
 */
export const FAILURE_CLASSES = Object.freeze([
  'too_low_allowance', 'publisher_wedge', 'transport_error', 'quorum_or_backoff',
  'admission_shed', 'rpc_exhaustion', 'timeout', 'readback_mismatch',
  'query_result_mismatch', 'propagation_timeout', 'arrived_during_gap',
  'finalized_unverified', 'caught_up_unverified', 'aborted',
]);

/** Key names that must never appear (at any depth) in a MAIN-stream record —
 * RFC-61 §8 S6 evidence hygiene: aliases only, no fleet topology or identities. */
export const FORBIDDEN_RECORD_KEYS = Object.freeze(['host', 'ip', 'sshUser', 'sshIdentity']);

/** Depth-first scan for forbidden key names. Returns the dotted path of the
 * first offender, or null. Cycle-safe (evidence records must be JSON anyway). */
function findForbiddenKey(value, path, seen) {
  if (value === null || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findForbiddenKey(value[i], `${path}[${i}]`, seen);
      if (hit) return hit;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    const keyPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_RECORD_KEYS.includes(key)) return keyPath;
    const hit = findForbiddenKey(value[key], keyPath, seen);
    if (hit) return hit;
  }
  return null;
}

/**
 * Evidence writer bound to one run. Appends one JSON object per line to
 * runs/<runId>.jsonl (main) and runs/<runId>.sidecar.jsonl (raw/log text —
 * NEVER hostnames/IPs/keys in the MAIN stream, see EVIDENCE.md hygiene).
 */
export class EvidenceWriter {
  #runId;
  #path;
  #sidecarPath;

  /**
   * @param {{runId: string, runsDir: string}} opts — creates runsDir if missing.
   */
  constructor(opts) {
    const { runId, runsDir } = opts ?? {};
    if (!runId || typeof runId !== 'string') throw new Error('EvidenceWriter: runId required');
    if (!runsDir || typeof runsDir !== 'string') throw new Error('EvidenceWriter: runsDir required');
    mkdirSync(runsDir, { recursive: true });
    this.#runId = runId;
    this.#path = join(runsDir, `${runId}.jsonl`);
    this.#sidecarPath = join(runsDir, `${runId}.sidecar.jsonl`);
  }

  /** Compose the envelope; injected fields always win over record fields. */
  #compose(type, record) {
    if (!type || typeof type !== 'string') throw new Error('EvidenceWriter: record type required');
    return {
      ...(record ?? {}),
      type,
      ts: new Date().toISOString(),
      run_id: this.#runId,
      schema_version: SCHEMA_VERSION,
    };
  }

  /** Append a record to the main stream. Injects type/ts/run_id/schema_version.
   * Throws if `type` is missing or record contains a key named host/ip/sshUser.
   * @param {string} type @param {object} record */
  write(type, record) {
    const offender = findForbiddenKey(record ?? {}, '', new Set());
    if (offender) {
      throw new Error(
        `EvidenceWriter hygiene (S6): forbidden key "${offender}" in main-stream record type "${type}" — aliases only; raw material belongs in the sidecar`,
      );
    }
    const line = this.#compose(type, record);
    appendFileSync(this.#path, `${JSON.stringify(line)}\n`);
    return line;
  }

  /** Append raw/verbatim material (journal excerpts etc.) to the sidecar only.
   * @param {string} type @param {object} record */
  writeSidecar(type, record) {
    const line = this.#compose(type, record);
    appendFileSync(this.#sidecarPath, `${JSON.stringify(line)}\n`);
    return line;
  }

  /** Path of the main stream file. @returns {string} */
  get path() { return this.#path; }

  /** Path of the (local-only, gitignored) sidecar file. @returns {string} */
  get sidecarPath() { return this.#sidecarPath; }
}

/**
 * Compose a run id: `<phase>-<sha8>[-<qualifier>][-r<N>]-<isoBasic>`.
 * @param {{phase: string, sha8?: string, qualifier?: string, attempt?: number, now?: Date}} p
 */
export function makeRunId(p) {
  const { phase, sha8, qualifier, attempt, now } = p ?? {};
  if (!phase || typeof phase !== 'string') throw new Error('makeRunId: phase required');
  const parts = [phase];
  if (sha8) parts.push(String(sha8));
  if (qualifier) parts.push(String(qualifier));
  if (Number.isFinite(attempt)) parts.push(`r${attempt}`);
  parts.push(isoBasic(now));
  return parts.join('-');
}

/**
 * Build the run_manifest record (RFC-61 §4.4): attested identities, scenario
 * verbatim + digest, gate outcomes, NOT_RUN list, spend, permanent bytes.
 * Pure function — caller writes it via EvidenceWriter.
 * @param {{
 *   attested: object, scenario: object, scenarioDigest: string,
 *   fleetDigest: string, policyDigest: string,
 *   gates: Array<{id: string, outcome: string, observed?: any, threshold?: any}>,
 *   notRun: string[], spend?: {trac?: string, eth?: string}, permanentBytesWritten?: number
 * }} m
 */
export function buildManifest(m) {
  const {
    attested, scenario, scenarioDigest, fleetDigest, policyDigest,
    gates, notRun, spend, permanentBytesWritten,
  } = m ?? {};
  for (const [name, value] of [
    ['attested', attested], ['scenario', scenario], ['scenarioDigest', scenarioDigest],
    ['fleetDigest', fleetDigest], ['policyDigest', policyDigest],
  ]) {
    if (value === undefined || value === null) throw new Error(`buildManifest: ${name} required`);
  }
  if (!Array.isArray(gates)) throw new Error('buildManifest: gates must be an array');
  if (!Array.isArray(notRun)) throw new Error('buildManifest: notRun must be an array');
  return {
    attested,
    scenario, // verbatim — the manifest binds evidence to the exact scenario document
    scenarioDigest,
    fleetDigest, // digest ONLY — fleet.json content never enters evidence (S6)
    policyDigest,
    gates: gates.map((g) => ({ ...g })),
    notRun,
    spend: spend ?? {},
    permanentBytesWritten: permanentBytesWritten ?? 0,
  };
}
