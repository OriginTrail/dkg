import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalDocument, canonicalize } from '../src/canonical.ts';
import { FIXTURE_SCOPE, generateCompleteFixture } from '../src/generate.ts';
import {
  computeAppliedInventoryDigest,
  computeCatalogScopeDigest,
} from '../src/product-digests.ts';
import type { AssetRowV1, CatalogScopeV1 } from '../src/schema.ts';
import { verify } from '../src/verify.ts';

const FIXTURE_COUNT = 8;
const OTHER_DIGEST = `0x${'cc'.repeat(32)}`;
const AUTHOR = FIXTURE_SCOPE.authorAddress;

function clone(count = FIXTURE_COUNT): any {
  return JSON.parse(JSON.stringify(generateCompleteFixture(count)));
}

function mutateDigest(current: string): string {
  return current === OTHER_DIGEST ? `0x${'dd'.repeat(32)}` : OTHER_DIGEST;
}

test('complete product-shaped evidence satisfies every fixture invariant', () => {
  const raw = generateCompleteFixture(FIXTURE_COUNT);
  const verdict = verify(raw);
  assert.equal(verdict.fixtureComplete, true);
  assert.deepEqual(verdict.missingKaIds, []);
  assert.deepEqual(verdict.extraKaIds, []);
  assert.deepEqual(verdict.duplicateKaIds, []);
  assert.deepEqual(verdict.duplicateUals, []);
  assert.deepEqual(verdict.mismatchedKaIds, []);
  assert.deepEqual(verdict.rejectReasons, []);
  for (const [name, value] of Object.entries(verdict.checks)) {
    assert.equal(value, true, `${name} must be true`);
  }
  assert.equal(verdict.recomputedCatalogScopeDigest, raw.authored.declaredCatalogScopeDigest);
  assert.equal(verdict.recomputedInventoryDigest, raw.received.declaredInventoryDigest);
});

test('raw and verdict documents are two-run byte-identical RFC 8785 JCS plus one LF', () => {
  const rawA = canonicalDocument(generateCompleteFixture(FIXTURE_COUNT));
  const rawB = canonicalDocument(generateCompleteFixture(FIXTURE_COUNT));
  const verdictA = canonicalDocument(verify(generateCompleteFixture(FIXTURE_COUNT)));
  const verdictB = canonicalDocument(verify(generateCompleteFixture(FIXTURE_COUNT)));
  assert.equal(rawA, rawB);
  assert.equal(verdictA, verdictB);
  for (const document of [rawA, verdictA]) {
    assert.ok(document.endsWith('\n'));
    assert.ok(!document.endsWith('\n\n'));
    assert.equal(canonicalDocument(JSON.parse(document) as never), document);
  }
});

test('fixture completeness cannot overstate a connected or evaluated Gate 2', () => {
  for (const verdict of [verify(generateCompleteFixture(2)), verify({ invalid: true })]) {
    const document = canonicalDocument(verdict);
    assert.equal(verdict.productBoundary, 'not-connected');
    assert.equal(verdict.gateEvaluation, 'not-evaluated');
    assert.doesNotMatch(document, /"gateEvaluation":"(?:PASS|passed|green|evaluated)"/u);
  }
});

test('scope and applied-inventory digest framing matches the current product vector', () => {
  const scope: CatalogScopeV1 = Object.freeze({ ...FIXTURE_SCOPE });
  const rows = [productVectorRow(2), productVectorRow(10), productVectorRow(100)];
  const scopeDigest = computeCatalogScopeDigest(scope);
  assert.equal(
    computeAppliedInventoryDigest(scopeDigest, rows),
    '0x299d93f46a4baa1a0099f3ebfabb43f2070dc590313c4abfcf22f3541766a79e',
  );
  assert.equal(
    computeAppliedInventoryDigest(scopeDigest, [...rows].reverse()),
    '0x299d93f46a4baa1a0099f3ebfabb43f2070dc590313c4abfcf22f3541766a79e',
    'digest sorts by mathematical kaId, not caller or lexical UAL order',
  );
});

test('declared catalog-scope and inventory roots are independently recomputed', () => {
  const wrongScope = clone();
  wrongScope.authored.declaredCatalogScopeDigest = mutateDigest(
    wrongScope.authored.declaredCatalogScopeDigest,
  );
  const scopeVerdict = verify(wrongScope);
  assert.equal(scopeVerdict.fixtureComplete, false);
  assert.equal(scopeVerdict.checks.catalogScopeDigestMatches, false);
  assert.notEqual(
    scopeVerdict.recomputedCatalogScopeDigest,
    wrongScope.authored.declaredCatalogScopeDigest,
  );

  const wrongInventory = clone();
  wrongInventory.received.declaredInventoryDigest = mutateDigest(
    wrongInventory.received.declaredInventoryDigest,
  );
  const inventoryVerdict = verify(wrongInventory);
  assert.equal(inventoryVerdict.fixtureComplete, false);
  assert.equal(inventoryVerdict.checks.inventoryDigestMatches, false);
  assert.notEqual(
    inventoryVerdict.recomputedInventoryDigest,
    wrongInventory.received.declaredInventoryDigest,
  );
});

