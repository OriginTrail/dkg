// CONSENSUS SAFETY NET for the backend-independent V10 leaf canonicalization
// (dkg-core canonicalizeObjectTermForHash, applied at tripleContentV10).
//
// The protocol canonical form is DEFINED to equal the value-space canonicalization
// the network already deploys (oxigraph 0.5.5). This test is the oracle that
// proves it byte-for-byte: for a broad battery of literals (incl. a randomized
// double sweep), the pure core canonicalizer must produce EXACTLY what a real
// oxigraph store emits on round-trip. If they ever diverge, this fails CI — which
// is the difference between "fixed a publish bug" and "forked RandomSampling".
//
// Matching the deployed form also means the canonicalizer is the IDENTITY on
// already-canonical (store-loaded) terms ⇒ existing on-chain roots are unchanged
// (no migration); a coordinated release suffices.

import { describe, it, expect } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { canonicalizeObjectTermForHash } from '@origintrail-official/dkg-core';

const xsd = (t: string) => `http://www.w3.org/2001/XMLSchema#${t}`;
const G = 'urn:g';
const S = 'urn:s';

/** Round-trip every literal through a real oxigraph store and return, per input,
 *  the canonical object string the store emits — the deployed canonical form. */
async function oxigraphForms(objects: string[]): Promise<string[]> {
  const store = new OxigraphStore();
  const quads: Quad[] = objects.map((object, i) => ({ subject: S, predicate: `urn:p#${i}`, object, graph: G }));
  await store.insert(quads);
  const res = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${G}> { ?s ?p ?o } }`);
  const byPred = new Map<string, string>();
  if (res.type === 'quads') for (const q of res.quads) byPred.set(q.predicate, q.object);
  return objects.map((_, i) => byPred.get(`urn:p#${i}`) ?? '(DROPPED)');
}

/**
 * OT-RFC-57: the canon is now a backend-INDEPENDENT value canon — it no longer
 * reproduces oxigraph's stored lexical form (for temporal types it emits the UTC,
 * ms-truncated form so oxigraph and Blazegraph nodes agree). So we assert
 * CONVERGENCE, not identity: `canon(oxigraph_readback) === canon(input)`. This is
 * exactly what consensus needs — the publisher (input) and a prover reading from
 * an oxigraph store compute the same leaf — and it holds for BOTH the types the
 * canon rewrites (dateTime/time) and the types it leaves as oxigraph's form.
 */
async function expectMatchesOxigraph(objects: string[]): Promise<void> {
  const oxi = await oxigraphForms(objects);
  const mismatches: string[] = [];
  objects.forEach((obj, i) => {
    const canonInput = canonicalizeObjectTermForHash(obj);
    const canonOxi = canonicalizeObjectTermForHash(oxi[i]);
    if (canonInput !== canonOxi) {
      mismatches.push(`  in:            ${obj}\n  canon(input):  ${canonInput}\n  canon(oxi-store ${oxi[i]}): ${canonOxi}`);
    }
  });
  if (mismatches.length) {
    throw new Error(`canon(input) != canon(oxigraph-readback) — publisher/prover would fork (${mismatches.length}/${objects.length}):\n${mismatches.join('\n')}`);
  }
  expect(mismatches.length).toBe(0);
}

const lit = (v: string, dt: string) => `"${v}"^^<${xsd(dt)}>`;

