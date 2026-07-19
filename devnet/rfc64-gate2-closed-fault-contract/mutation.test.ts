import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import { buildGate2RawEvidence, sha256Hex, stableJson } from './raw-evidence.js';
import { verifyGate2 } from './verdict.js';

/**
 * Pinned deterministic digests of the golden raw evidence and its verdict.
 * These are the exact SHA-256 values printed by `run.ts` (RAW_SHA256) and
 * `verify.ts` (VERDICT_SHA256) and are asserted byte-identical across runs.
 */
const PINNED_RAW_SHA256 =
  '0ac36a8e5dbebe35a0fdfa7f8dedc79c5f2a49fafdc1c7dbd61cc698c3e8a2c0';
const PINNED_VERDICT_SHA256 =
  '7dfbca04f77203dc010a53963a1189ea3f4c9383dfd936efb529a7b17dcbe634';

type JsonPath = readonly (string | number)[];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clone(): any {
  return structuredClone(buildGate2RawEvidence());
}

function expectViolated(raw: unknown, expectedId: string, label: string): void {
  const verdict = verifyGate2(raw);
  assert.equal(
    verdict.status,
    'contract-violated',
    `${label}: expected contract-violated, got ${verdict.status}`,
  );
  const ids = verdict.violations.map((violation) => violation.id);
  assert.ok(
    ids.includes(expectedId),
    `${label}: expected a violation naming ${expectedId}, got [${ids.join(', ')}]`,
  );
  // Fail-closed verdicts must never masquerade as a product gate pass.
  assert.equal(verdict.productBoundary, 'not-connected', `${label}: productBoundary`);
  assert.equal(verdict.gateEvaluation, 'not-evaluated', `${label}: gateEvaluation`);
}

test('positive: the unmutated golden fixture is contract-satisfied and never a product pass', () => {
  const verdict = verifyGate2(buildGate2RawEvidence());
  assert.equal(verdict.status, 'contract-satisfied');
  assert.equal(verdict.productBoundary, 'not-connected');
  assert.equal(verdict.gateEvaluation, 'not-evaluated');
  assert.equal(verdict.violations.length, 0);
  assert.equal(verdict.checks.length, 20);
  assert.ok(verdict.checks.every((check) => check.ok));
  const ids = verdict.checks.map((check) => check.id);
  for (let index = 1; index <= 20; index += 1) {
    assert.ok(ids.includes(`A${index}`), `missing acceptance check A${index}`);
  }
});

test('two-run determinism: raw + verdict are byte-identical and match the pinned SHA-256', () => {
  const rawA = stableJson(buildGate2RawEvidence());
  const rawB = stableJson(buildGate2RawEvidence());
  assert.equal(rawA, rawB, 'raw serialization is not byte-identical across runs');
  assert.equal(sha256Hex(Buffer.from(rawA)), PINNED_RAW_SHA256, 'raw SHA-256 drifted from pin');

  const verdictA = stableJson(verifyGate2(buildGate2RawEvidence()));
  const verdictB = stableJson(verifyGate2(buildGate2RawEvidence()));
  assert.equal(verdictA, verdictB, 'verdict serialization is not byte-identical across runs');
  assert.equal(
    sha256Hex(Buffer.from(verdictA)),
    PINNED_VERDICT_SHA256,
    'verdict SHA-256 drifted from pin',
  );
});

// ---------------------------------------------------------------------------
// The 18 fault points. Each starts from the golden fixture, breaks exactly one
// invariant, and asserts verifyGate2 returns contract-violated with a violation
// naming the acceptance check that owns that invariant.
// ---------------------------------------------------------------------------

test('F1 -> A4: cold receiver never started empty', () => {
  const raw = clone();
  raw.coldLateJoin.emptyStartMarker.startedEmpty = false;
  raw.coldLateJoin.emptyStartMarker.observedInitialKaCount = 1;
  expectViolated(raw, 'A4', 'F1');
});

test('F2 -> A11: checkpoint authority used as bulk payload path while a healthier holder existed', () => {
  const raw = clone();
  raw.freshCheckpointAuthorityFailover.authorityFailover.bulkPayloadServedBy = 'checkpoint-authority';
  raw.freshCheckpointAuthorityFailover.authorityFailover.healthierEligibleHolderAvailable = true;
  expectViolated(raw, 'A11', 'F2');
});

test('F3 -> A5: ordinal N un-fetchable but N+1..N+k NOT materialized (contiguity wedge)', () => {
  const raw = clone();
  raw.watermarkGapReporting.laterOrdinalsMaterialized = [];
  raw.watermarkGapReporting.watermarkWedged = true;
  expectViolated(raw, 'A5', 'F3');
});

test('F4 -> A6: zero eligible peers yet outcome not terminal (retry / empty-success)', () => {
  const raw = clone();
  raw.zeroEligibleTerminalOutcome.terminalState = 'retrying';
  raw.zeroEligibleTerminalOutcome.silentRetry = true;
  expectViolated(raw, 'A6', 'F4');
});

