import {
  GATE3_CONTRACT,
  GATE3_GATE_EVALUATION,
  GATE3_GENERATED_BY,
  GATE3_PRODUCT_BOUNDARY,
  GATE3_RAW_SCHEMA_VERSION,
  GATE3_SOURCE_COMMIT,
  GATE3_SOURCE_REVIEW,
  buildGate3RawEvidence,
} from './raw-evidence.js';

/**
 * RFC-64 Gate 3 "cold late-join" verdict schema + fail-closed verifier.
 *
 * verifyGate3() never throws on bad input: any missing / type-wrong /
 * uncross-bound field, any scenario that fails its acceptance assertion, an
 * unknown extra field, a wrong productBoundary/gateEvaluation, or a
 * product-gate-pass marker yields a `contract-violated` verdict carrying a
 * specific violation. The verdict ALWAYS self-declares productBoundary=
 * "not-connected" and gateEvaluation="not-evaluated" so it can never be read as
 * a real Gate 3 product pass.
 */

export const GATE3_VERDICT_SCHEMA_VERSION =
  'dkg-rfc64-gate3-cold-late-join-verdict-v1';

const DIGEST_PATTERN = /^0x[0-9a-f]{64}$/u;
const AUTHORITY_ID_PATTERN = /^rfc64-head-authority-[0-9a-f]{64}$/u;
const ISO_UTC_MILLIS_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const TOP_LEVEL_KEYS = [
  'schemaVersion',
  'contract',
  'productBoundary',
  'gateEvaluation',
  'generatedBy',
  'sourceReview',
  'sourceCommit',
  'noPriorAnnouncement',
  'authenticatedCurrentHeadDiscovery',
  'boundedPredecessorBootstrap',
  'exactConvergence',
  'receiverRestart',
  'authorizationNegativeUnchanged',
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

export interface Gate3Verdict {
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

/** Validate every element of an already-fetched string array as a digest. */
function eachDigest(values: readonly unknown[], path: string): readonly string[] {
  values.forEach((value, index) => {
    if (typeof value !== 'string') fail(`${path}[${index}] must be a string`);
    if (!DIGEST_PATTERN.test(value)) fail(`${path}[${index}] must be a 0x + 64 hex digest`);
  });
  return values as readonly string[];
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
      eq(pstr(root, 'schemaVersion', '$'), GATE3_RAW_SCHEMA_VERSION, '$.schemaVersion');
      eq(pstr(root, 'contract', '$'), GATE3_CONTRACT, '$.contract');
      eq(pstr(root, 'generatedBy', '$'), GATE3_GENERATED_BY, '$.generatedBy');
      eq(pstr(root, 'sourceReview', '$'), GATE3_SOURCE_REVIEW, '$.sourceReview');
      eq(pstr(root, 'sourceCommit', '$'), GATE3_SOURCE_COMMIT, '$.sourceCommit');
    },
  },
  {
    id: 'GUARD-product-boundary',
    assertion: 'productBoundary must be "not-connected" (fixtures-only, never product)',
    run: (raw) => {
      const root = asObject(raw, '$');
      eq(pstr(root, 'productBoundary', '$'), GATE3_PRODUCT_BOUNDARY, '$.productBoundary');
    },
  },
  {
    id: 'GUARD-gate-evaluation',
    assertion:
      'gateEvaluation must be "not-evaluated" (harness never evaluates the product gate)',
    run: (raw) => {
      const root = asObject(raw, '$');
      eq(pstr(root, 'gateEvaluation', '$'), GATE3_GATE_EVALUATION, '$.gateEvaluation');
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
      assertShape(buildGate3RawEvidence() as unknown, raw, '$');
    },
  },
];

