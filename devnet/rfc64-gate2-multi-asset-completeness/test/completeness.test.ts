import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalDocument, canonicalize } from '../src/canonical.ts';
import { generateCompleteFixture } from '../src/generate.ts';
import { verify } from '../src/verify.ts';

const FIXTURE_COUNT = 8;

// Mutable deep clone of a frozen raw artifact; the mutated artifact must still
// parse so each test exercises the targeted invariant, not an incidental reject.
function clone(): any {
  return JSON.parse(JSON.stringify(generateCompleteFixture(FIXTURE_COUNT)));
}

const OTHER_DIGEST = 'c'.repeat(64);
const A_DIGEST = 'a'.repeat(64);

function differentDigest(current: string): string {
  return current === A_DIGEST ? OTHER_DIGEST : A_DIGEST;
}

test('a complete fixture verifies with every invariant satisfied', () => {
  const verdict = verify(generateCompleteFixture(FIXTURE_COUNT));
  assert.equal(verdict.fixtureComplete, true);
  assert.deepEqual(verdict.missing, []);
  assert.deepEqual(verdict.extra, []);
  assert.deepEqual(verdict.duplicateUals, []);
  assert.deepEqual(verdict.mismatchedUals, []);
  assert.deepEqual(verdict.rejectReasons, []);
  for (const [name, value] of Object.entries(verdict.checks)) {
    assert.equal(value, true, `check ${name} must be true for a complete fixture`);
  }
  assert.equal(
    verdict.recomputedInventorySetRoot,
    generateCompleteFixture(FIXTURE_COUNT).inventorySetRoot,
    'verifier recomputes the same root it declares',
  );
});

test('the fixture is byte-deterministic across two generations', () => {
  const a = canonicalDocument(generateCompleteFixture(FIXTURE_COUNT));
  const b = canonicalDocument(generateCompleteFixture(FIXTURE_COUNT));
  assert.equal(a, b);
  assert.ok(a.endsWith('\n'), 'canonical document ends with exactly one LF');
});

test('completeness is distinct from any gate pass, on complete and rejected verdicts', () => {
  const complete = canonicalDocument(verify(generateCompleteFixture(FIXTURE_COUNT)));
  const rejected = canonicalDocument(verify({ not: 'valid' }));
  for (const doc of [complete, rejected]) {
    assert.match(doc, /"productBoundary":"not-connected"/);
    assert.match(doc, /"gateEvaluation":"not-evaluated"/);
    // No token that could be read as a real Gate 2 pass.
    assert.doesNotMatch(doc, /pass(ed)?/i);
    assert.doesNotMatch(doc, /"gateEvaluation":"(passed|pass|ok|green|evaluated)"/);
  }
  // fixtureComplete may be true, but the gate disposition never changes.
  assert.equal(verify(generateCompleteFixture(FIXTURE_COUNT)).gateEvaluation, 'not-evaluated');
});

test('fail-closed schema rejection for structural deviations', () => {
  const base = clone();
  const rejects: Array<[string, unknown]> = [
    ['unknown extra top-level field', { ...base, surprise: 1 }],
    ['missing field', (() => { const r = clone(); delete r.totalCount; return r; })()],
    ['wrong schema id', { ...clone(), schema: 'other' }],
    ['tampered productBoundary marker', { ...clone(), productBoundary: 'connected' }],
    ['tampered gateEvaluation marker', { ...clone(), gateEvaluation: 'passed' }],
    ['non-hex inventorySetRoot', { ...clone(), inventorySetRoot: 'zz' }],
    ['non-integer length in a row', (() => { const r = clone(); r.received[0].contentLength = 1.5; return r; })()],
    ['empty ual in a row', (() => { const r = clone(); r.received[0].ual = ''; return r; })()],
    ['non-hex digest in a row', (() => { const r = clone(); r.received[0].contentDigest = 'nothex'; return r; })()],
    ['unknown field in a row', (() => { const r = clone(); r.received[0].extra = true; return r; })()],
    ['authored is not an array', { ...clone(), authored: {} }],
    ['non-parseable input', undefined],
  ];
  for (const [name, input] of rejects) {
    const verdict = verify(input);
    assert.equal(verdict.fixtureComplete, false, `${name} must be rejected`);
    assert.equal(verdict.checks.schemaWellFormed, false, `${name} must fail schemaWellFormed`);
    assert.ok(verdict.rejectReasons.length > 0, `${name} must record a reject reason`);
    assert.equal(verdict.gateEvaluation, 'not-evaluated');
  }
});

