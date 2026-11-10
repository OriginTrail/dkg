import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from './jpb-plca-mapped.ts';

// Fictional workbook, factors and output basis; no partner data or transport fixture.
function input() {
  return {
    records: [2, 3, null, 5].map((quantity, i) => ({ workbook: {
      rowId: 'row-' + i, material: 'test-material', unit: 'kg', quantity,
      evidence: { contentDigest: 'a'.repeat(64) },
    } })),
    assumptions: { kind: 'demo-assumptions', outputUnits: 2, notice: 'Fictional two-unit reference batch',
      reference: 'urn:test:factors', date: '2026-01-01', internalTransferRows: ['row-3'],
      missingQuantities: { 'row-2': 4 },
      factors: [0, 1, 2].map(i => ({ studyItemId: 'row-' + i, quantityUnit: 'kg', value: 2 })),
    },
  };
}

test('mapped PLCA calculates explicit quantities and excludes internal transfers', () => {
  const value = input(), before = structuredClone(value), result = run(value);
  assert.deepEqual(value, before, 'calculation must preserve the submitted records and assumptions');
  assert.deepEqual(result.records, before.records);
  assert.equal(result.records[2].workbook.quantity, null, 'the assumption must not overwrite source evidence');
  assert.equal(result.assessment.calculated, true);
  assert.equal(result.assessment.total, 18); // (2 + 3 + assumed 4) * factor 2; transfer 5 excluded.
  assert.equal(result.assessment.perProduct, 9); // 18 / two output units.
  assert.equal(result.assessment.unit, 'kg CO2e');
  assert.deepEqual(result.assessment.contributions.map(c => [c.studyItemId, c.impact, c.perProduct]),
    [['row-0', 4, 2], ['row-1', 6, 3], ['row-2', 8, 4]]);
  assert.deepEqual(result.assessment.assumptions, before.assumptions);
  const changed = input(); changed.assumptions.outputUnits = 3;
  assert.equal(run(changed).assessment.total, 18);
  assert.equal(run(changed).assessment.perProduct, 6);
});

for (const mode of ['missing', 'incompatible', 'none']) test(`mapped PLCA keeps ${mode} factors uncalculated`, () => {
  const value = input();
  if (mode === 'missing') value.assumptions.factors.pop();
  if (mode === 'incompatible') value.assumptions.factors[2].quantityUnit = 'g';
  if (mode === 'none') value.assumptions.factors = [];
  const { assessment } = run(value);
  assert.equal(assessment.calculated, false);
  assert.equal(assessment.total, null);
  assert.equal(assessment.perProduct, null);
  assert.deepEqual(assessment.contributions.map(c => [c.studyItemId, c.impact]),
    mode === 'none' ? [] : [['row-0', 4], ['row-1', 6]]);
});

test('mapped PLCA requires explicit quantities, output basis and consistent workbook/factor scope', () => {
  for (const [change, message] of [
    [v => { delete v.assumptions.missingQuantities['row-2']; }, 'EXPLICIT_QUANTITY_REQUIRED'],
    [v => { v.assumptions.missingQuantities['row-2'] = -1; }, 'EXPLICIT_QUANTITY_REQUIRED'],
    [v => { v.assumptions.outputUnits = 0; }, 'PLCA_ESTIMATE_BASIS_REQUIRED'],
    [v => { v.assumptions.notice = ''; }, 'PLCA_ESTIMATE_BASIS_REQUIRED'],
    [v => { v.assumptions.reference = ''; }, 'PLCA_FACTOR_SOURCE_REQUIRED'],
    [v => { v.records[3].workbook.rowId = 'row-0'; }, 'EXACT_WORKBOOK_ROWS_REQUIRED'],
    [v => { v.records[3].workbook.evidence.contentDigest = 'b'.repeat(64); }, 'WORKBOOK_REVISION_MISMATCH'],
    [v => { v.assumptions.factors.push({ ...v.assumptions.factors[0] }); }, 'PLCA_FACTOR_MAPPING_INVALID'],
    [v => { v.assumptions.factors[0].value = Infinity; }, 'PLCA_FACTOR_MAPPING_INVALID'],
    [v => { v.assumptions.factors[0].studyItemId = 'row-3'; }, 'PLCA_FACTOR_ROW_NOT_RESOURCE'],
  ]) {
    const value = input(); change(value);
    assert.throws(() => run(value), { message });
  }
});