test('F5 -> A15: crash mid-apply then double-application / lost applied seal', () => {
  const raw = clone();
  raw.crashRestart.crashMidApply.doubleApplied = true;
  raw.crashRestart.crashMidApply.appliedSealsPersisted = false;
  expectViolated(raw, 'A15', 'F5');
});

test('F6 -> A7: provider switch restarts from offset 0 instead of the verified chunk boundary', () => {
  const raw = clone();
  raw.multiProviderFailover.providerSwitch.resumedAtOffset = 0;
  raw.multiProviderFailover.providerSwitch.refetchedEarlierChunks = true;
  expectViolated(raw, 'A7', 'F6');
});

test('F7 -> A8: curator killed with >=2 holders but serving stopped / false-complete', () => {
  const raw = clone();
  raw.freshCheckpointAuthorityFailover.privateCgCuratorKill.membersKeepServing = false;
  raw.freshCheckpointAuthorityFailover.privateCgCuratorKill.fallbackState = 'stopped';
  raw.freshCheckpointAuthorityFailover.privateCgCuratorKill.falseComplete = true;
  expectViolated(raw, 'A8', 'F7');
});

test('F8 -> A11: checkpoint-authority failover accepts two histories (last-writer-wins)', () => {
  const raw = clone();
  raw.freshCheckpointAuthorityFailover.authorityFailover.continuingHistories = 2;
  raw.freshCheckpointAuthorityFailover.authorityFailover.lastWriterWins = true;
  expectViolated(raw, 'A11', 'F8');
});

test('F9 -> A12: censoring clean-empty peer cleared backoff / not flagged', () => {
  const raw = clone();
  raw.multiProviderFailover.censorship.backoffCleared = true;
  raw.multiProviderFailover.censorship.flaggedViaCensorshipTelemetry = false;
  expectViolated(raw, 'A12', 'F9');
});

test('F10 -> A9: checkpoint expired but still reports fresh/complete (OPEN)', () => {
  const raw = clone();
  raw.providerContinuation.checkpointExpiry.openMode.reportsFresh = true;
  raw.providerContinuation.checkpointExpiry.openMode.reportsComplete = true;
  expectViolated(raw, 'A9', 'F10');
});

test('F11 -> A10: wiped-SQLite cold restart accepted a rolled-back signed checkpoint', () => {
  const raw = clone();
  raw.crashRestart.antiRollback.wipedSqliteColdRestartAcceptedRolledBack = true;
  expectViolated(raw, 'A10', 'F11');
});

test('F12 -> A13: ownership-transfer joiner reported aggregate complete instead of uncertified', () => {
  const raw = clone();
  raw.providerContinuation.ownershipTransfer.reportedAggregateComplete = true;
  raw.providerContinuation.ownershipTransfer.freshnessState = 'complete';
  expectViolated(raw, 'A13', 'F12');
});

test('F13 -> A14: network-durable asserted with a single holder / ingress-accepted receipt', () => {
  const raw = clone();
  raw.coldLateJoin.networkDurability.eligibleHolderCount = 1;
  raw.coldLateJoin.networkDurability.ingressAcceptedOnly = true;
  expectViolated(raw, 'A14', 'F13');
});

test('F14 -> A2: completion claimed while watermark < head (D9 false-complete)', () => {
  const raw = clone();
  raw.appliedSealAndPostReads.completion.watermark = 127;
  expectViolated(raw, 'A2', 'F14');
});

test('F15 -> A3: head taken from raw enumeration count != authored-catalog cardinality', () => {
  const raw = clone();
  raw.coldLateJoin.rawEnumerationCount = 130;
  raw.coldLateJoin.headDerivedFrom = 'raw-enumeration-count';
  expectViolated(raw, 'A3', 'F15');
});

test('F16 -> A17: forged/wrong-author row partially applied (readback != authored set)', () => {
  const raw = clone();
  raw.appliedSealAndPostReads.appliedInventoryReadback.forgedOrWrongAuthorRowsApplied = 3;
  raw.appliedSealAndPostReads.appliedInventoryReadback.matchesAuthoredCandidateSet = false;
  expectViolated(raw, 'A17', 'F16');
});

test('F17 -> A18: content root != chain merkleRoot but promoted anyway', () => {
  const raw = clone();
  raw.appliedSealAndPostReads.contentPromotion.recomputedContentRoot = `0x${'99'.repeat(32)}`;
  expectViolated(raw, 'A18', 'F17');
});

test('F18 -> A1: the five triggers mapped to different reconciler ids (G8 divergence)', () => {
  const raw = clone();
  raw.coldLateJoin.reconciler.triggers.restart = `rfc64-reconciler-${'00'.repeat(32)}`;
  expectViolated(raw, 'A1', 'F18');
});

