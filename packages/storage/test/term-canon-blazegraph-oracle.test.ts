// CROSS-BACKEND CONSENSUS oracle for the V10 leaf canonicalization (#1386).
//
// `packages/publisher/test/term-canon-oracle.test.ts` proves the pure core
// canonicalizer (dkg-core `canonicalizeObjectTermForHash`, applied at
// `tripleContentV10`) reproduces **oxigraph 0.5.5**'s round-trip form byte for
// byte. That closes the oxigraph side. It does NOT cover the genuine consensus
// risk: a node running a DIFFERENT triple-store backend (Blazegraph) may store
// a literal in a different lexical form, and if the protocol canon does not
// absorb that difference, the two nodes compute DIFFERENT merkle leaves for the
// SAME published triple — a silent RandomSampling fork.
//
// This oracle closes that gap. For a broad battery of typed literals it asserts:
//
//     canon(blazegraphRoundTrip(x)) === canon(x) === canon(oxigraphRoundTrip(x))
//
// i.e. a node on oxigraph and a node on Blazegraph, each reading the literal
// back from its own store and applying the protocol canon, land on the SAME
// V10 leaf term (== the protocol leaf canon(x)). If Blazegraph normalizes a
// type into a form the canon does not fold to the same value, THIS fails —
// which is the difference between "works on our deployed backend" and "forks
// the moment an operator runs Blazegraph".
//
// Gated on BLAZEGRAPH_TEST_URL (same as blazegraph.integration.test.ts) so a
// local `pnpm test` without a Blazegraph server skips it; CI's tornado-blazegraph
// lane provisions the service container and sets the env var.
//   BLAZEGRAPH_TEST_URL=http://127.0.0.1:9999/bigdata/namespace/kb/sparql
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import type { Quad } from '../src/triple-store.js';
import { canonicalizeObjectTermForHash } from '@origintrail-official/dkg-core';

const BLAZEGRAPH_URL = process.env.BLAZEGRAPH_TEST_URL;

const xsd = (t: string) => `http://www.w3.org/2001/XMLSchema#${t}`;
const lit = (v: string, dt: string) => `"${v}"^^<${xsd(dt)}>`;

// Unique graph per run so a persistent namespace never serves stale data.
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const G = `urn:tc-bg:${RUN}`;
const S = `urn:tc-bg:${RUN}:s`;

/** Round-trip `objects` through a store; return, per input index, the object
 *  term string the store emits on CONSTRUCT (its canonical stored form). */
async function roundTrip(
  store: { insert(q: Quad[]): Promise<unknown>; query(s: string): Promise<any>; dropGraph?(g: string): Promise<unknown> },
  graph: string,
  objects: string[],
): Promise<string[]> {
  const quads: Quad[] = objects.map((object, i) => ({ subject: S, predicate: `urn:p#${i}`, object, graph }));
  await store.insert(quads);
  const res = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  const byPred = new Map<string, string>();
  if (res?.type === 'quads') for (const q of res.quads) byPred.set(q.predicate, q.object);
  else if (Array.isArray(res?.quads)) for (const q of res.quads) byPred.set(q.predicate, q.object);
  return objects.map((_, i) => byPred.get(`urn:p#${i}`) ?? '(DROPPED)');
}

let blaze: BlazegraphStore;
let oxi: OxigraphStore;
let graphSeq = 0;

/**
 * Assert both backends converge to the same protocol leaf for every literal.
 * Each call uses a fresh sub-graph so re-runs never see stale data.
 */