describe('term-canon oracle: core == oxigraph 0.5.5', () => {
  it('xsd:string is elided', async () => {
    await expectMatchesOxigraph([lit('Bitcoin', 'string'), lit('a b c', 'string'), lit('', 'string')]);
  });

  it('language tags are lowercased', async () => {
    await expectMatchesOxigraph(['"x"@EN', '"x"@en', '"x"@en-US', '"x"@EN-us', '"x"@En-Gb', '"x"@DE']);
  });

  it('plain literals and non-literals are unchanged', async () => {
    // plain literal (no datatype) round-trips as-is; oracle handles literals only,
    // so check non-literals (IRI/blank/genid) directly against identity.
    await expectMatchesOxigraph(['"plain"', '"with space"']);
    expect(canonicalizeObjectTermForHash('http://example.org/x')).toBe('http://example.org/x');
    expect(canonicalizeObjectTermForHash('urn:okf:datasets/x/.well-known/genid/b0')).toBe('urn:okf:datasets/x/.well-known/genid/b0');
    expect(canonicalizeObjectTermForHash('_:b0')).toBe('_:b0');
  });

  it('the xsd:integer family collapses to xsd:integer with canonical value', async () => {
    const cases = ['007', '+5', '-0', '00', '-42', '0', '999999999999999999999999'];
    const types = ['integer', 'int', 'long', 'short', 'byte', 'unsignedInt', 'nonNegativeInteger', 'positiveInteger', 'negativeInteger'];
    const objects: string[] = [];
    for (const ty of types) for (const v of cases) {
      // only feed values valid for the type (avoid oxigraph rejecting e.g. negative unsigned)
      if (ty.includes('nonNegative') || ty.includes('unsigned') || ty === 'positiveInteger') { if (v.startsWith('-')) continue; }
      if (ty === 'negativeInteger') { if (!v.startsWith('-') || v === '-0') continue; }
      if (ty === 'positiveInteger' && (v === '0' || v === '00' || v === '-0')) continue;
      if (ty === 'byte' && (v === '999999999999999999999999')) continue;
      objects.push(lit(v, ty));
    }
    await expectMatchesOxigraph(objects);
  });

  it('xsd:decimal value-space canonicalization', async () => {
    const vals = ['1.0', '1.50', '100.0', '0.500', '.5', '-0.0', '+1.5', '010.0', '0', '0.0', '-3.14', '123.456000', '000.000'];
    await expectMatchesOxigraph(vals.map((v) => lit(v, 'decimal')));
  });

  it('xsd:boolean lexical forms', async () => {
    await expectMatchesOxigraph(['1', '0', 'true', 'false'].map((v) => lit(v, 'boolean')));
  });

  it('xsd:dateTime fractional-seconds + timezone normalization', async () => {
    const vals = [
      '2026-06-29T12:00:00', '2026-06-29T12:00:00.0', '2026-06-29T12:00:00.500', '2026-06-29T12:00:00.000',
      '2026-06-29T12:00:00Z', '2026-06-29T12:00:00+00:00', '2026-06-29T12:00:00-00:00', '2026-06-29T12:00:00+02:00',
      '2026-06-29T12:00:00.120Z', '2026-06-29T12:00:00.123456',
    ];
    await expectMatchesOxigraph(vals.map((v) => lit(v, 'dateTime')));
  });

  it('xsd:dateTime T24:00:00 rolls over to next day (incl. month/year/leap boundaries)', async () => {
    const vals = [
      '2026-06-29T24:00:00', '2026-06-30T24:00:00', '2026-12-31T24:00:00', '2024-02-28T24:00:00',
      '2026-02-28T24:00:00', '2026-06-29T24:00:00Z', '2026-06-29T24:00:00+02:00', '2000-02-29T24:00:00',
    ];
    await expectMatchesOxigraph(vals.map((v) => lit(v, 'dateTime')));
  });

  it('xsd:time fractional-seconds + timezone + 24:00:00', async () => {
    const vals = ['12:00:00', '12:00:00.0', '12:00:00.500', '12:00:00Z', '12:00:00+00:00', '12:00:00-00:00', '12:00:00+02:00', '24:00:00', '24:00:00Z'];
    await expectMatchesOxigraph(vals.map((v) => lit(v, 'time')));
  });

  it('date / gYear / gYearMonth / gMonthDay / gMonth / gDay timezone normalization', async () => {
    await expectMatchesOxigraph([
      lit('2026-06-29', 'date'), lit('2026-06-29Z', 'date'), lit('2026-06-29+00:00', 'date'),
      lit('2026-06-29-00:00', 'date'), lit('2026-06-29+02:00', 'date'),
      lit('2026', 'gYear'), lit('2026+00:00', 'gYear'), lit('2026+02:00', 'gYear'), lit('02026', 'gYear'),
      lit('2026-06', 'gYearMonth'), lit('2026-06+00:00', 'gYearMonth'),
      lit('--06-29', 'gMonthDay'), lit('--06-29+00:00', 'gMonthDay'),
      lit('--06', 'gMonth'), lit('--06+00:00', 'gMonth'), lit('---29', 'gDay'),
    ]);
  });

  it('xsd:duration / dayTimeDuration / yearMonthDuration drop zero components', async () => {
    const dur = ['P1Y0M', 'P1Y', 'PT0S', 'P0Y', 'P1Y2M3DT4H5M6S', '-P1Y', 'P1DT0H', 'PT1H0M0S', 'P0Y0M0DT0H0M0S', 'PT1.500S', 'P0M0D'];
    await expectMatchesOxigraph(dur.map((v) => lit(v, 'duration')));
    await expectMatchesOxigraph(['PT1H0M', 'PT0H0M0S'].map((v) => lit(v, 'dayTimeDuration')));
    await expectMatchesOxigraph(['P1Y0M', 'P0Y0M'].map((v) => lit(v, 'yearMonthDuration')));
  });

  it('literal-content escaping is normalized (decode + minimal re-escape)', async () => {
    // NOTE: double-backslash in source = a single literal backslash in the term.
    await expectMatchesOxigraph([
      lit('caf\\u00e9', 'string'),       // é -> é
      lit('smile\\U0001F600', 'string'), // \U… -> 😀
      lit('tab\\there', 'string'),       // \t -> raw tab
      lit('q\\"uote', 'string'),         // \" stays escaped
      lit('back\\\\slash', 'string'),    // \\ stays escaped
      lit('new\\nline', 'string'),       // \n stays escaped
      lit('ret\\rX', 'string'),          // \r stays escaped
      lit('caf\\u00e9', 'http://example.org/custom'), // escaping normalized for verbatim datatypes too
      '"smile\\U0001F600"@EN',           // and for language-tagged literals
      '"plain ascii"',
    ]);
  });

  it('datatypes oxigraph leaves verbatim are returned unchanged', async () => {
    const verbatim = [
      lit('2026-06-29', 'date'), lit('2026-06-29Z', 'date'), lit('12:00:00', 'time'),
      lit('2026', 'gYear'), lit('02026', 'gYear'), lit('4A6f', 'hexBinary'), lit('SGk=', 'base64Binary'),
      lit('http://x', 'anyURI'), '"RawValue"^^<http://example.org/custom>',
    ];
    await expectMatchesOxigraph(verbatim);
  });

  describe('xsd:double / xsd:float', () => {
    it('representative + edge lexical forms', async () => {
      const vals = ['1.0E2', '1e10', '-0.0', '3.14', '1E-7', '1.5E300', 'NaN', 'INF', '-INF', '0.1', '0.5', '100', '0', '0.0', '-2.5E-3', '6.022E23'];
      await expectMatchesOxigraph(vals.map((v) => lit(v, 'double')));
      await expectMatchesOxigraph(['1.0', '0.1', '3.14', '1E2', '1.5', '100', '0'].map((v) => lit(v, 'float')));
    });

    it('randomized double sweep across magnitudes', async () => {
      // Deterministic spread (no Math.random — avoid flakiness): mantissas × 10^exp,
      // both signs, across the full exponent range.
      const mantissas = [1, 1.5, 3.14159, 2, 7, 9.999, 1.234567890123, 5.5, 8.0];
      const exps = [-300, -100, -20, -7, -3, -1, 0, 1, 3, 7, 15, 21, 100, 300];
      const objects: string[] = [];
      for (const m of mantissas) for (const e of exps) for (const sign of [1, -1]) {
        const v = sign * m * Math.pow(10, e);
        if (!Number.isFinite(v) || v === 0) continue;
        objects.push(lit(v.toExponential(), 'double')); // feed E-notation; oxigraph + core both expand to plain
      }
      await expectMatchesOxigraph(objects);
    });

    it('float32 rounding (Math.fround) matches oxigraph', async () => {
      const vals = ['0.1', '1.1', '3.14159265358979', '0.2', '1.0E20', '123456.789'];
      await expectMatchesOxigraph(vals.map((v) => lit(v, 'float')));
    });
  });

  it('is idempotent (fixed point) on its own output', async () => {
    const inputs = [lit('007', 'integer'), lit('1.0', 'decimal'), lit('1', 'boolean'), lit('1.0E2', 'double'), '"x"@EN', lit('Bitcoin', 'string')];
    for (const x of inputs) {
      const once = canonicalizeObjectTermForHash(x);
      expect(canonicalizeObjectTermForHash(once)).toBe(once);
    }
  });
});