const CHECKS: readonly CheckSpec[] = [
  {
    id: 'G3-A1',
    assertion:
      'publisher catalog was sealed strictly BEFORE the receiver started (cross-bound era + ISO timestamp)',
    run: (root) => {
      const publisher = pobj(pobj(root, 'exactConvergence', '$'), 'publisher', '$.exactConvergence');
      const cold = pobj(root, 'noPriorAnnouncement', '$');
      const pubEra = pint(publisher, 'catalogSealedAtEra', '$.exactConvergence.publisher');
      const recEra = pint(cold, 'receiverStartedAtEra', '$.noPriorAnnouncement');
      const pubIso = pstr(publisher, 'catalogSealedAt', '$.exactConvergence.publisher');
      const recIso = pstr(cold, 'receiverStartedAt', '$.noPriorAnnouncement');
      if (!ISO_UTC_MILLIS_PATTERN.test(pubIso)) {
        fail('$.exactConvergence.publisher.catalogSealedAt must be an ISO-8601 UTC millis timestamp');
      }
      if (!ISO_UTC_MILLIS_PATTERN.test(recIso)) {
        fail('$.noPriorAnnouncement.receiverStartedAt must be an ISO-8601 UTC millis timestamp');
      }
      if (!(pubEra < recEra)) {
        fail(
          `publisher catalog era must precede receiver start era: ${pubEra} !< ${recEra}`,
        );
      }
      if (!(pubIso < recIso)) {
        fail(
          `publisher catalogSealedAt must precede receiverStartedAt: ${pubIso} !< ${recIso}`,
        );
      }
    },
  },
  {
    id: 'G3-A2',
    assertion:
      'the cold receiver started EMPTY: emptyStartMarker==true and initialAppliedInventoryCount==0',
    run: (root) => {
      const cold = pobj(root, 'noPriorAnnouncement', '$');
      eq(pbool(cold, 'emptyStartMarker', '$.noPriorAnnouncement'), true, '$.noPriorAnnouncement.emptyStartMarker');
      eq(
        pint(cold, 'initialAppliedInventoryCount', '$.noPriorAnnouncement'),
        0,
        '$.noPriorAnnouncement.initialAppliedInventoryCount',
      );
    },
  },
  {
    id: 'G3-A3',
    assertion:
      'convergence began with NO prior live announcement: pull-driven from cold, not dependent on the original announce',
    run: (root) => {
      const cold = pobj(root, 'noPriorAnnouncement', '$');
      eq(
        pbool(cold, 'liveAnnouncementConsumed', '$.noPriorAnnouncement'),
        false,
        '$.noPriorAnnouncement.liveAnnouncementConsumed',
      );
      eq(
        pstr(cold, 'discoveryMode', '$.noPriorAnnouncement'),
        'pull-driven-from-cold',
        '$.noPriorAnnouncement.discoveryMode',
      );
      eq(
        pbool(cold, 'dependsOnOriginalAnnounce', '$.noPriorAnnouncement'),
        false,
        '$.noPriorAnnouncement.dependsOnOriginalAnnounce',
      );
    },
  },
  {
    id: 'G3-A4',
    assertion:
      'discovered head == publisher authored head == the head the receiver applies; authorization verified; head is current (not stale/superseded)',
    run: (root) => {
      const disc = pobj(root, 'authenticatedCurrentHeadDiscovery', '$');
      const publisher = pobj(pobj(root, 'exactConvergence', '$'), 'publisher', '$.exactConvergence');
      const receiver = pobj(pobj(root, 'exactConvergence', '$'), 'receiver', '$.exactConvergence');
      const base = '$.authenticatedCurrentHeadDiscovery';
      const discovered = pdigest(disc, 'discoveredHeadDigest', base);
      agree(
        [
          ['discoveredHeadDigest', discovered],
          ['publisher.authoredHeadDigest', pdigest(publisher, 'authoredHeadDigest', '$.exactConvergence.publisher')],
          ['receiver.appliedHeadDigest', pdigest(receiver, 'appliedHeadDigest', '$.exactConvergence.receiver')],
        ],
        'publisher authoredHead == discovered head == receiver appliedHead',
      );
      eq(pbool(disc, 'headApplied', base), true, `${base}.headApplied`);
      eq(pbool(disc, 'headIsCurrent', base), true, `${base}.headIsCurrent`);
      const auth = pobj(disc, 'headAuthorization', base);
      eq(pbool(auth, 'verified', `${base}.headAuthorization`), true, `${base}.headAuthorization.verified`);
      const authorityId = pstr(auth, 'authorityId', `${base}.headAuthorization`);
      if (!AUTHORITY_ID_PATTERN.test(authorityId)) {
        fail(`${base}.headAuthorization.authorityId is malformed`);
      }
      pdigest(auth, 'signatureDigest', `${base}.headAuthorization`);
      // Current head is not superseded: the frontier is exactly the discovered head
      // and no superseded candidates were accepted over it.
      eq(pdigest(disc, 'frontierHeadDigest', base), discovered, `${base}.frontierHeadDigest`);
      const superseded = parr(disc, 'supersededCandidateDigests', base);
      eachDigest(superseded, `${base}.supersededCandidateDigests`);
      if (superseded.length !== 0) {
        fail(`${base}.supersededCandidateDigests must be empty when the head is current`);
      }
    },
  },
  {
    id: 'G3-A5',
    assertion:
      'predecessor bootstrap terminated within a FINITE, positive declared bound (no unbounded walk); walked chain length == steps',
    run: (root) => {
      const bpb = pobj(root, 'boundedPredecessorBootstrap', '$');
      const base = '$.boundedPredecessorBootstrap';
      const steps = pint(bpb, 'predecessorBootstrapSteps', base);
      atLeast(steps, 0, `${base}.predecessorBootstrapSteps`);
      const bound = pint(bpb, 'declaredBound', base);
      if (bound <= 0) fail(`${base}.declaredBound must be a finite positive integer, got ${bound}`);
      eq(pbool(bpb, 'boundIsFinite', base), true, `${base}.boundIsFinite`);
      eq(pbool(bpb, 'walkTerminatedWithinBound', base), true, `${base}.walkTerminatedWithinBound`);
      if (steps > bound) {
        fail(`${base}: predecessorBootstrapSteps (${steps}) exceeded declaredBound (${bound})`);
      }
      const chain = parr(bpb, 'predecessorChainDigests', base);
      eachDigest(chain, `${base}.predecessorChainDigests`);
      if (chain.length !== steps) {
        fail(`${base}.predecessorChainDigests length (${chain.length}) must equal steps (${steps})`);
      }
    },
  },
  {
    id: 'G3-A6',
    assertion:
      'EXACT convergence: receiver inventory-set root == publisher root; applied row count == authored row count == inventory leaf count == array lengths; every applied row digest == authored digest; no missing/extra/duplicate',
    run: (root) => {
      const ec = pobj(root, 'exactConvergence', '$');
      const publisher = pobj(ec, 'publisher', '$.exactConvergence');
      const receiver = pobj(ec, 'receiver', '$.exactConvergence');
      agree(
        [
          ['publisher.inventorySetRoot', pdigest(publisher, 'inventorySetRoot', '$.exactConvergence.publisher')],
          ['receiver.inventorySetRoot', pdigest(receiver, 'inventorySetRoot', '$.exactConvergence.receiver')],
        ],
        'publisher inventorySetRoot == receiver inventorySetRoot',
      );
      const authored = eachDigest(
        parr(ec, 'authoredRowDigests', '$.exactConvergence'),
        '$.exactConvergence.authoredRowDigests',
      );
      const applied = eachDigest(
        parr(ec, 'appliedRowDigests', '$.exactConvergence'),
        '$.exactConvergence.appliedRowDigests',
      );
      agree(
        [
          ['publisher.authoredRowCount', pint(publisher, 'authoredRowCount', '$.exactConvergence.publisher')],
          ['receiver.appliedRowCount', pint(receiver, 'appliedRowCount', '$.exactConvergence.receiver')],
          ['inventoryLeafCount', pint(ec, 'inventoryLeafCount', '$.exactConvergence')],
          ['authoredRowDigests.length', authored.length],
          ['appliedRowDigests.length', applied.length],
        ],
        'authored row count == applied row count == inventory leaf count == array lengths',
      );
      if (authored.length < 1) fail('$.exactConvergence.authoredRowDigests must be non-empty');
      applied.forEach((digest, index) => {
        if (digest !== authored[index]) {
          fail(`$.exactConvergence.appliedRowDigests[${index}] (${digest}) != authored (${authored[index]})`);
        }
      });
      if (new Set(authored).size !== authored.length) {
        fail('$.exactConvergence.authoredRowDigests contains duplicates');
      }
      if (new Set(applied).size !== applied.length) {
        fail('$.exactConvergence.appliedRowDigests contains duplicates');
      }
      eq(pint(ec, 'missingRowCount', '$.exactConvergence'), 0, '$.exactConvergence.missingRowCount');
      eq(pint(ec, 'extraRowCount', '$.exactConvergence'), 0, '$.exactConvergence.extraRowCount');
      eq(pint(ec, 'duplicateRowCount', '$.exactConvergence'), 0, '$.exactConvergence.duplicateRowCount');
    },
  },
  {
    id: 'G3-A7',
    assertion:
      'restart preserved convergence: applied inventory-set root unchanged, applied row count unchanged, refetchedFromZero==false, convergenceHeld==true, same head',
    run: (root) => {
      const rr = pobj(root, 'receiverRestart', '$');
      const ec = pobj(root, 'exactConvergence', '$');
      const receiver = pobj(ec, 'receiver', '$.exactConvergence');
      const base = '$.receiverRestart';
      atLeast(pint(rr, 'restartCount', base), 1, `${base}.restartCount`);
      agree(
        [
          ['receiverRestart.appliedInventorySetRoot', pdigest(rr, 'appliedInventorySetRoot', base)],
          ['exactConvergence.receiver.inventorySetRoot', pdigest(receiver, 'inventorySetRoot', '$.exactConvergence.receiver')],
        ],
        'applied inventory-set root unchanged across restart',
      );
      agree(
        [
          ['receiverRestart.appliedRowCount', pint(rr, 'appliedRowCount', base)],
          ['exactConvergence.receiver.appliedRowCount', pint(receiver, 'appliedRowCount', '$.exactConvergence.receiver')],
        ],
        'applied row count unchanged across restart',
      );
      agree(
        [
          ['receiverRestart.appliedHeadDigest', pdigest(rr, 'appliedHeadDigest', base)],
          ['exactConvergence.receiver.appliedHeadDigest', pdigest(receiver, 'appliedHeadDigest', '$.exactConvergence.receiver')],
        ],
        'applied head unchanged across restart',
      );
      eq(pbool(rr, 'refetchedFromZero', base), false, `${base}.refetchedFromZero`);
      eq(pbool(rr, 'convergenceHeld', base), true, `${base}.convergenceHeld`);
    },
  },
  {
    id: 'G3-A8',
    assertion:
      'authorization-negative is fail-closed: an invalidly-authorized head applies ZERO rows and the post-state root == pre-state root == the converged root (state unchanged)',
    run: (root) => {
      const an = pobj(root, 'authorizationNegativeUnchanged', '$');
      const receiver = pobj(pobj(root, 'exactConvergence', '$'), 'receiver', '$.exactConvergence');
      const publisher = pobj(pobj(root, 'exactConvergence', '$'), 'publisher', '$.exactConvergence');
      const base = '$.authorizationNegativeUnchanged';
      eq(pbool(an, 'invalidHeadAuthorizationVerified', base), false, `${base}.invalidHeadAuthorizationVerified`);
      eq(pint(an, 'rowsAppliedFromInvalidHead', base), 0, `${base}.rowsAppliedFromInvalidHead`);
      const pre = pdigest(an, 'preStateRoot', base);
      const post = pdigest(an, 'postStateRoot', base);
      agree(
        [
          ['preStateRoot', pre],
          ['postStateRoot', post],
        ],
        'post-state root == pre-state root (state unchanged)',
      );
      agree(
        [
          ['preStateRoot', pre],
          ['exactConvergence.receiver.inventorySetRoot', pdigest(receiver, 'inventorySetRoot', '$.exactConvergence.receiver')],
        ],
        'the unchanged state IS the converged inventory-set root',
      );
      eq(pbool(an, 'stateUnchanged', base), true, `${base}.stateUnchanged`);
      const invalid = pdigest(an, 'invalidHeadDigest', base);
      if (invalid === pdigest(publisher, 'authoredHeadDigest', '$.exactConvergence.publisher')) {
        fail(`${base}.invalidHeadDigest must differ from the authentic authored head`);
      }
      eachDigest(parr(an, 'rejectedRowDigests', base), `${base}.rejectedRowDigests`);
    },
  },
  {
    id: 'G3-A9',
    assertion:
      'boundary: productBoundary == "not-connected" AND gateEvaluation == "not-evaluated" (fixtures-only, never a product pass)',
    run: (root) => {
      eq(pstr(root, 'productBoundary', '$'), GATE3_PRODUCT_BOUNDARY, '$.productBoundary');
      eq(pstr(root, 'gateEvaluation', '$'), GATE3_GATE_EVALUATION, '$.gateEvaluation');
    },
  },
];

export function verifyGate3(raw: unknown): Gate3Verdict {
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

  const status: Gate3Verdict['status'] =
    violations.length === 0 ? 'contract-satisfied' : 'contract-violated';

  return {
    schemaVersion: GATE3_VERDICT_SCHEMA_VERSION,
    contract: GATE3_CONTRACT,
    status,
    productBoundary: GATE3_PRODUCT_BOUNDARY as 'not-connected',
    gateEvaluation: GATE3_GATE_EVALUATION as 'not-evaluated',
    sourceReview: GATE3_SOURCE_REVIEW,
    sourceCommit: GATE3_SOURCE_COMMIT,
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
      if (/(gatepassed|passedagainstproduct|productgatepassed|gate3pass|gatethreepass|productpass)/u.test(normalized)) {
        out.push(`${path}.${key}`);
      }
      scanForProductPassMarkers(nested, `${path}.${key}`, out);
    }
    return;
  }
  if (typeof value === 'string') {
    if (/(gate[\s-]*3[\s-]*passed|gate3passed|passed[\s-]*against[\s-]*product)/iu.test(value)) {
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
