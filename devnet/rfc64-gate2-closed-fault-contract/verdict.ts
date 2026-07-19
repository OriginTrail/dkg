import {
  GATE2_CONTRACT,
  GATE2_GENERATED_BY,
  GATE2_PRODUCT_BOUNDARY,
  GATE2_GATE_EVALUATION,
  GATE2_RAW_SCHEMA_VERSION,
  GATE2_SOURCE_COMMIT,
  GATE2_SOURCE_REVIEW,
  buildGate2RawEvidence,
} from './raw-evidence.js';

/**
 * RFC-64 Gate 2 "closed fault-contract" verdict schema + fail-closed verifier.
 *
 * verifyGate2() never throws on bad input: any missing / type-wrong /
 * uncross-bound field, any scenario that fails its acceptance assertion, an
 * unknown extra field, a wrong productBoundary/gateEvaluation, or a
 * product-gate-pass marker yields a `contract-violated` verdict carrying a
 * specific violation. The verdict ALWAYS self-declares productBoundary=
 * "not-connected" and gateEvaluation="not-evaluated" so it can never be read as
 * a real Gate 2 product pass.
 */

export const GATE2_VERDICT_SCHEMA_VERSION =
  'dkg-rfc64-gate2-closed-fault-contract-verdict-v1';

const DIGEST_PATTERN = /^0x[0-9a-f]{64}$/u;
const RECONCILER_ID_PATTERN = /^rfc64-reconciler-[0-9a-f]{64}$/u;
const SYNC_STATES = [
  'applying',
  'rebuilding',
  'blocked',
  'known-incomplete',
  'unknown-freshness',
  'complete',
] as const;
const FRESHNESS_STATES = ['fresh', 'unknown-freshness', 'stale'] as const;
const NETWORK_DURABILITY_SUMMARIES = [
  'network-durable',
  'not-network-durable',
  'unknown',
] as const;

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'contract',
  'productBoundary',
  'gateEvaluation',
  'generatedBy',
  'sourceReview',
  'sourceCommit',
  'coldLateJoin',
  'multiProviderFailover',
  'freshCheckpointAuthorityFailover',
  'appliedSealAndPostReads',
  'watermarkGapReporting',
  'zeroEligibleTerminalOutcome',
  'providerContinuation',
  'crashRestart',
] as const;

