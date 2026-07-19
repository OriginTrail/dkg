import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import { buildGate3RawEvidence, sha256Hex, stableJson } from './raw-evidence.js';
import { verifyGate3 } from './verdict.js';

/**
 * Pinned deterministic digests of the golden raw evidence and its verdict.
 * These are the exact SHA-256 values printed by `run.ts` (RAW_SHA256) and
 * `verify.ts` (VERDICT_SHA256) and are asserted byte-identical across runs.
 */
const PINNED_RAW_SHA256 =
  '35176c69796fd492be19d36b64c140b3082cea0f5640cea3b7ac5c6df4e0ca80';
const PINNED_VERDICT_SHA256 =
  'adfe2dbc27b5b80f6a80225fd5ec797f9f4e1d26f1cc26bc012cef29f555aa1c';

type JsonPath = readonly (string | number)[];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function clone(): any {
  return structuredClone(buildGate3RawEvidence());
}

function expectViolated(raw: unknown, expectedId: string, label: string): void {
  expectViolatedAll(raw, [expectedId], label);
}

function expectViolatedAll(raw: unknown, expectedIds: readonly string[], label: string): void {
  const verdict = verifyGate3(raw);
  assert.equal(
    verdict.status,
    'contract-violated',
    `${label}: expected contract-violated, got ${verdict.status}`,
  );
  const ids = verdict.violations.map((violation) => violation.id);
  for (const expectedId of expectedIds) {
    assert.ok(
      ids.includes(expectedId),
      `${label}: expected a violation naming ${expectedId}, got [${ids.join(', ')}]`,
    );
  }
  // Fail-closed verdicts must never masquerade as a product gate pass.
  assert.equal(verdict.productBoundary, 'not-connected', `${label}: productBoundary`);
  assert.equal(verdict.gateEvaluation, 'not-evaluated', `${label}: gateEvaluation`);
}

test('positive: the unmutated golden fixture is contract-satisfied and never a product pass', () => {
  const verdict = verifyGate3(buildGate3RawEvidence());
  assert.equal(verdict.status, 'contract-satisfied');
  assert.equal(verdict.productBoundary, 'not-connected');
  assert.equal(verdict.gateEvaluation, 'not-evaluated');
  assert.equal(verdict.violations.length, 0);
  assert.equal(verdict.checks.length, 9);
  assert.ok(verdict.checks.every((check) => check.ok));
  const ids = verdict.checks.map((check) => check.id);
  for (let index = 1; index <= 9; index += 1) {
    assert.ok(ids.includes(`G3-A${index}`), `missing acceptance check G3-A${index}`);
  }
});

test('two-run determinism: raw + verdict are byte-identical and match the pinned SHA-256', () => {
  const rawA = stableJson(buildGate3RawEvidence());
  const rawB = stableJson(buildGate3RawEvidence());
  assert.equal(rawA, rawB, 'raw serialization is not byte-identical across runs');
  assert.equal(sha256Hex(Buffer.from(rawA)), PINNED_RAW_SHA256, 'raw SHA-256 drifted from pin');

  const verdictA = stableJson(verifyGate3(buildGate3RawEvidence()));
  const verdictB = stableJson(verifyGate3(buildGate3RawEvidence()));
  assert.equal(verdictA, verdictB, 'verdict serialization is not byte-identical across runs');
  assert.equal(
    sha256Hex(Buffer.from(verdictA)),
    PINNED_VERDICT_SHA256,
    'verdict SHA-256 drifted from pin',
  );
});

// ---------------------------------------------------------------------------
// The 12 fault points G3-F1..G3-F12. Each starts from the golden fixture,
// breaks exactly one invariant, and asserts verifyGate3 returns
// contract-violated with a violation naming the acceptance check that owns
// that invariant. (Cross-binding means a fault may trip additional checks; we
// only assert the mapped check is present, never that it is the only one.)
// ---------------------------------------------------------------------------

test('G3-F1 -> G3-A1: publisher catalog NOT sealed before the receiver started', () => {
  const raw = clone();
  raw.exactConvergence.publisher.catalogSealedAtEra = 3000; // >= receiver 2000
  raw.exactConvergence.publisher.catalogSealedAt = '2026-07-19T13:00:00.000Z'; // >= 12:00
  expectViolated(raw, 'G3-A1', 'G3-F1');
});

test('G3-F2 -> G3-A2: cold receiver did NOT start empty', () => {
  const raw = clone();
  raw.noPriorAnnouncement.emptyStartMarker = false;
  raw.noPriorAnnouncement.initialAppliedInventoryCount = 1;
  expectViolated(raw, 'G3-A2', 'G3-F2');
});

test('G3-F3 -> G3-A3: convergence depended on a consumed live announcement', () => {
  const raw = clone();
  raw.noPriorAnnouncement.liveAnnouncementConsumed = true;
  expectViolated(raw, 'G3-A3', 'G3-F3');
});

test('G3-F4 -> G3-A4: discovered head digest != publisher authored head digest', () => {
  const raw = clone();
  const forged = `0x${'77'.repeat(32)}`;
  raw.authenticatedCurrentHeadDiscovery.discoveredHeadDigest = forged;
  raw.authenticatedCurrentHeadDiscovery.frontierHeadDigest = forged;
  expectViolated(raw, 'G3-A4', 'G3-F4');
});

test('G3-F5 -> G3-A4: head authorization not verified but the head was applied', () => {
  const raw = clone();
  raw.authenticatedCurrentHeadDiscovery.headAuthorization.verified = false;
  raw.authenticatedCurrentHeadDiscovery.headApplied = true;
  expectViolated(raw, 'G3-A4', 'G3-F5');
});

