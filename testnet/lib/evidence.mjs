// OT-RFC-61 §4.4 — append-only JSONL evidence stream + run manifest.
// CONTRACT FILE: implementors replace TODO bodies; signatures are frozen.
// See schema/EVIDENCE.md for the record-type contract (schema_version 1).

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

/**
 * Evidence writer bound to one run. Appends one JSON object per line to
 * runs/<runId>.jsonl (main) and runs/<runId>.sidecar.jsonl (raw/log text —
 * NEVER hostnames/IPs/keys in the MAIN stream, see EVIDENCE.md hygiene).
 */
export class EvidenceWriter {
  /**
   * @param {{runId: string, runsDir: string}} opts — creates runsDir if missing.
   */
  constructor(opts) { throw new Error('TODO'); }

  /** Append a record to the main stream. Injects type/ts/run_id/schema_version.
   * Throws if `type` is missing or record contains a key named host/ip/sshUser.
   * @param {string} type @param {object} record */
  write(type, record) { throw new Error('TODO'); }

  /** Append raw/verbatim material (journal excerpts etc.) to the sidecar only.
   * @param {string} type @param {object} record */
  writeSidecar(type, record) { throw new Error('TODO'); }

  /** Path of the main stream file. @returns {string} */
  get path() { throw new Error('TODO'); }
}

/**
 * Compose a run id: `<phase>-<sha8>[-<qualifier>][-r<N>]-<isoBasic>`.
 * @param {{phase: string, sha8?: string, qualifier?: string, attempt?: number, now?: Date}} p
 */
export function makeRunId(p) { throw new Error('TODO'); }

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
export function buildManifest(m) { throw new Error('TODO'); }