async function expectCrossBackendLeafAgreement(objects: string[]): Promise<void> {
  const bgGraph = `${G}:${++graphSeq}`;
  const oxGraph = `${G}:ox:${graphSeq}`;
  const [bzForms, oxiForms] = await Promise.all([
    roundTrip(blaze, bgGraph, objects),
    roundTrip(oxi, oxGraph, objects),
  ]);
  await blaze.dropGraph(bgGraph).catch(() => {});

  const mismatches: string[] = [];
  objects.forEach((obj, i) => {
    const leaf = canonicalizeObjectTermForHash(obj); // the protocol leaf
    const leafFromBz = canonicalizeObjectTermForHash(bzForms[i]!);
    const leafFromOxi = canonicalizeObjectTermForHash(oxiForms[i]!);
    if (leafFromBz !== leaf || leafFromOxi !== leaf) {
      mismatches.push(
        `  in:               ${obj}\n` +
          `  canon(in) [leaf]: ${leaf}\n` +
          `  blazegraph→canon: ${leafFromBz}  (stored: ${bzForms[i]})\n` +
          `  oxigraph→canon:   ${leafFromOxi}  (stored: ${oxiForms[i]})`,
      );
    }
  });
  if (mismatches.length) {
    throw new Error(
      `CROSS-BACKEND V10 LEAF DIVERGENCE (${mismatches.length}/${objects.length}) — a Blazegraph node would fork RandomSampling:\n${mismatches.join('\n\n')}`,
    );
  }
  expect(mismatches.length).toBe(0);
}