test('G3-F6 -> G3-A4: a stale / superseded (non-current) head was accepted', () => {
  const raw = clone();
  raw.authenticatedCurrentHeadDiscovery.headIsCurrent = false;
  raw.authenticatedCurrentHeadDiscovery.supersededCandidateDigests = [`0x${'88'.repeat(32)}`];
  expectViolated(raw, 'G3-A4', 'G3-F6');
});

test('G3-F7 -> G3-A5: predecessor bootstrap exceeded the declared bound (unbounded walk)', () => {
  const raw = clone();
  raw.boundedPredecessorBootstrap.predecessorBootstrapSteps = 20; // > declaredBound 16
  raw.boundedPredecessorBootstrap.walkTerminatedWithinBound = false;
  expectViolated(raw, 'G3-A5', 'G3-F7');
});

test('G3-F8 -> G3-A6: receiver inventory-set root != publisher root', () => {
  const raw = clone();
  raw.exactConvergence.receiver.inventorySetRoot = `0x${'ab'.repeat(32)}`;
  expectViolated(raw, 'G3-A6', 'G3-F8');
});

test('G3-F9 -> G3-A6: applied row count != authored row count', () => {
  const raw = clone();
  raw.exactConvergence.receiver.appliedRowCount = 7;
  expectViolated(raw, 'G3-A6', 'G3-F9');
});

test('G3-F10 -> G3-A6: one applied row digest mismatches the authored digest', () => {
  const raw = clone();
  raw.exactConvergence.appliedRowDigests[2] = `0x${'99'.repeat(32)}`;
  expectViolated(raw, 'G3-A6', 'G3-F10');
});

test('G3-F11 -> G3-A7: restart refetched from zero / applied root changed', () => {
  const raw = clone();
  raw.receiverRestart.refetchedFromZero = true;
  raw.receiverRestart.appliedInventorySetRoot = `0x${'cd'.repeat(32)}`;
  expectViolated(raw, 'G3-A7', 'G3-F11');
});

test('G3-F12 -> G3-A8: rows applied from an invalidly-authorized head / state changed', () => {
  const raw = clone();
  raw.authorizationNegativeUnchanged.rowsAppliedFromInvalidHead = 3;
  raw.authorizationNegativeUnchanged.postStateRoot = `0x${'ef'.repeat(32)}`;
  raw.authorizationNegativeUnchanged.stateUnchanged = false;
  expectViolated(raw, 'G3-A8', 'G3-F12');
});

// ---------------------------------------------------------------------------
// Boundary / fixtures-only guards: the harness must refuse to bless anything
// that could be read as a real product gate pass. A wrong boundary label trips
// BOTH the dedicated guard AND the G3-A9 acceptance check.
// ---------------------------------------------------------------------------

test('boundary -> G3-A9: a non "not-connected" productBoundary is refused', () => {
  const raw = clone();
  raw.productBoundary = 'connected';
  expectViolatedAll(raw, ['G3-A9', 'GUARD-product-boundary'], 'productBoundary');
});

test('boundary -> G3-A9: a non "not-evaluated" gateEvaluation is refused', () => {
  const raw = clone();
  raw.gateEvaluation = 'evaluated';
  expectViolatedAll(raw, ['G3-A9', 'GUARD-gate-evaluation'], 'gateEvaluation');
});

test('guard: an unknown extra top-level field is refused', () => {
  const raw = clone();
  raw.unexpectedTopLevelField = true;
  expectViolated(raw, 'GUARD-top-level-schema', 'extra top-level field');
});

test('guard: a scenario marked passed-against-product is refused', () => {
  const raw = clone();
  raw.exactConvergence.productGatePassed = true;
  expectViolated(raw, 'GUARD-no-product-pass-marker', 'product-gate-pass marker');
});

// ---------------------------------------------------------------------------
// Exhaustive structural fail-closed sweep: every missing field, unknown extra
// field, wrong-typed leaf, and array-shaped-as-object is rejected.
// ---------------------------------------------------------------------------

test('every missing/extra/typewrong structural mutation fails closed', () => {
  const golden = buildGate3RawEvidence();
  const locations = collectLocations(golden);
  assert.ok(locations.properties.length > 45, 'expected many object properties');
  assert.ok(locations.leaves.length > 40, 'expected many leaves');
  assert.ok(locations.objects.length > 8, 'expected many objects');
  assert.ok(locations.arrays.length >= 5, 'expected the modelled arrays');

  for (const path of locations.objects) {
    const mutation = structuredClone(golden) as unknown as Record<string, unknown>;
    const record = valueAt(mutation, path) as Record<string, unknown>;
    record.unexpectedStructuralField = true;
    assert.equal(
      verifyGate3(mutation).status,
      'contract-violated',
      `extended ${formatPath(path)} was accepted`,
    );
  }
  for (const path of locations.properties) {
    const mutation = structuredClone(golden) as unknown as Record<string, unknown>;
    const parent = valueAt(mutation, path.slice(0, -1)) as Record<string, unknown>;
    delete parent[path.at(-1) as string];
    assert.equal(
      verifyGate3(mutation).status,
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
      verifyGate3(mutation).status,
      'contract-violated',
      `wrong-typed ${formatPath(path)} was accepted`,
    );
  }
  for (const path of locations.arrays) {
    const mutation = structuredClone(golden) as unknown as Record<string, unknown>;
    const parent = valueAt(mutation, path.slice(0, -1)) as Record<string | number, unknown>;
    parent[path.at(-1) as string | number] = { notAnArray: true };
    assert.equal(
      verifyGate3(mutation).status,
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
