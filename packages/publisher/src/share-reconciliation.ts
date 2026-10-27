import { assertCanonicalDigest, assertCanonicalEvmAddress, parseCanonicalDecimalU64, parseDeterministicKnowledgeAssetUal, validateAssertionName } from '@origintrail-official/dkg-core';
import { controlStoreOptions, type TripleStore } from '@origintrail-official/dkg-storage';
import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI, PROMOTE_CONTEXT_GRAPH_ID, PROMOTE_PAYLOAD,
  jobSubject, parseLiteral, normalizePromoteAgentLane, parseJobPayload } from './async-promote-queue-utils.js';
import { readShareCompletionEvidence, shareEvidenceMatchesRequest, type ShareCompletionEvidence } from './share-completion-evidence.js';

export interface ShareReconciliationInput {
  contextGraphId: string;
  assertionName: string;
  agentAddress: string;
  authorAddress: string;
  subGraphName?: string;
  entities: 'all' | readonly string[];
  kaUal: string;
  assertionVersion: string;
  merkleRoot: string;
  shareOperationId?: string;
}

export type ShareReconciliationReason = 'absent_or_pruned' | 'identity_mismatch' | 'unsupported_legacy_evidence'
  | 'unfinished' | 'ambiguous' | 'conflicting_evidence' | 'incomplete_inventory' | 'unavailable';
export type ShareReconciliationResult = {
  /** This read never establishes that another mutation is safe. */
  mutationRetryAllowed: false;
  inventory: { scope: 'retained_queue_jobs'; complete: boolean; limit: number };
} & ({ outcome: 'proven'; jobId: string; state: 'succeeded'; evidence: ShareCompletionEvidence }
  | { outcome: 'unproven'; reason: ShareReconciliationReason });

/** Normalize an exact caller expectation; it is a comparison input, never proof. */
export function validateShareReconciliationInput(value: unknown): ShareReconciliationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid reconciliation identity');
  const v = value as Record<string, unknown>;
  for (const field of ['contextGraphId', 'assertionName', 'agentAddress', 'authorAddress', 'kaUal', 'assertionVersion', 'merkleRoot']) {
    if (typeof v[field] !== 'string' || !(v[field] as string).trim() || (v[field] as string).length > 2048)
      throw new Error(`Invalid reconciliation ${field}`);
  }
  if (!validateAssertionName(v.assertionName as string).valid) throw new Error('Invalid reconciliation assertionName');
  if (v.subGraphName !== undefined && (typeof v.subGraphName !== 'string' || !v.subGraphName || v.subGraphName.length > 2048))
    throw new Error('Invalid reconciliation subGraphName');
  const authorAddress = (v.authorAddress as string).toLowerCase(), merkleRoot = (v.merkleRoot as string).toLowerCase();
  assertCanonicalEvmAddress(authorAddress, 'reconciliation authorAddress');
  assertCanonicalDigest(merkleRoot, 'reconciliation merkleRoot');
  if (parseCanonicalDecimalU64(v.assertionVersion, 'reconciliation assertionVersion') === 0n)
    throw new Error('Reconciliation assertionVersion must be positive');
  if (v.shareOperationId !== undefined && (typeof v.shareOperationId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(v.shareOperationId)))
    throw new Error('Invalid reconciliation operation');
  if (v.entities !== 'all' && (!Array.isArray(v.entities) || !v.entities.length || v.entities.length > 1000
    || !v.entities.every(e => typeof e === 'string' && e.length > 0 && e.length <= 2048)))
    throw new Error('An explicit reconciliation entity selector is required');
  const ual = parseDeterministicKnowledgeAssetUal(v.kaUal as string);
  if (ual.agentAddress !== authorAddress) throw new Error('Reconciliation UAL author mismatch');
  return { contextGraphId: v.contextGraphId as string, assertionName: v.assertionName as string,
    agentAddress: normalizePromoteAgentLane(v.agentAddress as string), authorAddress: ual.agentAddress,
    ...(v.subGraphName === undefined ? {} : { subGraphName: v.subGraphName as string }),
    entities: v.entities === 'all' ? 'all' : [...new Set(v.entities as string[])].sort(),
    kaUal: ual.ual, assertionVersion: v.assertionVersion as string, merkleRoot,
    ...(v.shareOperationId === undefined ? {} : { shareOperationId: v.shareOperationId as string }),
  };
}