describe.skipIf(!BLAZEGRAPH_URL)('term-canon cross-backend oracle: oxigraph ⇄ blazegraph leaf agreement (#1386)', () => {
  beforeAll(async () => {
    blaze = new BlazegraphStore(BLAZEGRAPH_URL as string);
    oxi = new OxigraphStore();
    await blaze.dropGraph(G).catch(() => {});
  }, 120_000);

  afterAll(async () => {
    if (blaze) await blaze.dropGraph(G).catch(() => {});
  });

  it('xsd:string elision', async () => {
    await expectCrossBackendLeafAgreement([lit('Bitcoin', 'string'), lit('a b c', 'string'), lit('', 'string')]);
  });

  it('language-tag lowercasing', async () => {
    await expectCrossBackendLeafAgreement(['"x"@EN', '"x"@en', '"x"@en-US', '"x"@EN-us', '"x"@En-Gb', '"x"@DE']);
  });

  it('plain literals', async () => {
    await expectCrossBackendLeafAgreement(['"plain"', '"with space"']);
  });

  it('xsd:integer family (incl. out-of-i64)', async () => {
    const cases = ['007', '+5', '-0', '00', '-42', '0', '999999999999999999999999'];
    const types = ['integer', 'int', 'long', 'short', 'nonNegativeInteger', 'positiveInteger', 'negativeInteger'];
    const objects: string[] = [];
    for (const ty of types)
      for (const v of cases) {
        if (ty.includes('nonNegative') || ty === 'positiveInteger') if (v.startsWith('-')) continue;
        if (ty === 'negativeInteger') if (!v.startsWith('-') || v === '-0') continue;
        if (ty === 'positiveInteger' && (v === '0' || v === '00' || v === '-0')) continue;
        objects.push(lit(v, ty));
      }
    await expectCrossBackendLeafAgreement(objects);
  });

  it('xsd:decimal value-space', async () => {
    const vals = ['1.0', '1.50', '100.0', '0.500', '.5', '-0.0', '+1.5', '010.0', '0', '0.0', '-3.14', '123.456000', '000.000'];
    await expectCrossBackendLeafAgreement(vals.map((v) => lit(v, 'decimal')));
  });

  it('xsd:boolean', async () => {
    await expectCrossBackendLeafAgreement(['1', '0', 'true', 'false'].map((v) => lit(v, 'boolean')));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // CROSS-BACKEND AGREEMENT (OT-RFC-57) — RESOLVED, and now asserted as `it`.
  //
  // This oracle originally DETECTED a real divergence: Blazegraph normalizes these
  // datatypes into a different lexical form than oxigraph — e.g. a timezone-less
  // `"2026-06-29T12:00:00"` is STORED by Blazegraph as `"2026-06-29T12:00:00.000Z"`
  // (adds `Z` + `.000`), and a positive offset is shifted to UTC. The #1386 canon
  // (oxigraph-tuned) did not reconcile that; the RS extractor hashes STORE-EMITTED
  // terms (packages/random-sampling/src/ka-extractor.ts), so a Blazegraph node
  // would compute a DIFFERENT V10 leaf → RandomSampling fork. OT-RFC-57's backend-
  // independent value-canon FIXES this: every case below now asserts real cross-
  // backend agreement (`canon(store_readback)` converges to `canon(input)` on both
  // backends). Astral (> U+FFFF) content — formerly the one `it.fails` — is now
  // covered too: BlazegraphStore serializes writes ASCII-safe (surrogate-pair
  // \uXXXX escapes) so the store no longer corrupts supplementary-plane chars
  // (OT-RFC-57 §7.7; the old "the daemon's raw-UTF-8 path is not affected" note
  // was WRONG — Blazegraph ASCII-decodes the raw N-Quads body byte-wise).
  // ───────────────────────────────────────────────────────────────────────────
  it('xsd:dateTime fractional-seconds + timezone (OT-RFC-57)', async () => {
    const vals = [
      '2026-06-29T12:00:00', '2026-06-29T12:00:00.0', '2026-06-29T12:00:00.500', '2026-06-29T12:00:00.000',
      '2026-06-29T12:00:00Z', '2026-06-29T12:00:00+00:00', '2026-06-29T12:00:00-00:00', '2026-06-29T12:00:00+02:00',
      '2026-06-29T12:00:00-05:00', '2026-06-29T23:00:00-05:00', // negative offset (incl. one that rolls the date forward)
      '2026-06-29T12:00:00.120Z', '2026-06-29T12:00:00.123456',
    ];
    await expectCrossBackendLeafAgreement(vals.map((v) => lit(v, 'dateTime')));
  });

  it('xsd:dateTime T24:00:00 rollover (OT-RFC-57)', async () => {
    const vals = [
      '2026-06-29T24:00:00', '2026-12-31T24:00:00', '2024-02-28T24:00:00', '2026-02-28T24:00:00',
      '2026-06-29T24:00:00Z', '2026-06-29T24:00:00+02:00', '2000-02-29T24:00:00',
    ];
    await expectCrossBackendLeafAgreement(vals.map((v) => lit(v, 'dateTime')));
  });

  it('xsd:time (OT-RFC-57)', async () => {
    const vals = ['12:00:00', '12:00:00.0', '12:00:00.500', '12:00:00Z', '12:00:00+00:00', '12:00:00-00:00', '12:00:00+02:00', '12:00:00-05:00', '24:00:00', '24:00:00Z'];
    await expectCrossBackendLeafAgreement(vals.map((v) => lit(v, 'time')));
  });

  it('date / gYear / gYearMonth / gMonthDay / gMonth / gDay (OT-RFC-57)', async () => {
    await expectCrossBackendLeafAgreement([
      lit('2026-06-29', 'date'), lit('2026-06-29Z', 'date'), lit('2026-06-29+00:00', 'date'),
      lit('2026-06-29-00:00', 'date'), lit('2026-06-29+02:00', 'date'), lit('2026-06-29-05:00', 'date'),
      lit('2026', 'gYear'), lit('2026+00:00', 'gYear'), lit('2026+02:00', 'gYear'), lit('02026', 'gYear'),
      lit('2026-06', 'gYearMonth'), lit('2026-06+00:00', 'gYearMonth'),
      lit('--06-29', 'gMonthDay'), lit('--06-29+00:00', 'gMonthDay'),
      lit('--06', 'gMonth'), lit('--06+00:00', 'gMonth'), lit('---29', 'gDay'),
    ]);
  });

  it('xsd:duration / dayTimeDuration / yearMonthDuration zero-component dropping', async () => {
    const dur = ['P1Y0M', 'P1Y', 'PT0S', 'P0Y', 'P1Y2M3DT4H5M6S', '-P1Y', 'P1DT0H', 'PT1H0M0S', 'P0Y0M0DT0H0M0S', 'PT1.500S', 'P0M0D'];
    await expectCrossBackendLeafAgreement(dur.map((v) => lit(v, 'duration')));
    await expectCrossBackendLeafAgreement(['PT1H0M', 'PT0H0M0S'].map((v) => lit(v, 'dayTimeDuration')));
    await expectCrossBackendLeafAgreement(['P1Y0M', 'P0Y0M'].map((v) => lit(v, 'yearMonthDuration')));
  });

  it('xsd:double / xsd:float (OT-RFC-57)', async () => {
    // Signed zero folds to "0" on both backends (Blazegraph drops the sign on
    // write; the canon now emits "0" for -0.0 to match — OT-RFC-57 §7.5).
    const dbl = ['1.0E2', '1e10', '-0.0', '3.14', '1E-7', '1.5E300', 'NaN', 'INF', '-INF', '0.1', '0.5', '100', '0', '0.0', '-2.5E-3', '6.022E23'];
    await expectCrossBackendLeafAgreement(dbl.map((v) => lit(v, 'double')));
    await expectCrossBackendLeafAgreement(['1.0', '0.1', '3.14', '1E2', '1.5', '100', '0'].map((v) => lit(v, 'float')));
  });

  it('randomized double sweep across magnitudes', async () => {
    const mantissas = [1, 1.5, 3.14159, 2, 7, 9.999, 1.234567890123, 5.5, 8.0];
    const exps = [-300, -100, -20, -7, -3, -1, 0, 1, 3, 7, 15, 21, 100, 300];
    const objects: string[] = [];
    for (const m of mantissas)
      for (const e of exps)
        for (const sign of [1, -1]) {
          const v = sign * m * Math.pow(10, e);
          if (!Number.isFinite(v) || v === 0) continue;
          objects.push(lit(v.toExponential(), 'double'));
        }
    await expectCrossBackendLeafAgreement(objects);
  });

  // BMP (≤ U+FFFF) escaping normalization converges: the value-canon decodes every
  // escape to the raw character then re-emits oxigraph's minimal N-Quads escaping,
  // and Blazegraph reaches the same value for any char that fits in one UTF-16 unit.
  it('literal-content escaping normalization — BMP (OT-RFC-57)', async () => {
    await expectCrossBackendLeafAgreement([
      lit('caf\\u00e9', 'string'),
      lit('tab\\there', 'string'),
      lit('q\\"uote', 'string'),
      lit('back\\\\slash', 'string'),
      lit('new\\nline', 'string'),
      lit('ret\\rX', 'string'),
      '"plain ascii"',
    ]);
  });

  // ASTRAL (> U+FFFF) — the OT-RFC-57 §7.7 hazard, now RESOLVED at the adapter:
  // Blazegraph's parsers corrupt supplementary-plane content on write via BOTH
  // wire shapes (raw UTF-8 in the N-Quads body is byte-wise ASCII-decoded to
  // U+FFFD; a \UXXXXXXXX escape is truncated to its low 16 bits, \U0001F600
  // 😀 → U+F600). BlazegraphStore.insert now ships a pure-ASCII body with
  // \uXXXX per UTF-16 code unit (astral chars as their surrogate pair — the
  // one form Blazegraph parses losslessly), so both backends hold the SAME
  // string and the leaves converge. This was the devnet pr1386-term-canon
  // "astral" publish failure (stored corruption → storage-ACK
  // MERKLE_MISMATCH_IN_SWM decline → quorum death) on any devnet with
  // Blazegraph nodes.
  it('literal-content escaping — ASTRAL round-trips on Blazegraph [OT-RFC-57 §7.7 resolved]', async () => {
    await expectCrossBackendLeafAgreement([
      lit('smile\\U0001F600', 'string'),
      '"smile\\U0001F600"@EN',
      // Raw supplementary-plane chars — the exact shape the daemon publish path
      // sends (N3 decodes input escapes to raw chars before the store write):
      // 🚀 U+1F680, 𝔘 U+1D518, 𠜎 U+2070E (CJK Ext-B).
      lit('raw🚀𝔘𠜎', 'string'),
      '"raw😀"@EN',
      '"plain raw 🚀"',
    ]);
  });

  it('verbatim datatypes (hexBinary / base64Binary / anyURI / custom)', async () => {
    await expectCrossBackendLeafAgreement([
      lit('4A6f', 'hexBinary'), lit('SGk=', 'base64Binary'), lit('http://x', 'anyURI'),
      '"RawValue"^^<http://example.org/custom>',
    ]);
  });
});
