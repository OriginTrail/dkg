import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TypeScriptProgramHost } from '../../packages/semantic-runtime/dist/index.js';
import { run } from './jpb-plca-mapped.ts';
import { createJpbMappedProgramBundle } from './jpb-plca-mapped-bundle.mjs';

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

// Fixed fixture keys in the existing snapshot's canonical order. Node crypto is
// the independent digest oracle for both the host library and the guest bundle.
const snapshotText = value => JSON.stringify(value.records.map(({ workbook: w }) => ({ workbook: {
  evidence: { contentDigest: w.evidence.contentDigest }, material: w.material, quantity: w.quantity, rowId: w.rowId, unit: w.unit,
} })));
const expectedSnapshot = value => 'urn:nos:mapped:' + createHash('sha256').update(snapshotText(value)).digest('hex');
function boundaryInputs() {
  return [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128].map(offset => {
    const value = input(); value.records[0].workbook.material = 'Čelik 🌍 中 e\u0301 \ud800';
    const base = Buffer.byteLength(snapshotText(value)), target = (Math.floor(base / 64) + 1) * 64 + offset;
    value.records[0].workbook.material += 'x'.repeat(target - base);
    assert.equal(Buffer.byteLength(snapshotText(value)), target);
    return value;
  });
}

test('mapped snapshot matches Node SHA-256 for Unicode and padding/block boundaries', () => {
  for (const value of boundaryInputs()) assert.equal(run(value).assessment.sourceSnapshot, expectedSnapshot(value));
});

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
  assert.equal(result.assessment.sourceSnapshot, 'urn:nos:mapped:16cc0d148eff1d6cc60eefeb89c538d7f1be4e7386b2fbba7d7c066258f72e65');
  assert.deepEqual(result.assessment.contributions[0], { studyItemId: 'row-0', sourceCell: 'row-0',
    datasetId: 'urn:test:factors', factor: 2, impact: 4, perProduct: 2 });
  const changed = input(); changed.assumptions.outputUnits = 3;
  assert.equal(run(changed).assessment.total, 18);
  assert.equal(run(changed).assessment.perProduct, 6);
  assert.equal(run(changed).assessment.sourceSnapshot, result.assessment.sourceSnapshot);
});

test('mapped PLCA preserves validation precedence before resource and impact arithmetic', () => {
  for (const [change, message] of [
    [v => { v.assumptions.outputUnits = 0; v.assumptions.reference = ''; }, 'PLCA_ESTIMATE_BASIS_REQUIRED'],
    [v => { v.assumptions.date = ''; v.assumptions.factors.push({ ...v.assumptions.factors[0] }); }, 'PLCA_FACTOR_SOURCE_REQUIRED'],
    [v => { v.assumptions.factors.push({ ...v.assumptions.factors[0] }); v.assumptions.internalTransferRows = v.records.map(r => r.workbook.rowId); }, 'PLCA_FACTOR_MAPPING_INVALID'],
    [v => { v.assumptions.internalTransferRows = v.records.map(r => r.workbook.rowId); }, 'PLCA_STUDY_INVENTORY_REQUIRED'],
    [v => { v.assumptions.factors[0].studyItemId = 'row-3'; v.assumptions.outputUnits = Number.MIN_VALUE; }, 'PLCA_FACTOR_ROW_NOT_RESOURCE'],
  ]) {
    const value = input(); change(value);
    assert.throws(() => run(value), { message });
  }
});

test('mapped PLCA retains quantity, impact, subtotal and per-product overflow rejection', () => {
  for (const [change, message] of [
    [v => { v.records[0].workbook.quantity = Number.MAX_VALUE; v.records[1].workbook.quantity = Number.MAX_VALUE; v.assumptions.factors = []; }, 'PLCA_INVENTORY_OVERFLOW'],
    [v => { v.assumptions.outputUnits = Number.MIN_VALUE; v.assumptions.factors = []; }, 'PLCA_INVENTORY_OVERFLOW'],
    [v => { v.records[0].workbook.quantity = Number.MAX_VALUE; }, 'PLCA_IMPACT_OVERFLOW'],
    [v => { v.assumptions.outputUnits = 1; v.assumptions.factors.forEach(f => { f.value = 4e307; }); }, 'PLCA_IMPACT_OVERFLOW'],
    [v => { v.assumptions.outputUnits = .1; v.records[0].workbook.quantity = 1; v.assumptions.factors[0].value = 1e308; }, 'PLCA_IMPACT_OVERFLOW'],
  ]) {
    const value = input(); change(value);
    assert.throws(() => run(value), { message });
  }
});

test('mapped Program executes the same assessment and snapshot inside the TypeScript guest', async () => {
  const host = new TypeScriptProgramHost();
  try {
    const source = createJpbMappedProgramBundle();
    assert.equal(source, createJpbMappedProgramBundle(), 'packaging is deterministic');
    const artifact = await host.compile(source);
    const execute = value => host.execute(artifact, JSON.stringify([value]),
      { children: [], maxCalls: 1, maxConcurrency: 1, timeoutMs: 30000 }, () => assert.fail('pure estimate cannot issue effects'));
    const complete = input(), partial = input(), unicode = input();
    partial.assumptions.factors.pop(); unicode.records[0].workbook.material = 'Čelik 🌍';
    for (const value of [complete, partial, unicode, ...boundaryInputs()]) {
      const result = JSON.parse(await execute(value));
      assert.deepEqual(result, run(value));
      assert.equal(result.assessment.sourceSnapshot, expectedSnapshot(value));
    }
    const overflow = input(); overflow.records[0].workbook.quantity = Number.MAX_VALUE;
    await assert.rejects(execute(overflow), /PLCA_IMPACT_OVERFLOW/);
  } finally { await host.stop(); }
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