function sameEntities(a: readonly string[] | 'all', b: readonly string[] | 'all'): boolean {
  if (a === 'all' || b === 'all') return a === b;
  return JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
}

/** Internal reader: caller must hold the queue mutation lock. Discover all subjects before filtering canonical payloads. */
export async function reconcileRetainedShareUnlocked(
  store: TripleStore, input: ShareReconciliationInput, graphUri = DEFAULT_PROMOTE_CONTROL_GRAPH_URI,
): Promise<ShareReconciliationResult> {
  const expected = validateShareReconciliationInput(input), limit = 1000;
  const inventory = { scope: 'retained_queue_jobs' as const, complete: true, limit };
  const unproven = (reason: ShareReconciliationReason, complete = true): ShareReconciliationResult => ({
    outcome: 'unproven', reason, mutationRetryAllowed: false, inventory: { ...inventory, complete },
  });
  let rows;
  try {
    const result = await store.query(`SELECT DISTINCT ?job ?payload ?indexedContext WHERE { GRAPH <${graphUri}> {
      ?job ?predicate ?object .
      OPTIONAL { ?job <${PROMOTE_PAYLOAD}> ?payload }
      OPTIONAL { ?job <${PROMOTE_CONTEXT_GRAPH_ID}> ?indexedContext }
    } } LIMIT ${limit + 1}`, { ...controlStoreOptions('share', 'publisher.asyncPromote.reconcile'), signal: AbortSignal.timeout(10_000) });
    if (result.type !== 'bindings') return unproven('incomplete_inventory', false);
    rows = result.bindings;
  } catch { return unproven('unavailable', false); }
  if (rows.length > limit) return unproven('incomplete_inventory', false);
  const seen = new Set<string>(), matches: { jobId: string; evidence: ShareCompletionEvidence }[] = [];
  let scoped = false, legacy = false, unfinished = false;
  for (const row of rows) {
    const job = parseJobPayload(row.payload);
    if (!job || row.job !== jobSubject(job.jobId) || !row.indexedContext)
      return unproven('incomplete_inventory', false);
    try { if (parseLiteral(row.indexedContext) !== job.request.contextGraphId) return unproven('incomplete_inventory', false); }
    catch { return unproven('incomplete_inventory', false); }
    if (seen.has(job.jobId)) return unproven('conflicting_evidence', false);
    seen.add(job.jobId);
    const request = job.request;
    if (request.contextGraphId !== expected.contextGraphId) continue;
    if (request.assertionName !== expected.assertionName || request.subGraphName !== expected.subGraphName
      || !sameEntities(request.entities, expected.entities)) continue;
    if (!request.agentAddress?.trim()) { legacy = true; continue; }
    if (normalizePromoteAgentLane(request.agentAddress) !== expected.agentAddress) continue;
    scoped = true;
    if (!job.result?.shareEvidence) {
      if (['queued', 'running', 'failed_retrying'].includes(job.state)) unfinished = true;
      else legacy = true;
      continue;
    }
    let evidence: ShareCompletionEvidence;
    try { evidence = readShareCompletionEvidence(job.result.shareEvidence); }
    catch { return unproven('conflicting_evidence'); }
    if (job.state !== 'succeeded' || !shareEvidenceMatchesRequest(evidence, request))
      return unproven('conflicting_evidence');
    const seal = evidence.seal;
    if (seal.kaUal === expected.kaUal && seal.assertionVersion === expected.assertionVersion
      && seal.authorAddress === expected.authorAddress && seal.assertionMerkleRoot === expected.merkleRoot
      && (!expected.shareOperationId || evidence.shareOperationId === expected.shareOperationId))
      matches.push({ jobId: job.jobId, evidence });
  }
  if (matches.length > 1) return unproven('ambiguous');
  if (legacy) return unproven('unsupported_legacy_evidence');
  if (unfinished) return unproven('unfinished');
  if (!matches.length) return unproven(scoped ? 'identity_mismatch' : 'absent_or_pruned');
  return { outcome: 'proven', ...matches[0], state: 'succeeded', mutationRetryAllowed: false, inventory };
}