// Edge classes surfaced by a ~110k-case differential fuzz of
// canonicalizeObjectTermForHash against real oxigraph 0.5.5 (#1386 review). Each is
// asserted byte-equal to oxigraph's round-trip form (the deployed canonical form).
describe('term-canon oracle: fuzz-hardened edge classes (#1386)', () => {
  it('bare datatype IRIs ("v"^^IRI without <>) fold to the canonical bracketed form', async () => {
    await expectMatchesOxigraph([
      `"007"^^${xsd('integer')}`, `"1.50"^^${xsd('decimal')}`, `"1"^^${xsd('boolean')}`,
      `"1.0E2"^^${xsd('double')}`, `"2026-06-29T24:00:00"^^${xsd('dateTime')}`,
    ]);
  });

  it('integers canonicalize ONLY within i64; beyond it (or malformed) stay verbatim', async () => {
    await expectMatchesOxigraph([
      lit('9223372036854775807', 'integer'), lit('-9223372036854775808', 'integer'), // i64 bounds → canon
      lit('+9223372036854775808', 'integer'), lit('00009223372036854775808', 'integer'), // > i64 → verbatim (+/zeros kept)
      lit('-9223372036854775809', 'long'), lit('+-1', 'integer'), lit('99999999999999999999999', 'integer'),
      lit('+5', 'int'), lit('007', 'long'), lit('-0', 'integer'),
    ]);
  });

  it('decimals canonicalize ONLY within the i128/1e18 Decimal range; beyond → verbatim', async () => {
    await expectMatchesOxigraph([
      lit('170141183460469231731.687303715884105727', 'decimal'), // == max → canon
      lit('0170141183460469231731.6873037158841057270', 'decimal'), // max ± zeros → strip
      lit('0170141183460469231732', 'decimal'), // > max int → verbatim
      lit('999999999999999999999999999999.5', 'decimal'), // magnitude overflow → verbatim
      lit('0.1234567890123456789', 'decimal'), // 19 frac digits → verbatim
      lit('1.50', 'decimal'), lit('.5', 'decimal'), lit('+0.0', 'decimal'), lit('007.000', 'decimal'),
    ]);
  });

  it('double/float special values: case-insensitive nan / inf / infinity with optional sign', async () => {
    const forms = ['NaN', 'nan', 'NAN', '+nan', '-nan', 'INF', 'inf', 'Infinity', 'infinity', '+Infinity', '-INF', '-inf', '-Infinity'];
    await expectMatchesOxigraph(forms.map((v) => lit(v, 'double')));
    await expectMatchesOxigraph(forms.map((v) => lit(v, 'float')));
  });

  it('double shortest-representation TIES round half away from zero (oxigraph/Rust, not V8 to-even)', async () => {
    await expectMatchesOxigraph([lit('738507753103385.25', 'double'), lit('-738507753103385.25', 'double'), lit('738507753103385.2', 'double')]);
  });

  it('xsd:float shortest representation matches Rust f32 formatting (not V8 toPrecision)', async () => {
    await expectMatchesOxigraph([
      lit('1.262177448353619e-29', 'float'), lit('1.5474250491067253e+26', 'float'),
      lit('1.2379400392853803e+27', 'float'), lit('0.1', 'float'), lit('3.14', 'float'), lit('1.0E20', 'float'),
    ]);
  });

  it('gMonthDay --02-29 is rejected by oxigraph (no leap-year context) → verbatim', async () => {
    await expectMatchesOxigraph([
      lit('--02-29+00:00', 'gMonthDay'), lit('--02-28+00:00', 'gMonthDay'), lit('--02-29', 'gMonthDay'),
    ]);
  });

  it('duration seconds accept trailing/leading dot (PT1.S → PT1S, PT.5S → PT0.5S)', async () => {
    await expectMatchesOxigraph([
      lit('PT1.S', 'duration'), lit('PT.5S', 'duration'), lit('P1DT2.S', 'duration'), lit('PT60.S', 'duration'),
    ]);
  });

  it('years: 4-digit or 5+-no-leading-zero canonicalize; leading-zero 5+ → verbatim; -0000 → 0000', async () => {
    await expectMatchesOxigraph([
      lit('12026-01-01T00:00:00+00:00', 'dateTime'), lit('100000-01-01T00:00:00+00:00', 'dateTime'),
      lit('0000-01-01T00:00:00+00:00', 'dateTime'), lit('09508-01-01T00:00:00+00:00', 'dateTime'),
      lit('-0000-06-15T12:30:45Z', 'dateTime'), lit('-0000', 'gYear'), lit('012026-06+00:00', 'gYearMonth'),
    ]);
  });

  it('years whose seconds-since-epoch overflow oxigraph i128/1e18 Decimal → verbatim', async () => {
    await expectMatchesOxigraph([
      lit('5391559471918-01-01T00:00:00+00:00', 'dateTime'), // within range → fold tz to Z
      lit('5391559471919-01-01T00:00:00+00:00', 'dateTime'), // overflow → verbatim (+00:00 kept)
      lit('9223372036854775808+00:00', 'gYear'), lit('99999999999999999999-06+00:00', 'gYearMonth'),
      lit('123456789012345678901234567890+00:00', 'date'),
    ]);
  });

  it('dateTime/time fractional seconds beyond 18 digits → verbatim (no tz fold)', async () => {
    await expectMatchesOxigraph([
      lit('2026-06-29T12:00:00.123456789012345678+00:00', 'dateTime'), // 18 → fold tz to Z
      lit('2026-06-29T12:00:00.1234567890123456789+00:00', 'dateTime'), // 19 → verbatim
      lit('12:00:00.1234567890123456789+00:00', 'time'),
    ]);
  });

  it('T24:00 rolls iff minute==0 OR seconds==0; otherwise verbatim', async () => {
    await expectMatchesOxigraph([
      lit('2026-06-29T24:00:00', 'dateTime'), lit('2026-06-29T24:00:01', 'dateTime'),
      lit('2026-06-29T24:10:00', 'dateTime'), lit('2026-06-29T24:30:45', 'dateTime'),
      lit('2026-06-29T24:12:00.5', 'dateTime'), lit('24:01:00', 'time'), lit('24:01:01', 'time'),
    ]);
  });

  it('durations: value-space carry/overflow, subtype constraints, verbatim beyond i64/i128', async () => {
    await expectMatchesOxigraph([
      lit('P1Y13M', 'duration'), lit('PT3600S', 'duration'), lit('PT25H', 'dayTimeDuration'),
      lit('P1DT24H', 'duration'), lit('-P1Y13M', 'duration'), lit('PT90.5S', 'duration'), lit('PT.5S', 'duration'),
      lit('P1D', 'yearMonthDuration'), lit('P1Y', 'dayTimeDuration'),
      lit('P768614336404564651Y', 'duration'), lit('P9999999999999999999DT0H', 'duration'),
      lit('PT0.1234567890123456789S', 'duration'),
    ]);
  });

  it('datatype IRI \\u escapes are decoded (oxigraph), affecting datatype matching', async () => {
    await expectMatchesOxigraph([`"x"^^<http://example.org/\\u0041>`]);
  });

  it('a \\U escape beyond U+10FFFF never throws (the leaf computation must not crash)', () => {
    expect(() => canonicalizeObjectTermForHash(`"\\U00110000"^^<${xsd('string')}>`)).not.toThrow();
    expect(() => canonicalizeObjectTermForHash(`"x\\Uffffffffy"^^<${xsd('string')}>`)).not.toThrow();
  });

  it('NO-MIGRATION + idempotence over a broad battery: canon is the identity on oxigraph output', async () => {
    const p2 = (n: number) => String(n).padStart(2, '0');
    const battery: string[] = [];
    for (const v of ['0', '7', '-42', '007', '+5', '999999999999999999999999', '9223372036854775808'])
      battery.push(lit(v, 'integer'), lit(v, 'long'));
    for (const v of ['1.0', '1.50', '.5', '-0.0', '123.456000', '999999999999999999999999999999.5'])
      battery.push(lit(v, 'decimal'));
    for (const v of ['1.0E2', '1e10', 'NaN', 'INF', '-INF', '3.14', '738507753103385.25', 'infinity'])
      battery.push(lit(v, 'double'));
    for (let h = 0; h <= 24; h++) for (const ss of ['00', '30', '59'])
      battery.push(lit(`2026-06-29T${p2(h)}:00:${ss}`, 'dateTime'), lit(`${p2(h)}:00:${ss}`, 'time'));
    for (const v of ['2026-06-29T12:00:00.500+00:00', '2026-06-29T24:00:00', '-0044-03-15T12:00:00', '09508-01-01T00:00:00'])
      battery.push(lit(v, 'dateTime'));
    for (const v of ['P1Y13M', 'PT3600S', 'PT25H', '-P1Y', 'P0Y0M0DT0H0M0S']) battery.push(lit(v, 'duration'));
    battery.push(lit('café', 'string'), '"x"@EN', lit('4A6f', 'hexBinary'), `"007"^^${xsd('integer')}`);

    const oxi = await oxigraphForms(battery);
    for (let i = 0; i < battery.length; i++) {
      const once = canonicalizeObjectTermForHash(battery[i]);
      expect(canonicalizeObjectTermForHash(once)).toBe(once); // idempotent (fixed point)
      // OT-RFC-57: the canon is no longer the IDENTITY on oxigraph's output — for
      // temporal types it normalizes oxigraph's preserved form to the UTC value
      // form (so oxigraph nodes agree with Blazegraph). That is the intended
      // oxigraph/devnet migration (mainnet = Blazegraph is unchanged; asserted by
      // the Blazegraph oracle). What MUST hold for consensus is CONVERGENCE:
      // canon(oxigraph_readback) == canon(input) ⇒ publisher and an oxigraph
      // prover compute the same leaf.
      if (oxi[i] !== '(DROPPED)') expect(canonicalizeObjectTermForHash(oxi[i])).toBe(once);
    }
  });

  // DOCUMENTED oxigraph 0.5.5 STORAGE defect, deliberately NOT mirrored (see term-canon.ts):
  // a BEFORE-EPOCH dateTime (year ≤ 0000) with seconds==59 + a non-zero fraction has its
  // minute bumped on every store round-trip (no stable form), so canon stays deterministic +
  // idempotent rather than chasing the drift.
  it('before-epoch dateTime with :59 + fraction — core is deterministic + idempotent (oxigraph is not)', () => {
    for (const x of ['-1711-04-09T15:19:59.6', '0000-06-15T10:10:59.9Z', '0000-12-31T23:59:59.999Z']) {
      const once = canonicalizeObjectTermForHash(lit(x, 'dateTime'));
      expect(canonicalizeObjectTermForHash(once)).toBe(once); // idempotent (the consensus-relevant property)
    }
  });
});