export interface VerdictCheck {
  readonly id: string;
  readonly assertion: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface VerdictViolation {
  readonly id: string;
  readonly assertion: string;
  readonly detail: string;
}

export interface Gate2Verdict {
  readonly schemaVersion: string;
  readonly contract: string;
  readonly status: 'contract-satisfied' | 'contract-violated';
  readonly productBoundary: 'not-connected';
  readonly gateEvaluation: 'not-evaluated';
  readonly sourceReview: string;
  readonly sourceCommit: string;
  readonly checks: readonly VerdictCheck[];
  readonly violations: readonly VerdictViolation[];
}

interface CheckSpec {
  readonly id: string;
  readonly assertion: string;
  readonly run: (root: Record<string, unknown>) => void;
}

interface GuardSpec {
  readonly id: string;
  readonly assertion: string;
  readonly run: (raw: unknown) => void;
}

class ContractError extends Error {}

function fail(message: string): never {
  throw new ContractError(message);
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function prop(value: unknown, key: string, path: string): unknown {
  const record = asObject(value, path);
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    fail(`${path}.${key} is missing`);
  }
  return record[key];
}

function pobj(value: unknown, key: string, path: string): Record<string, unknown> {
  return asObject(prop(value, key, path), `${path}.${key}`);
}

function pstr(value: unknown, key: string, path: string): string {
  const found = prop(value, key, path);
  if (typeof found !== 'string') fail(`${path}.${key} must be a string`);
  return found;
}

function pbool(value: unknown, key: string, path: string): boolean {
  const found = prop(value, key, path);
  if (typeof found !== 'boolean') fail(`${path}.${key} must be a boolean`);
  return found;
}

function pint(value: unknown, key: string, path: string): number {
  const found = prop(value, key, path);
  if (typeof found !== 'number' || !Number.isInteger(found)) {
    fail(`${path}.${key} must be an integer`);
  }
  return found;
}

function parr(value: unknown, key: string, path: string): readonly unknown[] {
  const found = prop(value, key, path);
  if (!Array.isArray(found)) fail(`${path}.${key} must be an array`);
  return found;
}

function pdigest(value: unknown, key: string, path: string): string {
  const found = pstr(value, key, path);
  if (!DIGEST_PATTERN.test(found)) fail(`${path}.${key} must be a 0x + 64 hex digest`);
  return found;
}

function eq(actual: unknown, expected: unknown, path: string): void {
  if (!Object.is(actual, expected)) {
    fail(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function atLeast(actual: number, min: number, path: string): void {
  if (actual < min) fail(`${path} must be >= ${min}, got ${actual}`);
}

function agree(entries: readonly (readonly [string, unknown])[], what: string): void {
  const [first, ...rest] = entries;
  for (const [label, value] of rest) {
    if (!Object.is(value, first[1])) {
      fail(
        `cross-binding ${what} disagree: ${first[0]}=${JSON.stringify(first[1])} vs ${label}=${JSON.stringify(value)}`,
      );
    }
  }
}

const GUARDS: readonly GuardSpec[] = [
  {
    id: 'GUARD-top-level-schema',
    assertion:
      'top-level is a closed object with the exact contract key set and pinned metadata',
    run: (raw) => {
      const root = asObject(raw, '$');
      const keys = Object.keys(root).sort(compareCodeUnits);
      const expected = [...TOP_LEVEL_KEYS].sort(compareCodeUnits);
      if (
        keys.length !== expected.length
        || keys.some((key, index) => key !== expected[index])
      ) {
        fail(`top-level key set is not the closed contract set: ${JSON.stringify(keys)}`);
      }
      eq(pstr(root, 'schemaVersion', '$'), GATE2_RAW_SCHEMA_VERSION, '$.schemaVersion');
      eq(pstr(root, 'contract', '$'), GATE2_CONTRACT, '$.contract');
      eq(pstr(root, 'generatedBy', '$'), GATE2_GENERATED_BY, '$.generatedBy');
      eq(pstr(root, 'sourceReview', '$'), GATE2_SOURCE_REVIEW, '$.sourceReview');
      eq(pstr(root, 'sourceCommit', '$'), GATE2_SOURCE_COMMIT, '$.sourceCommit');
    },
  },
  {
    id: 'GUARD-product-boundary',
    assertion: 'productBoundary must be "not-connected" (fixtures-only, never product)',
    run: (raw) => {
      const root = asObject(raw, '$');
      eq(pstr(root, 'productBoundary', '$'), GATE2_PRODUCT_BOUNDARY, '$.productBoundary');
    },
  },
  {
    id: 'GUARD-gate-evaluation',
    assertion: 'gateEvaluation must be "not-evaluated" (harness never evaluates the product gate)',
    run: (raw) => {
      const root = asObject(raw, '$');
      eq(pstr(root, 'gateEvaluation', '$'), GATE2_GATE_EVALUATION, '$.gateEvaluation');
    },
  },
  {
    id: 'GUARD-no-product-pass-marker',
    assertion: 'no field may mark any scenario as passed against the real product gate',
    run: (raw) => {
      const markers: string[] = [];
      scanForProductPassMarkers(raw, '$', markers);
      if (markers.length > 0) {
        fail(`product-gate-pass markers are forbidden: ${JSON.stringify(markers)}`);
      }
    },
  },
  {
    id: 'GUARD-structure',
    assertion:
      'every object key set, array type, and leaf type matches the closed contract shape',
    run: (raw) => {
      assertShape(buildGate2RawEvidence() as unknown, raw, '$');
    },
  },
];

const CHECKS: readonly CheckSpec[] = [
  {
    id: 'A1',
    assertion:
      'all five triggers drive the SAME reconciler id; Path-B synced ⇒ Path-A watermark==head==producer KC count',
    run: (root) => {
      const clj = pobj(root, 'coldLateJoin', '$');
      const reconciler = pobj(clj, 'reconciler', '$.coldLateJoin');
      const canonical = pstr(reconciler, 'canonicalReconcilerId', '$.coldLateJoin.reconciler');
      if (!RECONCILER_ID_PATTERN.test(canonical)) {
        fail('$.coldLateJoin.reconciler.canonicalReconcilerId is malformed');
      }
      const triggers = pobj(reconciler, 'triggers', '$.coldLateJoin.reconciler');
      for (const name of ['subscribe', 'reconnect', 'catchUp', 'restart', 'lateJoin']) {
        const id = pstr(triggers, name, '$.coldLateJoin.reconciler.triggers');
        eq(id, canonical, `$.coldLateJoin.reconciler.triggers.${name}`);
      }
      const synced = pbool(pobj(clj, 'pathB', '$.coldLateJoin'), 'synced', '$.coldLateJoin.pathB');
      const pathA = pobj(clj, 'pathA', '$.coldLateJoin');
      const watermark = pint(pathA, 'watermark', '$.coldLateJoin.pathA');
      const head = pint(pathA, 'head', '$.coldLateJoin.pathA');
      const producerKc = pint(pathA, 'producerKnowledgeAssetCount', '$.coldLateJoin.pathA');
      if (synced) {
        agree(
          [
            ['pathA.watermark', watermark],
            ['pathA.head', head],
            ['pathA.producerKnowledgeAssetCount', producerKc],
          ],
          'Path-B synced ⇒ Path-A watermark==head==producerKC',
        );
      }
    },
  },
  {
    id: 'A2',
    assertion:
      'no "complete" unless applied-set root match, aggregate-CG parity, subgraph seals, chain coverage, zero runnable SQL, frozen post-reads, initial-owner-lineage SWM continuity, cross-bound head digest, single policyDigest, watermark==head',
    run: (root) => {
      const clj = pobj(root, 'coldLateJoin', '$');
      const aspr = pobj(root, 'appliedSealAndPostReads', '$');
      const fcaf = pobj(root, 'freshCheckpointAuthorityFailover', '$');
      const completion = pobj(aspr, 'completion', '$.appliedSealAndPostReads');
      const base = '$.appliedSealAndPostReads.completion';
      eq(pstr(completion, 'status', base), 'complete', `${base}.status`);
      eq(pbool(completion, 'appliedSetRootMatch', base), true, `${base}.appliedSetRootMatch`);
      eq(pbool(completion, 'aggregateCgParity', base), true, `${base}.aggregateCgParity`);
      eq(
        pbool(completion, 'everyActiveSubgraphSealMatches', base),
        true,
        `${base}.everyActiveSubgraphSealMatches`,
      );
      eq(
        pbool(completion, 'independentlyDerivedChainCoverage', base),
        true,
        `${base}.independentlyDerivedChainCoverage`,
      );
      eq(pint(completion, 'runnableSqlCount', base), 0, `${base}.runnableSqlCount`);
      eq(pbool(completion, 'postReadsFrozen', base), true, `${base}.postReadsFrozen`);
      eq(
        pstr(pobj(completion, 'swmContinuity', base), 'kind', `${base}.swmContinuity`),
        'initial-owner-lineage',
        `${base}.swmContinuity.kind`,
      );
      agree(
        [
          ['completion.policyDigest', pdigest(completion, 'policyDigest', base)],
          ['coldLateJoin.policyDigest', pdigest(clj, 'policyDigest', '$.coldLateJoin')],
        ],
        'single policyDigest',
      );
      agree(
        [
          ['appliedHeadDigest', pdigest(aspr, 'appliedHeadDigest', '$.appliedSealAndPostReads')],
          ['authoredHeadDigest', pdigest(clj, 'authoredHeadDigest', '$.coldLateJoin')],
          [
            'namedCheckpointHeadDigest',
            pdigest(pobj(fcaf, 'swmAdmission', '$.freshCheckpointAuthorityFailover'), 'namedCheckpointHeadDigest', '$.freshCheckpointAuthorityFailover.swmAdmission'),
          ],
        ],
        'publisher authoredHead == receiver appliedHead == checkpoint head',
      );
      agree(
        [
          ['completion.watermark', pint(completion, 'watermark', base)],
          ['completion.head', pint(completion, 'head', base)],
          ['coldLateJoin.head', pint(clj, 'head', '$.coldLateJoin')],
        ],
        'completion watermark == head == late-join head',
      );
    },
  },
  {
    id: 'A3',
    assertion:
      'head == authored-catalog cardinality (derived from cardinality, not mere enumeration)',
    run: (root) => {
      const clj = pobj(root, 'coldLateJoin', '$');
      agree(
        [
          ['head', pint(clj, 'head', '$.coldLateJoin')],
          ['authoredCatalogCardinality', pint(clj, 'authoredCatalogCardinality', '$.coldLateJoin')],
          ['rawEnumerationCount', pint(clj, 'rawEnumerationCount', '$.coldLateJoin')],
        ],
        'head vs authored-catalog cardinality vs enumeration',
      );
      eq(
        pstr(clj, 'headDerivedFrom', '$.coldLateJoin'),
        'authored-catalog-cardinality',
        '$.coldLateJoin.headDerivedFrom',
      );
    },
  },
  {
    id: 'A4',
    assertion:
      'empty-start marker: observer began with 0 KAs and converged to canonical parity incl author seals',
    run: (root) => {
      const marker = pobj(pobj(root, 'coldLateJoin', '$'), 'emptyStartMarker', '$.coldLateJoin');
      const base = '$.coldLateJoin.emptyStartMarker';
      eq(pbool(marker, 'startedEmpty', base), true, `${base}.startedEmpty`);
      eq(pint(marker, 'observedInitialKaCount', base), 0, `${base}.observedInitialKaCount`);
      eq(pbool(marker, 'convergedToCanonicalParity', base), true, `${base}.convergedToCanonicalParity`);
      eq(pbool(marker, 'authorSealsIncluded', base), true, `${base}.authorSealsIncluded`);
    },
  },
  {
    id: 'A5',
    assertion:
      'un-fetchable ordinal N with later ordinals available: N+1..N+k materialize, missingVmOrdinals == [N], no wedge, self-heals',
    run: (root) => {
      const gap = pobj(root, 'watermarkGapReporting', '$');
      const base = '$.watermarkGapReporting';
      const n = pint(gap, 'requestedOrdinal', base);
      atLeast(n, 1, `${base}.requestedOrdinal`);
      const later = parr(gap, 'laterOrdinalsMaterialized', base);
      if (later.length < 1) fail(`${base}.laterOrdinalsMaterialized must list N+1..N+k with k>=1`);
      later.forEach((value, index) => {
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          fail(`${base}.laterOrdinalsMaterialized[${index}] must be an integer`);
        }
        if (value !== n + 1 + index) {
          fail(`${base}.laterOrdinalsMaterialized must be contiguous from ${n + 1}, got ${value} at ${index}`);
        }
      });
      const missing = parr(gap, 'missingVmOrdinals', base);
      if (missing.length !== 1 || missing[0] !== n) {
        fail(`${base}.missingVmOrdinals must be exactly [${n}], got ${JSON.stringify(missing)}`);
      }
      eq(pbool(gap, 'watermarkWedged', base), false, `${base}.watermarkWedged`);
      eq(pbool(gap, 'selfHealedWhenOrdinalReturned', base), true, `${base}.selfHealedWhenOrdinalReturned`);
      pint(gap, 'head', base);
    },
  },
  {
    id: 'A6',
    assertion:
      'zero-eligible / all-denied => observable terminal known-incomplete:no-authorized-provider, never silent retry / empty-success',
    run: (root) => {
      const zero = pobj(root, 'zeroEligibleTerminalOutcome', '$');
      const base = '$.zeroEligibleTerminalOutcome';
      eq(pint(zero, 'eligibleProviderCount', base), 0, `${base}.eligibleProviderCount`);
      eq(pbool(zero, 'allDenied', base), true, `${base}.allDenied`);
      eq(
        pstr(zero, 'terminalState', base),
        'known-incomplete:no-authorized-provider',
        `${base}.terminalState`,
      );
      eq(pbool(zero, 'silentRetry', base), false, `${base}.silentRetry`);
      eq(pbool(zero, 'emptySuccessReported', base), false, `${base}.emptySuccessReported`);
      eq(pbool(zero, 'observableTerminal', base), true, `${base}.observableTerminal`);
    },
  },
  {
    id: 'A7',
    assertion:
      'mid-transfer provider switch resumes at the last verified chunk boundary offset, no re-fetch, integrity independent of provider',
    run: (root) => {
      const ps = pobj(pobj(root, 'multiProviderFailover', '$'), 'providerSwitch', '$.multiProviderFailover');
      const base = '$.multiProviderFailover.providerSwitch';
      pstr(ps, 'priorProvider', base);
      pstr(ps, 'successorProvider', base);
      const total = pint(ps, 'totalChunks', base);
      atLeast(total, 1, `${base}.totalChunks`);
      const boundary = pint(ps, 'lastVerifiedChunkBoundaryOffset', base);
      atLeast(boundary, 1, `${base}.lastVerifiedChunkBoundaryOffset`);
      const resumed = pint(ps, 'resumedAtOffset', base);
      const remaining = pint(ps, 'remainingChunksAfterSwitch', base);
      atLeast(remaining, 1, `${base}.remainingChunksAfterSwitch`);
      eq(resumed, boundary, `${base}.resumedAtOffset (must equal lastVerifiedChunkBoundaryOffset)`);
      if (boundary >= total) fail(`${base}.lastVerifiedChunkBoundaryOffset must be < totalChunks`);
      if (resumed + remaining !== total) {
        fail(`${base}: resumedAtOffset + remainingChunksAfterSwitch must equal totalChunks`);
      }
      eq(pbool(ps, 'refetchedEarlierChunks', base), false, `${base}.refetchedEarlierChunks`);
      eq(
        pbool(ps, 'integrityVerifiedIndependentOfProvider', base),
        true,
        `${base}.integrityVerifiedIndependentOfProvider`,
      );
    },
  },
  {
    id: 'A8',
    assertion:
      'killing the single curator of a PRIVATE CG: members with overlapping locators keep serving; else bounded known-incomplete/unknown-freshness; never false-complete/silent-stall',
    run: (root) => {
      const kill = pobj(
        pobj(root, 'freshCheckpointAuthorityFailover', '$'),
        'privateCgCuratorKill',
        '$.freshCheckpointAuthorityFailover',
      );
      const base = '$.freshCheckpointAuthorityFailover.privateCgCuratorKill';
      eq(pbool(kill, 'curatorKilled', base), true, `${base}.curatorKilled`);
      const holders = pint(kill, 'overlappingLocatorHolderCount', base);
      atLeast(holders, 0, `${base}.overlappingLocatorHolderCount`);
      const serving = pbool(kill, 'membersKeepServing', base);
      const fallback = pstr(kill, 'fallbackState', base);
      eq(pbool(kill, 'falseComplete', base), false, `${base}.falseComplete`);
      eq(pbool(kill, 'silentStall', base), false, `${base}.silentStall`);
      if (holders >= 1) {
        if (!serving) fail(`${base}: members with overlapping locators must keep serving`);
        if (fallback !== 'serving') {
          fail(`${base}.fallbackState must be 'serving' when holders present, got ${fallback}`);
        }
      } else if (!/^bounded:(known-incomplete|unknown-freshness)/u.test(fallback)) {
        fail(`${base}.fallbackState must be a bounded known-incomplete/unknown-freshness state when no holder remains`);
      }
    },
  },
  {
    id: 'A9',
    assertion:
      'after checkpoint expiry: OPEN reports unknown-freshness while serving verified bytes; invite-only refuses new disclosure/join/ingress; higher chain frontier flips freshness',
    run: (root) => {
      const expiry = pobj(
        pobj(root, 'providerContinuation', '$'),
        'checkpointExpiry',
        '$.providerContinuation',
      );
      const base = '$.providerContinuation.checkpointExpiry';
      eq(pbool(expiry, 'checkpointExpired', base), true, `${base}.checkpointExpired`);
      const open = pobj(expiry, 'openMode', base);
      eq(pstr(open, 'freshnessState', `${base}.openMode`), 'unknown-freshness', `${base}.openMode.freshnessState`);
      eq(pbool(open, 'servesVerifiedBytes', `${base}.openMode`), true, `${base}.openMode.servesVerifiedBytes`);
      eq(pbool(open, 'reportsFresh', `${base}.openMode`), false, `${base}.openMode.reportsFresh`);
      eq(pbool(open, 'reportsComplete', `${base}.openMode`), false, `${base}.openMode.reportsComplete`);
      const invite = pobj(expiry, 'inviteOnlyMode', base);
      eq(pbool(invite, 'refusesNewDisclosure', `${base}.inviteOnlyMode`), true, `${base}.inviteOnlyMode.refusesNewDisclosure`);
      eq(pbool(invite, 'refusesJoin', `${base}.inviteOnlyMode`), true, `${base}.inviteOnlyMode.refusesJoin`);
      eq(pbool(invite, 'refusesIngress', `${base}.inviteOnlyMode`), true, `${base}.inviteOnlyMode.refusesIngress`);
      eq(pbool(expiry, 'higherChainFrontierFlipsFreshness', base), true, `${base}.higherChainFrontierFlipsFreshness`);
    },
  },
  {
    id: 'A10',
    assertion:
      'a receiver with a higher anti-rollback high-water than a failover successor holds as authority-history-conflict; wiped-SQLite cold restart does NOT accept a rolled-back checkpoint',
    run: (root) => {
      const ar = pobj(pobj(root, 'crashRestart', '$'), 'antiRollback', '$.crashRestart');
      const base = '$.crashRestart.antiRollback';
      const receiver = pint(ar, 'receiverHighWater', base);
      const successor = pint(ar, 'failoverSuccessorHighWater', base);
      const rolledBack = pint(ar, 'rolledBackCheckpointHighWater', base);
      atLeast(rolledBack, 1, `${base}.rolledBackCheckpointHighWater`);
      if (!(receiver > successor)) {
        fail(`${base}: receiverHighWater must exceed failoverSuccessorHighWater to trigger authority-history-conflict`);
      }
      if (!(rolledBack < successor)) {
        fail(`${base}: rolledBackCheckpointHighWater must be below the successor high-water`);
      }
      eq(pbool(ar, 'rejectedAsAuthorityHistoryConflict', base), true, `${base}.rejectedAsAuthorityHistoryConflict`);
      eq(
        pbool(ar, 'wipedSqliteColdRestartAcceptedRolledBack', base),
        false,
        `${base}.wipedSqliteColdRestartAcceptedRolledBack`,
      );
    },
  },
  {
    id: 'A11',
    assertion:
      'checkpoint-authority failover: passive cannot sign pre-promotion; old cannot sign post; no checkpoint before journal quorum (>=2 replicas in distinct failure domains); crash-after-quorum recovers exact closure; exactly ONE continuing history or explicit unknown-freshness; CA is control-plane only',
    run: (root) => {
      const authority = pobj(
        pobj(root, 'freshCheckpointAuthorityFailover', '$'),
        'authorityFailover',
        '$.freshCheckpointAuthorityFailover',
      );
      const base = '$.freshCheckpointAuthorityFailover.authorityFailover';
      eq(pbool(authority, 'passiveCanSignBeforePromotion', base), false, `${base}.passiveCanSignBeforePromotion`);
      eq(pbool(authority, 'oldCanSignAfterPromotion', base), false, `${base}.oldCanSignAfterPromotion`);
      eq(pbool(authority, 'checkpointAcceptedBeforeQuorum', base), false, `${base}.checkpointAcceptedBeforeQuorum`);
      atLeast(pint(authority, 'journalQuorumReplicas', base), 2, `${base}.journalQuorumReplicas`);
      atLeast(pint(authority, 'distinctFailureDomains', base), 2, `${base}.distinctFailureDomains`);
      eq(
        pbool(authority, 'crashAfterQuorumRecoversExactClosure', base),
        true,
        `${base}.crashAfterQuorumRecoversExactClosure`,
      );
      eq(pint(authority, 'continuingHistories', base), 1, `${base}.continuingHistories`);
      eq(pbool(authority, 'lastWriterWins', base), false, `${base}.lastWriterWins`);
      eq(pstr(authority, 'freshnessOnAmbiguity', base), 'unknown-freshness', `${base}.freshnessOnAmbiguity`);
      eq(pstr(authority, 'checkpointAuthorityRole', base), 'control-plane-only', `${base}.checkpointAuthorityRole`);
      const servedBy = pstr(authority, 'bulkPayloadServedBy', base);
      const healthier = pbool(authority, 'healthierEligibleHolderAvailable', base);
      if (servedBy === 'checkpoint-authority' && healthier) {
        fail(`${base}: checkpoint authority must not serve bulk payload while a healthier eligible holder exists`);
      }
      if (servedBy !== 'eligible-holder') {
        fail(`${base}.bulkPayloadServedBy must be an eligible holder, got ${servedBy}`);
      }
    },
  },
  {
    id: 'A12',
    assertion:
      'a censoring clean-empty peer does NOT clear backoff and is flagged via censorship telemetry',
    run: (root) => {
      const censorship = pobj(pobj(root, 'multiProviderFailover', '$'), 'censorship', '$.multiProviderFailover');
      const base = '$.multiProviderFailover.censorship';
      eq(pbool(censorship, 'peerReturnedCleanEmpty', base), true, `${base}.peerReturnedCleanEmpty`);
      eq(pbool(censorship, 'backoffCleared', base), false, `${base}.backoffCleared`);
      eq(pbool(censorship, 'flaggedViaCensorshipTelemetry', base), true, `${base}.flaggedViaCensorshipTelemetry`);
    },
  },
  {
    id: 'A13',
    assertion:
      'after ownership transfer, a joiner at full parity stays unknown-freshness:ownership-swm-continuity-uncertified permanently',
    run: (root) => {
      const transfer = pobj(
        pobj(root, 'providerContinuation', '$'),
        'ownershipTransfer',
        '$.providerContinuation',
      );
      const base = '$.providerContinuation.ownershipTransfer';
      eq(pbool(transfer, 'ownershipTransferred', base), true, `${base}.ownershipTransferred`);
      eq(pbool(transfer, 'joinerAtFullParity', base), true, `${base}.joinerAtFullParity`);
      eq(
        pstr(transfer, 'freshnessState', base),
        'unknown-freshness:ownership-swm-continuity-uncertified',
        `${base}.freshnessState`,
      );
      eq(pbool(transfer, 'reportedAggregateComplete', base), false, `${base}.reportedAggregateComplete`);
      eq(pbool(transfer, 'permanentUntilCertified', base), true, `${base}.permanentUntilCertified`);
    },
  },
  {
    id: 'A14',
    assertion:
      'network-durable only with >=2 policy-eligible holders in independent failure domains holding signed unexpired hosting receipts + D22 journal; single holder or ingress-accepted receipt is NOT network-durable',
    run: (root) => {
      const durability = pobj(pobj(root, 'coldLateJoin', '$'), 'networkDurability', '$.coldLateJoin');
      const base = '$.coldLateJoin.networkDurability';
      eq(pbool(durability, 'asserted', base), true, `${base}.asserted`);
      const eligible = pint(durability, 'eligibleHolderCount', base);
      const receipts = pint(durability, 'signedUnexpiredHostingReceipts', base);
      const domains = parr(durability, 'failureDomains', base);
      eq(pbool(durability, 'd22JournalPresent', base), true, `${base}.d22JournalPresent`);
      const ingressOnly = pbool(durability, 'ingressAcceptedOnly', base);
      if (eligible < 2) fail(`${base}: network-durable requires >=2 policy-eligible holders`);
      if (receipts < 2) fail(`${base}: network-durable requires >=2 signed unexpired hosting receipts`);
      if (domains.length < 2) fail(`${base}: network-durable requires >=2 independent failure domains`);
      domains.forEach((value, index) => {
        if (typeof value !== 'string') fail(`${base}.failureDomains[${index}] must be a string`);
      });
      if (new Set(domains).size !== domains.length) fail(`${base}.failureDomains must be distinct`);
      if (ingressOnly) fail(`${base}: an ingress-accepted receipt alone is NOT network-durable`);
    },
  },
  {
    id: 'A15',
    assertion:
      'receiver crash mid-apply: applied seals persist, retry skips exact verified rows, no double-apply / false-complete',
    run: (root) => {
      const crash = pobj(pobj(root, 'crashRestart', '$'), 'crashMidApply', '$.crashRestart');
      const base = '$.crashRestart.crashMidApply';
      eq(pbool(crash, 'appliedSealsPersisted', base), true, `${base}.appliedSealsPersisted`);
      eq(pbool(crash, 'retrySkipsVerifiedRows', base), true, `${base}.retrySkipsVerifiedRows`);
      eq(pbool(crash, 'doubleApplied', base), false, `${base}.doubleApplied`);
      eq(pbool(crash, 'falseComplete', base), false, `${base}.falseComplete`);
      const skipped = pint(crash, 'verifiedRowsSkippedCount', base);
      atLeast(skipped, 1, `${base}.verifiedRowsSkippedCount`);
      const applied = pint(crash, 'appliedRowCount', base);
      if (skipped >= applied) fail(`${base}: verified rows skipped on retry must be fewer than applied rows`);
    },
  },
  {
    id: 'A16',
    assertion:
      'oracle = syncState+freshnessState+knownIncompleteReasons+missingVmOrdinals+networkDurabilitySummary (NOT store parity); syncState in the closed enum',
    run: (root) => {
      const oracle = pobj(pobj(root, 'appliedSealAndPostReads', '$'), 'oracle', '$.appliedSealAndPostReads');
      const base = '$.appliedSealAndPostReads.oracle';
      const syncState = pstr(oracle, 'syncState', base);
      if (!(SYNC_STATES as readonly string[]).includes(syncState)) {
        fail(`${base}.syncState must be one of ${SYNC_STATES.join('|')}, got ${syncState}`);
      }
      const freshness = pstr(oracle, 'freshnessState', base);
      if (!(FRESHNESS_STATES as readonly string[]).includes(freshness)) {
        fail(`${base}.freshnessState invalid: ${freshness}`);
      }
      const reasons = parr(oracle, 'knownIncompleteReasons', base);
      const missing = parr(oracle, 'missingVmOrdinals', base);
      const summary = pstr(oracle, 'networkDurabilitySummary', base);
      if (!(NETWORK_DURABILITY_SUMMARIES as readonly string[]).includes(summary)) {
        fail(`${base}.networkDurabilitySummary invalid: ${summary}`);
      }
      reasons.forEach((value, index) => {
        if (typeof value !== 'string') fail(`${base}.knownIncompleteReasons[${index}] must be a string`);
      });
      missing.forEach((value, index) => {
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          fail(`${base}.missingVmOrdinals[${index}] must be an integer`);
        }
      });
      if (syncState === 'complete') {
        if (reasons.length !== 0) fail(`${base}: a complete syncState must carry zero knownIncompleteReasons`);
        if (missing.length !== 0) fail(`${base}: a complete syncState must carry zero missingVmOrdinals`);
      }
    },
  },
  {
    id: 'A17',
    assertion:
      'forged/wrong-author row => receiver applies ZERO of it; applied-inventory readback == authored candidate/catalog set exactly (authored row set == applied row == inventory-set-root leaf count)',
    run: (root) => {
      const clj = pobj(root, 'coldLateJoin', '$');
      const aspr = pobj(root, 'appliedSealAndPostReads', '$');
      const crash = pobj(pobj(root, 'crashRestart', '$'), 'crashMidApply', '$.crashRestart');
      const readback = pobj(aspr, 'appliedInventoryReadback', '$.appliedSealAndPostReads');
      const base = '$.appliedSealAndPostReads.appliedInventoryReadback';
      eq(pbool(readback, 'matchesAuthoredCandidateSet', base), true, `${base}.matchesAuthoredCandidateSet`);
      eq(pint(readback, 'forgedOrWrongAuthorRowsApplied', base), 0, `${base}.forgedOrWrongAuthorRowsApplied`);
      const inventory = pobj(aspr, 'inventorySetRoot', '$.appliedSealAndPostReads');
      pdigest(inventory, 'digest', '$.appliedSealAndPostReads.inventorySetRoot');
      agree(
        [
          ['appliedInventoryReadback.authoredCandidateSetCount', pint(readback, 'authoredCandidateSetCount', base)],
          ['appliedInventoryReadback.appliedSetCount', pint(readback, 'appliedSetCount', base)],
          ['appliedRowCount', pint(aspr, 'appliedRowCount', '$.appliedSealAndPostReads')],
          ['inventorySetRoot.leafCount', pint(inventory, 'leafCount', '$.appliedSealAndPostReads.inventorySetRoot')],
          ['coldLateJoin.authoredRowSetCount', pint(clj, 'authoredRowSetCount', '$.coldLateJoin')],
          ['crashMidApply.appliedRowCount', pint(crash, 'appliedRowCount', '$.crashRestart.crashMidApply')],
        ],
        'authored row set == applied row == inventory-set-root leaf count',
      );
    },
  },
  {
    id: 'A18',
    assertion:
      'content whose recomputed content root != chain merkleRoot is NOT promoted; bundle/chunk-tree roots and chunk proofs recorded as fields, not inferred',
    run: (root) => {
      const promotion = pobj(
        pobj(root, 'appliedSealAndPostReads', '$'),
        'contentPromotion',
        '$.appliedSealAndPostReads',
      );
      const base = '$.appliedSealAndPostReads.contentPromotion';
      pdigest(promotion, 'bundleRoot', base);
      pdigest(promotion, 'chunkTreeRoot', base);
      eq(pbool(promotion, 'chunkProofsRecorded', base), true, `${base}.chunkProofsRecorded`);
      eq(pbool(promotion, 'rootMatchInferred', base), false, `${base}.rootMatchInferred`);
      agree(
        [
          ['recomputedContentRoot', pdigest(promotion, 'recomputedContentRoot', base)],
          ['chainMerkleRoot', pdigest(promotion, 'chainMerkleRoot', base)],
        ],
        'recomputed content root == chain merkleRoot',
      );
      eq(pbool(promotion, 'promoted', base), true, `${base}.promoted`);
    },
  },
  {
    id: 'A19',
    assertion:
      'SWM admission accepted only after commit by the named checkpoint; overload sheds via queued/rejected with a frozen deterministic reason; bounded max queue age + per-principal fairness',
    run: (root) => {
      const admission = pobj(
        pobj(root, 'freshCheckpointAuthorityFailover', '$'),
        'swmAdmission',
        '$.freshCheckpointAuthorityFailover',
      );
      const base = '$.freshCheckpointAuthorityFailover.swmAdmission';
      eq(
        pbool(admission, 'acceptedOnlyAfterCommitByNamedCheckpoint', base),
        true,
        `${base}.acceptedOnlyAfterCommitByNamedCheckpoint`,
      );
      pdigest(admission, 'namedCheckpointHeadDigest', base);
      eq(pstr(admission, 'overloadShedMode', base), 'queued-or-rejected', `${base}.overloadShedMode`);
      const reason = pstr(admission, 'shedReason', base);
      if (!reason.startsWith('deterministic-frozen-reason:')) {
        fail(`${base}.shedReason must be a deterministic frozen reason, got ${reason}`);
      }
      eq(pbool(admission, 'maxQueueAgeBounded', base), true, `${base}.maxQueueAgeBounded`);
      eq(pbool(admission, 'perPrincipalFairness', base), true, `${base}.perPrincipalFairness`);
    },
  },
  {
    id: 'A20',
    assertion:
      'failover latency bounded per a 4s-per-endpoint attempt budget, measured against observed dead-peer re-selection (NOT the 5-minute reconciler backoff)',
    run: (root) => {
      const latency = pobj(
        pobj(root, 'multiProviderFailover', '$'),
        'failoverLatency',
        '$.multiProviderFailover',
      );
      const base = '$.multiProviderFailover.failoverLatency';
      eq(pint(latency, 'perEndpointAttemptBudgetMs', base), 4000, `${base}.perEndpointAttemptBudgetMs`);
      const attempts = pint(latency, 'endpointAttempts', base);
      atLeast(attempts, 1, `${base}.endpointAttempts`);
      const totalBudget = pint(latency, 'totalFailoverBudgetMs', base);
      if (totalBudget !== 4000 * attempts) {
        fail(`${base}.totalFailoverBudgetMs must equal perEndpointAttemptBudgetMs * endpointAttempts`);
      }
      const observed = pint(latency, 'observedDeadPeerReselectionMs', base);
      atLeast(observed, 1, `${base}.observedDeadPeerReselectionMs`);
      eq(pstr(latency, 'measuredAgainst', base), 'observed-dead-peer-reselection', `${base}.measuredAgainst`);
      eq(pint(latency, 'reconcilerBackoffMs', base), 300000, `${base}.reconcilerBackoffMs`);
      eq(pbool(latency, 'withinBudget', base), true, `${base}.withinBudget`);
      if (observed > totalBudget) {
        fail(`${base}: observed dead-peer re-selection exceeded the per-endpoint attempt budget`);
      }
    },
  },
];

export function verifyGate2(raw: unknown): Gate2Verdict {
  const violations: VerdictViolation[] = [];
  const checks: VerdictCheck[] = [];

  for (const guard of GUARDS) {
    try {
      guard.run(raw);
    } catch (error) {
      violations.push({ id: guard.id, assertion: guard.assertion, detail: describe(error) });
    }
  }

  for (const check of CHECKS) {
    let ok = true;
    let detail = 'ok';
    try {
      const root = asObject(raw, '$');
      check.run(root);
    } catch (error) {
      ok = false;
      detail = describe(error);
      violations.push({ id: check.id, assertion: check.assertion, detail });
    }
    checks.push({ id: check.id, assertion: check.assertion, ok, detail });
  }

  const status: Gate2Verdict['status'] =
    violations.length === 0 ? 'contract-satisfied' : 'contract-violated';

  return {
    schemaVersion: GATE2_VERDICT_SCHEMA_VERSION,
    contract: GATE2_CONTRACT,
    status,
    productBoundary: GATE2_PRODUCT_BOUNDARY as 'not-connected',
    gateEvaluation: GATE2_GATE_EVALUATION as 'not-evaluated',
    sourceReview: GATE2_SOURCE_REVIEW,
    sourceCommit: GATE2_SOURCE_COMMIT,
    checks,
    violations,
  };
}

function assertShape(golden: unknown, actual: unknown, path: string): void {
  if (Array.isArray(golden)) {
    if (!Array.isArray(actual)) fail(`${path} must be an array`);
    return;
  }
  if (golden !== null && typeof golden === 'object') {
    const record = asObject(actual, path);
    const goldenKeys = Object.keys(golden as Record<string, unknown>).sort(compareCodeUnits);
    const actualKeys = Object.keys(record).sort(compareCodeUnits);
    if (
      goldenKeys.length !== actualKeys.length
      || goldenKeys.some((key, index) => key !== actualKeys[index])
    ) {
      fail(`${path} key set does not match the closed contract shape: ${JSON.stringify(actualKeys)}`);
    }
    for (const key of goldenKeys) {
      assertShape(
        (golden as Record<string, unknown>)[key],
        record[key],
        `${path}.${key}`,
      );
    }
    return;
  }
  if (typeof actual !== typeof golden) {
    fail(`${path} must be of type ${typeof golden}, got ${typeof actual}`);
  }
}

function scanForProductPassMarkers(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForProductPassMarkers(entry, `${path}[${index}]`, out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      const normalized = key.replace(/[-_]/gu, '').toLowerCase();
      if (/(gatepassed|passedagainstproduct|productgatepassed|gate2pass|gatetwopass|productpass)/u.test(normalized)) {
        out.push(`${path}.${key}`);
      }
      scanForProductPassMarkers(nested, `${path}.${key}`, out);
    }
    return;
  }
  if (typeof value === 'string') {
    if (/(gate[\s-]*2[\s-]*passed|gate2passed|passed[\s-]*against[\s-]*product)/iu.test(value)) {
      out.push(`${path}=${value}`);
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof ContractError) return error.message;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
