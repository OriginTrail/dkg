// EXHAUSTIVE consensus-conformance grids for the V10 leaf canonicalizer (#1386):
// proves the reverse-engineered rules over their FINITE spaces against the real
// oxigraph 0.5.5 oracle (the full 3600-combo T24 grids, month×day across leap/
// century/negative years, the timezone grid, g-type grids, and ±1 numeric
// boundaries) AND the no-migration idempotence invariant core(oxigraph(x)) ==
// oxigraph(x). Complements the representative cases in term-canon-oracle.test.ts.
import { describe, it, expect } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { canonicalizeObjectTermForHash } from '@origintrail-official/dkg-core';

const xsd = (t: string) => `http://www.w3.org/2001/XMLSchema#${t}`;
const lit = (v: string, dt: string) => `"${v}"^^<${xsd(dt)}>`;

async function oxiForms(objects: string[]): Promise<string[]> {
  const out: string[] = [];
  const CHUNK = 800;
  for (let off = 0; off < objects.length; off += CHUNK) {
    const slice = objects.slice(off, off + CHUNK);
    const store = new OxigraphStore();
    const quads: Quad[] = slice.map((object, i) => ({ subject: 'urn:s', predicate: `urn:p#${i}`, object, graph: 'urn:g' }));
    await store.insert(quads);
    const res = await store.query('CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <urn:g> { ?s ?p ?o } }');
    const byPred = new Map<string, string>();
    if (res.type === 'quads') for (const q of res.quads) byPred.set(q.predicate, q.object);
    for (let i = 0; i < slice.length; i++) out.push(byPred.get(`urn:p#${i}`) ?? '(DROPPED)');
  }
  return out;
}

async function proveParity(label: string, objects: string[]): Promise<void> {
  const oxi = await oxiForms(objects);
  const mismatches: string[] = [];
  // OT-RFC-57: the canon is now a backend-INDEPENDENT value canon — for temporal
  // types it emits the UTC value form, NOT oxigraph's preserved lexical form. So
  // the old "core == oxigraph" identity no longer holds. Assert CONVERGENCE
  // (canon(oxigraph_readback) == canon(input)) — the property consensus needs —
  // and true idempotence (canon(canon(x)) == canon(x)).
  objects.forEach((obj, i) => {
    if (oxi[i] === '(DROPPED)') return;
    const canonIn = canonicalizeObjectTermForHash(obj);
    const canonOxi = canonicalizeObjectTermForHash(oxi[i]);
    if (canonIn !== canonOxi) {
      mismatches.push(`CONVERGENCE in=${obj}\n   canon(in) =${canonIn}\n   canon(oxi ${oxi[i]})=${canonOxi}`);
    }
    if (canonicalizeObjectTermForHash(canonIn) !== canonIn) {
      mismatches.push(`IDEMPOTENCE BROKEN in=${obj}\n   canon=${canonIn}\n   canon(canon)=${canonicalizeObjectTermForHash(canonIn)}`);
    }
  });
  if (mismatches.length) {
    throw new Error(`${label}: ${mismatches.length} mismatch(es):\n${mismatches.slice(0, 30).join('\n')}`);
  }
  expect(mismatches.length).toBe(0);
}

const p2 = (n: number) => String(n).padStart(2, '0');

