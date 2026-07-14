// OT-RFC-61 §3.2 — local edge daemon client + CLI runner (driver edge D; Phase 1 adds O/N).
// CONTRACT FILE: implementors replace TODO bodies; signatures are frozen.
// Route shapes MUST be verified against the monorepo at ../.. (this worktree is
// origin/main) — packages/cli/src/daemon/routes/*, packages/cli/src/api-client.ts.

/**
 * Thin authenticated client for ONE local edge daemon.
 * Auth: bearer token resolved the way the CLI does (DKG_HOME token files /
 * DKG_AUTH_TOKEN env) — implementor: verify against packages/cli/src/auth.ts.
 */
export class EdgeClient {
  /** @param {{dkgHome: string, apiPort: number, label: 'driver'|'observer'|'nonMember'}} opts */
  constructor(opts) { throw new Error('TODO'); }

  /** GET /api/status (public). @returns {Promise<object>} */
  async status() { throw new Error('TODO'); }

  /** Create KA (WM) + optional share/finalize flags — POST /api/knowledge-assets.
   * @param {{name: string, cg: string, quads: string, finalize?: boolean}} p */
  async createKnowledgeAsset(p) { throw new Error('TODO'); }

  /** SHARE WM->SWM async — POST /api/knowledge-assets/:name/swm/share-async → {jobId}.
   * @param {{name: string, cg: string}} p */
  async shareAsync(p) { throw new Error('TODO'); }

  /** Poll a share job to terminal state. Returns final job record.
   * @param {{jobId: string, timeoutMs: number, intervalMs?: number}} p */
  async waitShareJob(p) { throw new Error('TODO'); }

  /** PUBLISH SWM->VM async — POST /api/knowledge-assets/:name/vm/publish-async → {jobId}.
   * @param {{name: string, cg: string}} p */
  async publishAsync(p) { throw new Error('TODO'); }

  /** Poll a publisher job to terminal state (confirmed: ual+txHash | failed).
   * @param {{jobId: string, timeoutMs: number, intervalMs?: number}} p */
  async waitPublishJob(p) { throw new Error('TODO'); }

  /** Authoritative KA state — GET /api/knowledge-assets/:name?contextGraphId=…
   * Used for §6 recovery re-scoring (client timeout ≠ failure) and memoryLayer=VM polling.
   * @param {{name: string, cg: string}} p */
  async knowledgeAssetState(p) { throw new Error('TODO'); }

  /** Local SPARQL — POST /api/query {sparql, view, contextGraphId}. view:
   * 'working-memory'|'shared-working-memory'|'verifiable-memory'.
   * @param {{sparql: string, view: string, cg?: string}} p @returns SPARQL JSON results */
  async query(p) { throw new Error('TODO'); }

  /** Sync catch-up status — GET /api/sync/catchup-status?contextGraphId=…
   * @param {{cg?: string}} p */
  async catchupStatus(p) { throw new Error('TODO'); }

  /** Subscribe to SSE /api/events. Returns {close(), gaps(): Array<{fromTs,toTs}>}
   * and invokes onEvent(parsed) per event; tracks disconnect gaps (§4.3 SSE
   * reliability — gaps are recorded, reconnect is automatic).
   * @param {{onEvent: (e: object) => void}} p */
  async events(p) { throw new Error('TODO'); }
}

/**
 * Run the dkg CLI as a child process against a DKG_HOME (rfc59 publish path —
 * kept because certify Phase 0 must reproduce the CLI-driven runs byte-for-byte).
 * @param {{cliPath: string, dkgHome: string, args: string[], timeoutMs: number}} p
 * @returns {Promise<{ok, code, signal, stdout, stderr, timedOut, durationMs}>}
 */
export async function runCli(p) { throw new Error('TODO'); }

/**
 * Deterministic single-triple N-Quads payload for op `index` of a run
 * (subject urn:rfc61:<lane>:<runId>:<index>, schema.org/name object; every
 * `controlFixtureEvery`-th op uses the Unicode/control-char fixture set —
 * café/Δ/newline/tab/ — port of rfc59 fixtures).
 * @param {{runId: string, lane: string, index: number, controlFixtureEvery: number}} p
 * @returns {{quads: string, subject: string, expectedObject: string, controlFixture: boolean}}
 */
export function makePayload(p) { throw new Error('TODO'); }

/**
 * Byte-exact readback of published fixtures via chunked VALUES queries
 * (chunk 25 subjects — rfc59 port). Compares normalized terms against expected.
 * @param {EdgeClient} edge
 * @param {{items: Array<{subject, expectedObject}>, cg: string, view: string, chunkSize?: number}} p
 * @returns {Promise<{matched: number, mismatches: Array<{subject, kind}>}>}
 */
export async function verifyReadback(edge, p) { throw new Error('TODO'); }