// ---------------------------------------------------------------------------
// Boundary / fixtures-only guards: the harness must refuse to bless anything
// that could be read as a real product gate pass.
// ---------------------------------------------------------------------------

test('guard: a non "not-connected" productBoundary is refused', () => {
  const raw = clone();
  raw.productBoundary = 'connected';
  expectViolated(raw, 'GUARD-product-boundary', 'productBoundary');
});

test('guard: a non "not-evaluated" gateEvaluation is refused', () => {
  const raw = clone();
  raw.gateEvaluation = 'evaluated';
  expectViolated(raw, 'GUARD-gate-evaluation', 'gateEvaluation');
});

test('guard: an unknown extra top-level field is refused', () => {
  const raw = clone();
  raw.unexpectedTopLevelField = true;
  expectViolated(raw, 'GUARD-top-level-schema', 'extra top-level field');
});

test('guard: a scenario marked passed-against-product is refused', () => {
  const raw = clone();
  raw.coldLateJoin.productGatePassed = true;
  expectViolated(raw, 'GUARD-no-product-pass-marker', 'product-gate-pass marker');
});

// ---------------------------------------------------------------------------
// Exhaustive structural fail-closed sweep: every missing field, unknown extra
// field, wrong-typed leaf, and array-shaped-as-object is rejected.
// ---------------------------------------------------------------------------

test('every missing/extra/typewrong structural mutation fails closed', () => {
  const golden = buildGate2RawEvidence();
  const locations = collectLocations(golden);
  assert.ok(locations.properties.length > 60, 'expected many object properties');
  assert.ok(locations.leaves.length > 40, 'expected many leaves');
  assert.ok(locations.objects.length > 15, 'expected many objects');
  assert.ok(locations.arrays.length >= 5, 'expected the modelled arrays');

  for (const path of locations.objects) {
    const mutation = structuredClone(golden) as unknown as Record<string, unknown>;
    const record = valueAt(mutation, path) as Record<string, unknown>;
    record.unexpectedStructuralField = true;
    assert.equal(
      verifyGate2(mutation).status,
      'contract-violated',
      `extended ${formatPath(path)} was accepted`,
    );
  }
  for (const path of locations.properties) {
    const mutation = structuredClone(golden) as unknown as Record<string, unknown>;
    const parent = valueAt(mutation, path.slice(0, -1)) as Record<string, unknown>;
    delete parent[path.at(-1) as string];
    assert.equal(
      verifyGate2(mutation).status,
      'contract-violated',
      `deleted ${formatPath(path)} was accepted`,
    );
  }
  for (const path of locations.leaves) {
    const mutation = structuredClone(golden) as unknown as Record<string, unknown>;
    const parent = valueAt(mutation, path.slice(0, -1)) as Record<string | number, unknown>;
    const key = path.at(-1) as string | number;
    parent[key] = wrongType(parent[key]);
    assert.equal(
      verifyGate2(mutation).status,
      'contract-violated',
      `wrong-typed ${formatPath(path)} was accepted`,
    );
  }
  for (const path of locations.arrays) {
    const mutation = structuredClone(golden) as unknown as Record<string, unknown>;
    const parent = valueAt(mutation, path.slice(0, -1)) as Record<string | number, unknown>;
    parent[path.at(-1) as string | number] = { notAnArray: true };
    assert.equal(
      verifyGate2(mutation).status,
      'contract-violated',
      `array-as-object ${formatPath(path)} was accepted`,
    );
  }
});

function wrongType(value: unknown): unknown {
  if (typeof value === 'string') return 424242;
  if (typeof value === 'number') return 'not-a-number';
  if (typeof value === 'boolean') return 'not-a-boolean';
  return 'unexpected-type';
}

function collectLocations(root: unknown): {
  properties: JsonPath[];
  leaves: JsonPath[];
  objects: JsonPath[];
  arrays: JsonPath[];
} {
  const result = {
    properties: [] as JsonPath[],
    leaves: [] as JsonPath[],
    objects: [] as JsonPath[],
    arrays: [] as JsonPath[],
  };
  const visit = (value: unknown, path: JsonPath): void => {
    if (Array.isArray(value)) {
      result.arrays.push(path);
      value.forEach((nested, index) => visit(nested, [...path, index]));
      return;
    }
    if (value !== null && typeof value === 'object') {
      result.objects.push(path);
      for (const [key, nested] of Object.entries(value)) {
        const propertyPath = [...path, key];
        result.properties.push(propertyPath);
        visit(nested, propertyPath);
      }
      return;
    }
    result.leaves.push(path);
  };
  visit(root, []);
  return result;
}

function valueAt(root: unknown, path: JsonPath): unknown {
  let current = root;
  for (const key of path) {
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function formatPath(path: JsonPath): string {
  return path.length === 0 ? '$' : `$.${path.join('.')}`;
}