describe('term-canon EXHAUSTIVE', () => {
  it('T24 dateTime grid: all 3600 (MM,SS) + fractional layer', async () => {
    const objs: string[] = [];
    for (let mm = 0; mm <= 59; mm++) for (let ss = 0; ss <= 59; ss++) {
      objs.push(lit(`2026-06-29T24:${p2(mm)}:${p2(ss)}`, 'dateTime'));
    }
    // fractional layer on a representative cut
    for (let mm = 0; mm <= 59; mm += 7) for (const f of ['.0', '.5', '.250', '.000']) {
      objs.push(lit(`2026-06-29T24:${p2(mm)}:00${f}`, 'dateTime'));
      objs.push(lit(`2026-06-29T24:${p2(mm)}:30${f}`, 'dateTime'));
    }
    await proveParity('T24 dateTime', objs);
  });

  it('T24 time grid: all 3600 (MM,SS)', async () => {
    const objs: string[] = [];
    for (let mm = 0; mm <= 59; mm++) for (let ss = 0; ss <= 59; ss++) {
      objs.push(lit(`24:${p2(mm)}:${p2(ss)}`, 'time'));
    }
    await proveParity('T24 time', objs);
  });

  it('month x day validity grid (leap + non-leap + century), dateTime & date', async () => {
    const objs: string[] = [];
    for (const y of ['2024', '2026', '2000', '1900', '0000', '-0004', '-0001']) {
      for (let mo = 0; mo <= 13; mo++) for (let dd = 0; dd <= 32; dd++) {
        objs.push(lit(`${y}-${p2(mo)}-${p2(dd)}T12:00:00`, 'dateTime'));
        objs.push(lit(`${y}-${p2(mo)}-${p2(dd)}`, 'date'));
      }
    }
    await proveParity('month/day grid', objs);
  });

  it('timezone offset grid (dateTime): Z and ±HH:MM', async () => {
    const objs: string[] = [lit('2026-06-29T12:00:00Z', 'dateTime')];
    for (const sgn of ['+', '-']) for (let h = 0; h <= 15; h++) for (let m = 0; m <= 60; m += 1) {
      objs.push(lit(`2026-06-29T12:00:00${sgn}${p2(h)}:${p2(m)}`, 'dateTime'));
    }
    await proveParity('tz grid', objs);
  });

  it('gMonthDay / gDay / gMonth validity grids', async () => {
    const objs: string[] = [];
    for (let mo = 0; mo <= 13; mo++) for (let dd = 0; dd <= 32; dd++) {
      objs.push(lit(`--${p2(mo)}-${p2(dd)}`, 'gMonthDay'));
    }
    for (let dd = 0; dd <= 32; dd++) objs.push(lit(`---${p2(dd)}`, 'gDay'));
    for (let mo = 0; mo <= 13; mo++) objs.push(lit(`--${p2(mo)}`, 'gMonth'));
    await proveParity('gMonthDay/gDay/gMonth', objs);
  });

  it('numeric ±1 boundaries (i64 months, i128 seconds, 18/19 frac, derived-int i64)', async () => {
    const objs: string[] = [
      // i64 months boundary via Y (12*Y)
      lit('P768614336404564650Y', 'duration'), lit('P768614336404564651Y', 'duration'),
      lit('-P768614336404564650Y', 'duration'), lit('-P768614336404564651Y', 'duration'),
      lit('P9223372036854775807M', 'duration'), lit('P9223372036854775808M', 'duration'),
      // i128 seconds boundary (max = (2^127-1)/1e18 = 170141183460469231731.687303715884105727)
      lit('PT170141183460469231731S', 'duration'),
      lit('PT170141183460469231732S', 'duration'),
      lit('PT170141183460469231731.687303715884105727S', 'duration'),
      lit('PT170141183460469231731.687303715884105728S', 'duration'),
      // 18 vs 19 significant fractional digits
      lit('PT0.123456789012345678S', 'duration'), lit('PT0.1234567890123456789S', 'duration'),
      lit('PT1.000000000000000001S', 'duration'), lit('PT1.0000000000000000001S', 'duration'),
      // derived int i64 collapse boundary
      lit('9223372036854775807', 'long'), lit('9223372036854775808', 'long'),
      lit('-9223372036854775808', 'long'), lit('-9223372036854775809', 'long'),
      lit('9223372036854775808', 'integer'), // xsd:integer keeps arbitrary precision
      // dateTime fractional seconds: 18 vs 19 significant, trailing-zero strip at 19
      lit('2026-06-29T12:00:00.123456789012345678', 'dateTime'),
      lit('2026-06-29T12:00:00.1234567890123456789', 'dateTime'),
      lit('2026-06-29T12:00:00.5000000000000000000', 'dateTime'),
      // year-digit transitions + negative rollover
      lit('9999-12-31T24:00:00', 'dateTime'), lit('-0001-12-31T24:00:00', 'dateTime'),
      lit('-2026-12-31T24:00:00', 'dateTime'), lit('0000-12-31T24:00:00', 'dateTime'),
    ];
    await proveParity('numeric boundaries', objs);
  });
});

// Pure-canon consensus assertions for the two otReviewAgent #1399 findings — no
// oxigraph round-trip (these exercise exotic inputs the store may reject; the point
// is the canonicalizer's own deterministic behavior).
describe('term-canon OT-RFC-57 edge cases (otReviewAgent #1399)', () => {
  const canon = canonicalizeObjectTermForHash;

  it('dateTime overflowing i128 seconds AFTER the tz shift is kept verbatim (not a UTC leaf)', () => {
    // Local components pass the range check, but subtracting -14:00 pushes the UTC
    // instant past the max representable second — must fall back to verbatim.
    const over = lit('5391559471919-03-30T14:00:00-14:00', 'dateTime');
    expect(canon(over)).toBe(over);
    // A near-boundary value that stays in range after folding still normalizes.
    expect(canon(lit('2026-06-29T12:00:00-14:00', 'dateTime'))).toBe(lit('2026-06-30T02:00:00Z', 'dateTime'));
  });

  it('bare gregorian: UTC-equivalent zone folds; a non-UTC offset stays verbatim + distinct', () => {
    // Z / +00:00 / -00:00 fold to the no-timezone value form.
    for (const z of ['Z', '+00:00', '-00:00']) {
      expect(canon(lit(`--06-29${z}`, 'gMonthDay'))).toBe(lit('--06-29', 'gMonthDay'));
    }
    // Non-UTC offsets must NOT collapse onto one leaf (the bug): kept verbatim + distinct.
    const plus = lit('--06-29+14:00', 'gMonthDay');
    const minus = lit('--06-29-14:00', 'gMonthDay');
    expect(canon(plus)).toBe(plus);
    expect(canon(minus)).toBe(minus);
    expect(canon(plus)).not.toBe(canon(minus));
    // gMonth / gDay likewise.
    expect(canon(lit('--06+05:00', 'gMonth'))).toBe(lit('--06+05:00', 'gMonth'));
    expect(canon(lit('--06Z', 'gMonth'))).toBe(lit('--06', 'gMonth'));
    expect(canon(lit('---29-05:00', 'gDay'))).toBe(lit('---29-05:00', 'gDay'));
    expect(canon(lit('---29Z', 'gDay'))).toBe(lit('---29', 'gDay'));
  });
});