test('authored and receiver heads must be the same exact digest', () => {
  const raw = clone();
  raw.received.catalogHeadDigest = mutateDigest(raw.received.catalogHeadDigest);
  const verdict = verify(raw);
  assert.equal(verdict.fixtureComplete, false);
  assert.equal(verdict.checks.catalogHeadMatches, false);
});

test('head, signed bucket, and receiver counts each bind the exact row set', () => {
  const mutations: Array<[string, (raw: any) => void]> = [
    ['head', (raw) => { raw.authored.catalogHeadTotalRows = '9'; }],
    ['bucket', (raw) => { raw.authored.signedBucketRowCount = '9'; }],
    ['receiver', (raw) => { raw.received.inventoryRowCount = 9; }],
  ];
  for (const [label, mutate] of mutations) {
    const raw = clone();
    mutate(raw);
    const verdict = verify(raw);
    assert.equal(verdict.fixtureComplete, false, label);
  }
});

test('missing, extra, duplicate kaId, and duplicate UAL are rejected before set collapse', () => {
  const missing = clone();
  const missingId = missing.received.activatedRows[3].kaId;
  missing.received.activatedRows.splice(3, 1);
  let verdict = verify(missing);
  assert.equal(verdict.checks.noMissing, false);
  assert.ok(verdict.missingKaIds.includes(missingId));

  const extra = clone();
  extra.received.activatedRows.push(clone(9).received.activatedRows[8]);
  verdict = verify(extra);
  assert.equal(verdict.checks.noExtra, false);
  assert.equal(verdict.extraKaIds.length, 1);

  const duplicate = clone();
  duplicate.received.activatedRows.splice(1, 0, { ...duplicate.received.activatedRows[0] });
  verdict = verify(duplicate);
  assert.equal(verdict.checks.activatedRowsUnique, false);
  assert.ok(verdict.duplicateKaIds.includes(duplicate.received.activatedRows[0].kaId));

  const duplicateUal = clone();
  duplicateUal.received.activatedRows[1].kaUal = duplicateUal.received.activatedRows[0].kaUal;
  verdict = verify(duplicateUal);
  assert.equal(verdict.checks.activatedRowsUnique, false);
  assert.ok(verdict.duplicateUals.includes(duplicateUal.received.activatedRows[0].kaUal));
});

test('signed and activated row order is mathematical kaId order, not lexical UAL order', () => {
  const authored = clone();
  [authored.authored.signedRows[0], authored.authored.signedRows[1]] = [
    authored.authored.signedRows[1],
    authored.authored.signedRows[0],
  ];
  assert.equal(verify(authored).checks.signedRowsCanonicalOrder, false);

  const activated = clone();
  [activated.received.activatedRows[0], activated.received.activatedRows[1]] = [
    activated.received.activatedRows[1],
    activated.received.activatedRows[0],
  ];
  const verdict = verify(activated);
  assert.equal(verdict.checks.activatedRowsCanonicalOrder, false);
  assert.equal(verdict.checks.noMissing, true);
  assert.equal(verdict.checks.noExtra, true);
  assert.equal(verdict.checks.inventoryDigestMatches, true, 'inventory root is order-normalized');
});

for (const field of [
  'catalogRowDigest',
  'contentDigest',
  'sealDigest',
  'bundleDigest',
] as const) {
  test(`exact ${field} mismatch is rejected`, () => {
    const raw = clone();
    raw.received.activatedRows[2][field] = mutateDigest(raw.received.activatedRows[2][field]);
    const verdict = verify(raw);
    assert.equal(verdict.fixtureComplete, false);
    assert.equal(verdict.checks.perRowExactMatch, false);
    assert.ok(verdict.mismatchedKaIds.includes(raw.received.activatedRows[2].kaId));
    if (field === 'bundleDigest') {
      assert.equal(
        verdict.checks.inventoryDigestMatches,
        true,
        'bundle is an exact equality check because the legacy inventory digest omits it',
      );
    }
  });
}

test('exact UAL and activated triple count mismatches are rejected', () => {
  const wrongUal = clone();
  wrongUal.received.activatedRows[2].kaUal =
    `did:dkg:${FIXTURE_SCOPE.networkId}/${AUTHOR}/999`;
  let verdict = verify(wrongUal);
  assert.equal(verdict.checks.rowsBindCatalogScope, false);
  assert.equal(verdict.checks.perRowExactMatch, false);

  const wrongCount = clone();
  wrongCount.received.activatedRows[2].activatedTripleCount += 1;
  verdict = verify(wrongCount);
  assert.equal(verdict.checks.perRowExactMatch, false);
  assert.equal(verdict.checks.inventoryDigestMatches, false);
});