test('missing received row is rejected (noMissing)', () => {
  const r = clone();
  const dropped = r.received[3].ual;
  r.received.splice(3, 1);
  const verdict = verify(r);
  assert.equal(verdict.fixtureComplete, false);
  assert.equal(verdict.checks.noMissing, false);
  assert.ok(verdict.missing.includes(dropped));
});

test('extra received row is rejected (noExtra)', () => {
  const r = clone();
  // A valid, well-formed row whose ual sorts after all fixture uals so canonical
  // order stays intact and only the extra-set invariant is tripped.
  const extraUal = 'did:dkg:gate2-mac-fixture/999999';
  r.received.push({ ual: extraUal, contentDigest: A_DIGEST, contentLength: 1, bundleDigest: A_DIGEST, bundleLength: 2 });
  const verdict = verify(r);
  assert.equal(verdict.fixtureComplete, false);
  assert.equal(verdict.checks.noExtra, false);
  assert.equal(verdict.checks.receivedCanonicalOrder, true, 'appended-after row keeps canonical order');
  assert.ok(verdict.extra.includes(extraUal));
});

test('duplicate received ual is rejected (uniqueness), isolated from ordering', () => {
  const r = clone();
  // Insert an adjacent clone so ual order stays non-decreasing; only uniqueness trips.
  r.received.splice(1, 0, { ...r.received[0] });
  const verdict = verify(r);
  assert.equal(verdict.fixtureComplete, false);
  assert.equal(verdict.checks.receivedUniqueUals, false);
  assert.equal(verdict.checks.receivedCanonicalOrder, true, 'adjacent duplicate keeps non-decreasing order');
  assert.ok(verdict.duplicateUals.includes(r.received[0].ual));
});

test('mis-ordered but complete set is rejected (canonicalOrder), isolated', () => {
  const r = clone();
  [r.received[0], r.received[1]] = [r.received[1], r.received[0]];
  const verdict = verify(r);
  assert.equal(verdict.fixtureComplete, false);
  assert.equal(verdict.checks.receivedCanonicalOrder, false);
  // The set itself is unchanged, so completeness/root/count invariants still hold.
  assert.equal(verdict.checks.noMissing, true);
  assert.equal(verdict.checks.noExtra, true);
  assert.equal(verdict.checks.inventorySetRootMatches, true);
  assert.equal(verdict.checks.totalCountMatchesAuthored, true);
});

for (const field of ['contentDigest', 'bundleDigest'] as const) {
  test(`per-row ${field} mismatch is rejected (perRowExactMatch + set root)`, () => {
    const r = clone();
    r.received[2][field] = differentDigest(r.received[2][field]);
    const verdict = verify(r);
    assert.equal(verdict.fixtureComplete, false);
    assert.equal(verdict.checks.perRowExactMatch, false);
    assert.equal(verdict.checks.inventorySetRootMatches, false, 'changing a row changes the received set root');
    assert.ok(verdict.mismatchedUals.includes(r.received[2].ual));
  });
}

for (const field of ['contentLength', 'bundleLength'] as const) {
  test(`per-row ${field} mismatch is rejected (perRowExactMatch + set root)`, () => {
    const r = clone();
    r.received[2][field] = r.received[2][field] + 1;
    const verdict = verify(r);
    assert.equal(verdict.fixtureComplete, false);
    assert.equal(verdict.checks.perRowExactMatch, false);
    assert.equal(verdict.checks.inventorySetRootMatches, false);
    assert.ok(verdict.mismatchedUals.includes(r.received[2].ual));
  });
}

test('wrong totalCount is rejected (totalCountMatchesAuthored), isolated', () => {
  const r = clone();
  r.totalCount = r.authored.length + 1;
  const verdict = verify(r);
  assert.equal(verdict.fixtureComplete, false);
  assert.equal(verdict.checks.totalCountMatchesAuthored, false);
  assert.equal(verdict.checks.noMissing, true);
  assert.equal(verdict.checks.inventorySetRootMatches, true);
});

test('tampered declared inventorySetRoot is rejected, never trusted (isolated)', () => {
  const r = clone();
  r.inventorySetRoot = differentDigest(r.inventorySetRoot);
  const verdict = verify(r);
  assert.equal(verdict.fixtureComplete, false);
  assert.equal(verdict.checks.inventorySetRootMatches, false);
  // Every other invariant still holds: only the declared root was tampered.
  assert.equal(verdict.checks.noMissing, true);
  assert.equal(verdict.checks.noExtra, true);
  assert.equal(verdict.checks.perRowExactMatch, true);
  assert.notEqual(verdict.recomputedInventorySetRoot, r.inventorySetRoot);
});

test('canonical JSON rejects non-integer numbers', () => {
  assert.throws(() => canonicalize({ n: 1.5 } as never));
  assert.throws(() => canonicalize({ n: Number.NaN } as never));
});