test('UAL must encode the exact network, author, and packed kaId', () => {
  const cases = [
    `did:dkg:otp:999/${AUTHOR}/1`,
    `did:dkg:${FIXTURE_SCOPE.networkId}/0x2222222222222222222222222222222222222222/1`,
    `did:dkg:${FIXTURE_SCOPE.networkId}/${AUTHOR}/01`,
    `did:dkg:${FIXTURE_SCOPE.networkId}/${AUTHOR}/999`,
  ];
  for (const kaUal of cases) {
    const raw = clone();
    raw.authored.signedRows[0].kaUal = kaUal;
    raw.received.activatedRows[0].kaUal = kaUal;
    assert.equal(verify(raw).checks.rowsBindCatalogScope, false, kaUal);
  }
});

test('the exact 1 and 1024 boundaries pass; 0 and 1025 fail closed', () => {
  assert.equal(verify(generateCompleteFixture(1)).fixtureComplete, true);
  assert.equal(verify(generateCompleteFixture(1024)).fixtureComplete, true);
  assert.throws(() => generateCompleteFixture(0), RangeError);
  assert.throws(() => generateCompleteFixture(1025), RangeError);

  const empty = clone(1);
  empty.authored.catalogHeadTotalRows = '0';
  empty.authored.signedBucketRowCount = '0';
  empty.authored.signedRows = [];
  empty.received.inventoryRowCount = 0;
  empty.received.activatedRows = [];
  assert.equal(verify(empty).checks.rowCountWithinBounds, false);

  let ownKeysInvoked = false;
  const oversized = new Proxy(new Array(1025), {
    ownKeys(target) {
      ownKeysInvoked = true;
      return Reflect.ownKeys(target);
    },
  });
  const raw = clone(1);
  raw.authored.signedRows = oversized;
  assert.equal(verify(raw).fixtureComplete, false);
  assert.equal(ownKeysInvoked, false, 'length cap is checked before row-key enumeration');
});

test('schema boundary rejects unknown fields, malformed scalars, and accessors', () => {
  const malformed: unknown[] = [
    { ...clone(), surprise: true },
    (() => { const raw = clone(); delete raw.received.inventoryRowCount; return raw; })(),
    (() => { const raw = clone(); raw.authored.catalogHeadTotalRows = '01'; return raw; })(),
    (() => { const raw = clone(); raw.received.activatedRows[0].sealDigest = 'bad'; return raw; })(),
    (() => { const raw = clone(); raw.authored.catalogScope.bucketCount = '2'; return raw; })(),
  ];
  for (const raw of malformed) {
    const verdict = verify(raw);
    assert.equal(verdict.fixtureComplete, false);
    assert.equal(verdict.checks.schemaWellFormed, false);
    assert.deepEqual(verdict.rejectReasons, ['raw evidence failed closed structural validation']);
  }

  let getterInvoked = false;
  const accessor = clone();
  Object.defineProperty(accessor, 'authored', {
    enumerable: true,
    get() {
      getterInvoked = true;
      return clone().authored;
    },
  });
  assert.equal(verify(accessor).fixtureComplete, false);
  assert.equal(getterInvoked, false);
});

test('switching Proxy get traps are never invoked at the JavaScript input boundary', () => {
  let gets = 0;
  const proxy = new Proxy(clone(), {
    get(target, key, receiver) {
      gets += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(verify(proxy).fixtureComplete, true);
  assert.equal(gets, 0);
});

test('canonical JCS rejects accessors, sparse arrays, unsafe numbers, and lone surrogates', () => {
  let getterInvoked = false;
  const accessor = Object.defineProperty({}, 'x', {
    enumerable: true,
    get() {
      getterInvoked = true;
      return 1;
    },
  });
  assert.throws(() => canonicalize(accessor as never));
  assert.equal(getterInvoked, false);
  assert.throws(() => canonicalize(new Array(2) as never));
  assert.throws(() => canonicalize({ n: 1.5 } as never));
  assert.throws(() => canonicalize({ s: '\ud800' } as never));
  assert.equal(canonicalize({ '\u{1f600}': 1, '\ufffd': 2 }), '{"😀":1,"�":2}');
});

function productVectorRow(number: number): AssetRowV1 {
  const kaId = ((BigInt(AUTHOR) << 96n) | BigInt(number)).toString();
  return Object.freeze({
    kaId,
    catalogRowDigest: digest(number * 4),
    contentDigest: digest((number * 4) + 1),
    sealDigest: digest((number * 4) + 2),
    bundleDigest: digest((number * 4) + 3),
    kaUal: `did:dkg:otp:20430/${AUTHOR}/${number}`,
    activatedTripleCount: number + 1,
  });
}

function digest(seed: number): string {
  return `0x${seed.toString(16).padStart(64, '0')}`;
}
