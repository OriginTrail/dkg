// Protocol-defined, BACKEND-INDEPENDENT canonicalization of an RDF object term,
// applied at the V10 merkle leaf (tripleContentV10) so EVERY node computes the
// identical leaf for the same triple regardless of which triple store it runs
// (oxigraph, blazegraph, a SPARQL endpoint, future backends) and which version.
// Without this the leaf delegated literal canonicalization to whatever string the
// backend emitted, so a publisher sealing pre-store and a peer recomputing
// post-store could hash different serializations of the SAME triple →
// MERKLE_MISMATCH_IN_SWM (okf-dkg-vm-validation-report.md), and two nodes on
// different backends could fork RandomSampling (the contract hashes this exact
// content: leaf = keccak256(content)).
//
// The canonical form is DEFINED to equal the value-space canonicalization the
// network already deploys (oxigraph 0.5.5), verified byte-for-byte by the
// oxigraph-oracle test (packages/publisher/test/term-canon-oracle.test.ts), so it
// is the IDENTITY on already-canonical (store-loaded) terms ⇒ no migration; a
// coordinated release suffices.
//
// STRUCTURE (per consensus primitive: easy to audit, hard to drift):
//   parse → validate against oxigraph's EXACT accepted set → canonicalize if
//   valid, else return the escaping-normalized term VERBATIM. Every normalize is
//   gated by a validate: oxigraph keeps an ill-typed-but-syntactically-odd literal
//   verbatim (e.g. "not-a-date+00:00"^^xsd:dateTime), so we must NOT mutate it.
//
// Covered (all verified against oxigraph 0.5.5 — see the oracle test):
//  - literal-content ESCAPING (decode N-Triples escapes, re-emit oxigraph's
//    minimal \ " \n \r escaping); BARE datatype IRIs ("v"^^IRI w/o <>) folded to
//    the bracketed form; language-tag lowercasing; xsd:string elision.
//  - xsd:integer family (collapse→xsd:integer iff value∈i64; xsd:integer
//    arbitrary precision); xsd:decimal; xsd:boolean; xsd:double / xsd:float.
//  - the date/time family with FULL value-space validation + the +00:00/-00:00→Z
//    tz fold (xsd:dateTime/time/date/gYear/gYearMonth/gMonthDay/gMonth/gDay) and
//    the T24:00→next-day roll (oxigraph rolls iff minute==0 OR seconds==0).
//  - xsd:duration / dayTimeDuration / yearMonthDuration: FULL value-space
//    normalization — leading-zero strip + component carry/overflow (months as
//    i64, seconds as a 10^18-scaled i128 fixed-point, mirroring oxsdatatypes),
//    subtype-component constraints, all-zero → PT0S / P0M.
// Other datatypes (hexBinary, base64Binary, anyURI, token, custom IRIs, …) are
// returned with normalized escaping but otherwise verbatim — matching oxigraph.

import {
  decodeRdfLiteralBody,
  parseRdfLiteralLexicalTerm,
  XSD_STRING_DATATYPE,
} from '@origintrail-official/dkg-rdf-utils';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XSD_INTEGER = XSD + 'integer';

const INTEGER_TYPES = new Set(
  [
    'integer', 'int', 'long', 'short', 'byte',
    'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger',
    'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte',
  ].map((t) => XSD + t),
);
const DURATION_TYPES = new Set(
  ['duration', 'dayTimeDuration', 'yearMonthDuration'].map((t) => XSD + t),
);

// oxigraph parses integers (incl. xsd:integer) into a signed 64-bit int and only
// THEN re-serializes canonically; a value outside i64 fails to parse and is kept
// VERBATIM (sign + leading zeros preserved) — for EVERY integer type, xsd:integer
// included. So canonicalization (collapse-to-integer + strip sign/zeros) applies
// iff the value fits i64.
const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;
// oxsdatatypes Duration: months is i64, seconds is a Decimal == i128 scaled by
// 10^18. A duration whose normalized months/seconds overflow these is rejected by
// oxigraph (kept verbatim), so we must reject (→ verbatim) at the same boundary.
const I128_MIN = -(1n << 127n);
const I128_MAX = (1n << 127n) - 1n;
const DEC_SCALE = 10n ** 18n;

export function canonicalizeObjectTermForHash(object: string): string {
  if (object.length === 0 || object.charCodeAt(0) !== 34 /* " */) return object; // IRI / blank / genid
  const literal = parseRdfLiteralLexicalTerm(object);
  if (!literal) return object;
  const lang = literal.suffix.kind === 'language' ? literal.suffix.language : undefined;
  // oxigraph decodes N-Triples UCHAR (\uXXXX / \UXXXXXXXX) escapes inside the
  // datatype IRI on parse, so the canonical form (and any datatype matching below)
  // must run on the decoded IRI — e.g. <…XMLSchema#integer> ≡ xsd:integer.
  const dtRaw = literal.suffix.kind === 'datatype' ? literal.suffix.datatype : undefined;
  const dt = dtRaw === undefined ? undefined : decodeIriEscapes(dtRaw);
  // Literal CONTENT escaping is normalized for every literal (a store decodes
  // \uXXXX / \t / \U… to raw UTF-8 and re-emits only \ " \n \r escaped).
  const lex = normalizeEscaping(literal.body);

  if (lang !== undefined) return `"${lex}"@${lang.toLowerCase()}`;
  if (dt === undefined || dt === XSD_STRING_DATATYPE) return `"${lex}"`; // plain / xsd:string

  try {
    if (INTEGER_TYPES.has(dt)) return canonIntegerTerm(lex) ?? verbatim(lex, dt);
    if (dt === XSD + 'decimal') return wrap(canonDecimal(lex), dt);
    if (dt === XSD + 'boolean') return wrap(canonBoolean(lex), dt);
    if (dt === XSD + 'double') return wrap(canonDouble(lex, false), dt);
    if (dt === XSD + 'float') return wrap(canonDouble(lex, true), dt);
    if (dt === XSD + 'dateTime') return wrap(canonDateTime(lex), dt);
    if (dt === XSD + 'time') return wrap(canonTime(lex), dt);
    if (dt === XSD + 'date') return wrap(canonDate(lex), dt);
    if (dt === XSD + 'gYear') return wrap(canonGYear(lex), dt);
    if (dt === XSD + 'gYearMonth') return wrap(canonGYearMonth(lex), dt);
    if (dt === XSD + 'gMonthDay') return wrap(canonGMonthDay(lex), dt);
    if (dt === XSD + 'gMonth') return wrap(canonGMonth(lex), dt);
    if (dt === XSD + 'gDay') return wrap(canonGDay(lex), dt);
    if (DURATION_TYPES.has(dt)) return wrap(canonDuration(lex, dt), dt);
  } catch {
    return verbatim(lex, dt); // invalid lexical → escaping-normalized, otherwise verbatim
  }
  return verbatim(lex, dt); // datatype the deployed store leaves verbatim
}

// Both helpers emit the bracketed N-Triples form; `verbatim` is `wrap` of the
// (escaping-normalized) lexical unchanged. Kept distinct for call-site intent.
const wrap = (canonLex: string, dt: string) => `"${canonLex}"^^<${dt}>`;
const verbatim = (lex: string, dt: string) => `"${lex}"^^<${dt}>`;

// ── literal content escaping ───────────────────────────────────────────────────
function normalizeEscaping(lex: string): string {
  const decoded = decodeRdfLiteralBody(lex, {
    invalidEscape: 'preserve',
    allowSurrogateCodePoints: true,
  })!;
  // re-emit oxigraph's minimal escaping (escapeNQuadsLiteral): \ " \n \r only.
  return decoded.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

// Decode N-Triples UCHAR escapes (\uXXXX / \UXXXXXXXX) inside a datatype IRI, as
// oxigraph does on parse. Out-of-range \U (> U+10FFFF) is left undecoded (oxigraph
// would reject the literal; we must not throw).
function decodeIriEscapes(iri: string): string {
  if (!iri.includes('\\')) return iri;
  return iri.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/g, (whole, e: string) => {
    const cp = parseInt(e.slice(1), 16);
    return cp > 0x10ffff ? whole : String.fromCodePoint(cp);
  });
}

// oxigraph stores temporal values as seconds-since-0001-01-01 in the same i128/1e18
// Decimal as xsd:decimal/duration. A date/time whose scaled seconds overflow i128
// fails to parse and is kept VERBATIM, so a foldable timezone / T24 roll / fraction
// strip must NOT be applied to it. Replicated here via a proleptic-Gregorian day
// count. (Byte-exact vs oxigraph for dateTime/date; for the bare g-types the cliff
// may differ by ≤1 year at the ~5.39e12 boundary — a value impossible in real data.)
function daysFromCivil(y: bigint, m: bigint, d: bigint): bigint {
  const yy = m <= 2n ? y - 1n : y;
  const era = (yy >= 0n ? yy : yy - 399n) / 400n;
  const yoe = yy - era * 400n;
  const doy = (153n * (m + (m > 2n ? -3n : 9n)) + 2n) / 5n + d - 1n;
  const doe = yoe * 365n + yoe / 4n - yoe / 100n + doy;
  return era * 146097n + doe - 719468n;
}
// Inverse of daysFromCivil: proleptic-Gregorian (y,m,d) from a signed day count
// (days since 1970-01-01). Standard Howard Hinnant algorithm. Used to roll the
// DATE when a timezone offset pushes a dateTime across midnight during the
// backend-independent UTC normalization (OT-RFC-57).
function civilFromDays(zIn: bigint): { y: bigint; m: bigint; d: bigint } {
  const z = zIn + 719468n;
  const era = (z >= 0n ? z : z - 146096n) / 146097n;
  const doe = z - era * 146097n; // [0, 146096]
  const yoe = (doe - doe / 1460n + doe / 36524n - doe / 146096n) / 365n; // [0, 399]
  const y = yoe + era * 400n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n); // [0, 365]
  const mp = (5n * doy + 2n) / 153n; // [0, 11]
  const d = doy - (153n * mp + 2n) / 5n + 1n; // [1, 31]
  const m = mp < 10n ? mp + 3n : mp - 9n; // [1, 12]
  return { y: m <= 2n ? y + 1n : y, m, d };
}

// OT-RFC-57: the UTC date of "midnight in the given tz" — the backend-independent
// form for xsd:date / gYear / gYearMonth. Blazegraph interprets the value at 00:00
// in its tz, converts to UTC, and takes the UTC date; a positive offset rolls the
// date back a day. offsetMin=0 (Z / no-tz) ⇒ the date is unchanged.
function utcDateFromMidnight(
  y: bigint,
  mo: bigint,
  d: bigint,
  offsetMin: number,
): { y: bigint; m: bigint; d: bigint } {
  const days = daysFromCivil(y, mo, d) + BigInt(Math.floor((0 - offsetMin) / 1440));
  return civilFromDays(days);
}

function temporalInRange(yearStr: string, mo: number, dd: number, hh = 0, mi = 0, ss = 0): boolean {
  const seconds =
    (daysFromCivil(BigInt(yearStr), BigInt(mo), BigInt(dd)) + 719162n) * 86400n +
    BigInt(hh) * 3600n + BigInt(mi) * 60n + BigInt(ss);
  const scaled = seconds * DEC_SCALE;
  return scaled >= I128_MIN && scaled <= I128_MAX;
}

// ── xsd:integer family ─────────────────────────────────────────────────────────
function canonIntegerTerm(lex: string): string | null {
  if (!/^[+-]?\d+$/.test(lex)) return null;     // at most one sign; "+-1" etc. → verbatim
  const v = BigInt(lex.replace(/^\+/, ''));      // BigInt rejects a leading '+'
  if (v < I64_MIN || v > I64_MAX) return null;   // outside i64 → verbatim (xsd:integer included)
  return `"${v.toString()}"^^<${XSD_INTEGER}>`;
}

// ── xsd:boolean ────────────────────────────────────────────────────────────────
function canonBoolean(lex: string): string {
  if (lex === 'true' || lex === '1') return 'true';
  if (lex === 'false' || lex === '0') return 'false';
  throw new Error(`invalid xsd:boolean: ${lex}`);
}

// ── xsd:decimal ────────────────────────────────────────────────────────────────
function trimTrailingAsciiZeros(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 48 /* 0 */) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

function canonDecimal(lex: string): string {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(lex);
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) throw new Error(`invalid xsd:decimal: ${lex}`);
  const intRaw = m[2].replace(/^0+/, '');
  const frac = trimTrailingAsciiZeros(m[3] ?? '');
  // oxigraph stores xsd:decimal as the SAME i128 / 10^18 fixed-point as duration
  // seconds: a value needing more than 18 fractional digits, or whose 10^18-scaled
  // magnitude overflows i128, fails to parse and is kept VERBATIM.
  if (frac.length > 18) throw new Error('xsd:decimal sub-1e-18');
  const scaled = BigInt((intRaw || '0') + frac.padEnd(18, '0'));
  const signed = m[1] === '-' ? -scaled : scaled;
  if (signed < I128_MIN || signed > I128_MAX) throw new Error('xsd:decimal overflow i128');
  const int = intRaw === '' ? '0' : intRaw;
  const sign = m[1] === '-' && !(int === '0' && frac === '') ? '-' : '';
  return frac === '' ? `${sign}${int}` : `${sign}${int}.${frac}`;
}

// ── xsd:double / xsd:float ─────────────────────────────────────────────────────
function canonDouble(lex: string, isFloat: boolean): string {
  let n = parseXsdDouble(lex);
  if (isFloat) n = Math.fround(n);
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'INF';
  if (n === -Infinity) return '-INF';
  // OT-RFC-57: negative zero folds to "0". Blazegraph drops the sign on write
  // ("-0.0"^^double → stored "0.0" → value 0), while oxigraph keeps "-0"; emitting
  // "0" for both signed zeros makes canon(input) == canon(store-readback) on either
  // backend. (The IEEE-754 -0/+0 distinction is not consensus-observable here.)
  if (n === 0) return '0';
  const neg = n < 0;
  const a = Math.abs(n);
  // double: V8's a.toString() IS the shortest round-trip; only ties need the
  // away-from-zero correction. float: V8 has no f32-shortest, so search it.
  const shortest = isFloat ? shortestFloat32String(a) : roundTiesAwayFromZero(a, a.toString(), false);
  const plain = expandToPlainDecimal(shortest);
  return neg ? `-${plain}` : plain;
}

// V8's Number→string breaks shortest-representation ties round-half-to-EVEN, but
// oxigraph (Rust) breaks them round-half-AWAY-from-zero. They diverge only when the
// value sits EXACTLY between two equal-length shortest decimals (e.g. the f64
// 738507753103385.25 → V8 ".2", Rust ".3"). Detect that tie with exact integer
// arithmetic and pick the away-from-zero neighbour to match oxigraph.
function roundTiesAwayFromZero(a: number, shortest: string, isFloat: boolean): string {
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(shortest);
  if (!m) return shortest;
  const digits = m[1] + (m[2] ?? '');
  const D = BigInt(digits);
  const E = (m[3] ? parseInt(m[3], 10) : 0) - (m[2] ? m[2].length : 0); // value = D × 10^E
  const up = D + 1n; // away-from-zero neighbour at the same digit length (a ≥ 0)
  const rt = (x: number) => (isFloat ? Math.fround(x) : x);
  if (rt(Number(`${up}e${E}`)) !== a) return shortest; // up-neighbour doesn't round-trip → no tie
  // Exact tie test: 2·a == (2D+1) × 10^E, with a = num/den from the IEEE-754 bits.
  const [num, den] = f64Fraction(a);
  let lhs = 2n * num;
  let rhs = (2n * D + 1n) * den;
  if (E >= 0) rhs *= 10n ** BigInt(E);
  else lhs *= 10n ** BigInt(-E);
  return lhs === rhs ? `${up}e${E}` : shortest;
}

// Exact value of a finite |f64| as num/den (den a power of two) from its bits.
function f64Fraction(a: number): [bigint, bigint] {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, a);
  const bits = dv.getBigUint64(0);
  const exp = Number((bits >> 52n) & 0x7ffn);
  const fracBits = bits & 0xfffffffffffffn;
  const mant = exp === 0 ? fracBits : fracBits | (1n << 52n);
  const e = (exp === 0 ? -1074 : exp - 1075);
  return e >= 0 ? [mant << BigInt(e), 1n] : [mant, 1n << BigInt(-e)];
}

function parseXsdDouble(lex: string): number {
  // oxigraph parses doubles with Rust's lenient f64::from_str: case-INSENSITIVE
  // nan / inf / infinity (with an optional sign) all parse, not just the XSD
  // spellings NaN / INF / -INF. Match it so e.g. "infinity"/"NaN"/"-inf" canon to
  // the oxigraph forms INF / NaN / -INF instead of staying verbatim.
  if (/^[+-]?nan$/i.test(lex)) return NaN;
  if (/^\+?inf(inity)?$/i.test(lex)) return Infinity;
  if (/^-inf(inity)?$/i.test(lex)) return -Infinity;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(lex)) throw new Error(`invalid xsd:double: ${lex}`);
  return Number(lex);
}

// Shortest decimal that round-trips to the f32 `a`, matching Rust's f32 formatting.
// V8 has no native f32-shortest, and a.toPrecision(p)/toExponential round `a` to
// NEAREST — which can miss the round-tripping p-digit decimal sitting on the other
// side of `a` (a's f32 rounding interval is wider than its f64 one). So at each
// precision we test the nearest p-digit mantissa AND its ±1 neighbours (exact
// integers, no float-grid error), keep those whose f32 round-trip equals a, and
// pick the closest to a — ties to the away-from-zero (larger) value, as Rust does.
function shortestFloat32String(a: number): string {
  for (let p = 1; p <= 9; p++) {
    const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(a.toExponential(p - 1));
    if (!m) break;
    const mant = m[1] + (m[2] ?? ''); // p significant digits
    const e10 = parseInt(m[3], 10) - (p - 1); // value = mant × 10^e10
    const base = BigInt(mant);
    const valid: number[] = [];
    for (const v of [base, base - 1n, base + 1n]) {
      if (v <= 0n) continue;
      const c = Number(`${v}e${e10}`);
      if (Math.fround(c) === a) valid.push(c);
    }
    if (valid.length) {
      valid.sort((x, y) => Math.abs(x - a) - Math.abs(y - a) || y - x); // closest; tie → away from zero
      return valid[0].toString();
    }
  }
  return a.toString();
}

function expandToPlainDecimal(s: string): string {
  const m = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (!m) return s;
  const intPart = m[1];
  const frac = m[2] ?? '';
  const exp = parseInt(m[3], 10);
  const digits = intPart + frac;
  const pointPos = intPart.length + exp;
  if (pointPos <= 0) return stripTrailingZeros(`0.${'0'.repeat(-pointPos)}${digits}`);
  if (pointPos >= digits.length) return digits + '0'.repeat(pointPos - digits.length);
  return stripTrailingZeros(`${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`);
}

function stripTrailingZeros(s: string): string {
  if (!s.includes('.')) return s;
  const trimmed = trimTrailingAsciiZeros(s);
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

// ── date/time family ───────────────────────────────────────────────────────────
// Returns the offset MAGNITUDE in minutes (signed) for the
// backend-independent UTC normalization of xsd:dateTime/xsd:time (OT-RFC-57).
// hadTz=false ⇒ no timezone present (a bare dateTime is normalized to UTC and
// gains a Z, matching Blazegraph/Neptune). Malformed/out-of-range tz → throw
// (→ the literal is kept verbatim, as oxigraph does).
function splitTzToOffset(s: string): { body: string; offsetMin: number; hadTz: boolean } {
  const m = /(Z|[+-]\d{2}:\d{2})$/.exec(s);
  if (!m) return { body: s, offsetMin: 0, hadTz: false };
  const tz = m[1];
  const body = s.slice(0, s.length - tz.length);
  if (tz === 'Z') return { body, offsetMin: 0, hadTz: true };
  const h = parseInt(tz.slice(1, 3), 10);
  const mi = parseInt(tz.slice(4, 6), 10);
  if (mi > 59 || h * 60 + mi > 840) throw new Error(`invalid tz: ${tz}`);
  const mag = h * 60 + mi;
  return { body, offsetMin: tz[0] === '-' ? -mag : mag, hadTz: true };
}

// Normalize a fractional-seconds group ('.ddd' or undefined): TRUNCATE to at most
// 3 digits (milliseconds — the backend-independent precision floor; a lossy store
// such as Blazegraph keeps only ms), then strip trailing zeros; drop entirely if
// empty. Truncate, NOT round (matches Blazegraph). (OT-RFC-57)
function normFrac(frac: string | undefined): string {
  if (frac === undefined) return '';
  const d = trimTrailingAsciiZeros(frac.slice(1, 4)); // at most 3 digits, then strip trailing zeros
  return d === '' ? '' : `.${d}`;
}

// Proleptic-Gregorian leap test on the astronomical year number (handles negative
// and arbitrarily large years via BigInt).
function isLeapYear(yearStr: string): boolean {
  const y = BigInt(yearStr);
  return (y % 4n === 0n && y % 100n !== 0n) || y % 400n === 0n;
}
function daysInMonth(yearStr: string, mo: number): number {
  return [31, isLeapYear(yearStr) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
}
// Day after (yearStr, mo, dd). Year crosses are computed on the signed numeric
// year (BigInt) then re-emitted min-4-digit, sign-preserved (…→0000, 9999→10000).
function rollNextDay(yearStr: string, mo: number, dd: number): string {
  let ny = BigInt(yearStr);
  let nmo = mo;
  let nd = dd + 1;
  if (nd > daysInMonth(yearStr, mo)) {
    nd = 1;
    nmo += 1;
    if (nmo > 12) { nmo = 1; ny += 1n; }
  }
  return `${fmtYear(ny)}-${pad2(nmo)}-${pad2(nd)}`;
}
function fmtYear(y: bigint): string {
  const neg = y < 0n;
  const abs = (neg ? -y : y).toString().padStart(4, '0');
  return neg ? `-${abs}` : abs;
}
const pad2 = (n: number) => String(n).padStart(2, '0');

// hh∈[0,24], mm∈[0,59], ss∈[0,59]; hour 24 is valid ONLY when it can roll, which
// oxigraph allows iff minute==0 OR the seconds value (incl. fraction) is 0.
// Returns whether the time rolls to the next day (hour 24 → 00). Throws on any
// out-of-range field or a non-rollable hour-24.
function validateClock(hh: number, mi: number, ss: number, fracNorm: string): { rolls: boolean } {
  if (hh > 24 || mi > 59 || ss > 59) throw new Error('clock out of range');
  if (hh === 24) {
    const secZero = ss === 0 && fracNorm === '';
    if (mi !== 0 && !secZero) throw new Error('invalid hour-24');
    return { rolls: true };
  }
  return { rolls: false };
}

// OT-RFC-57: the backend-independent value canon accepts any 4+-digit year (any
// number of leading zeros) and normalizes it via BigInt+fmtYear (min-4-digit, no
// leading zero). This matches Blazegraph, which on write STRIPS a leading-zero
// year to its value ("02026"^^gYear → "2026") — oxigraph instead keeps the invalid
// literal verbatim, but the CONVERGENCE oracle holds either way since canon(input)
// and canon(store-readback) both fold to the same value form (OT-RFC-57 §7.5).
const YEAR = '-?\\d{4,}';

// OT-RFC-57 backend-independent form: normalize to UTC (subtract the tz offset,
// rolling the DATE across midnight), truncate fraction to ms, always emit Z. A
// no-timezone dateTime is treated as UTC and gains a Z (matching Blazegraph /
// Neptune). This is the value-space form the publisher's input AND every
// backend's read-back converge to.
function canonDateTime(lex: string): string {
  const { body, offsetMin } = splitTzToOffset(lex);
  const m = new RegExp(`^(${YEAR})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(\\.\\d+)?$`).exec(body);
  if (!m) throw new Error('invalid xsd:dateTime');
  const [, yy, mo, dd, hh, mi, ss, frac] = m;
  const moN = +mo;
  const ddN = +dd;
  if (moN < 1 || moN > 12) throw new Error('month');
  if (ddN < 1 || ddN > daysInMonth(yy, moN)) throw new Error('day');
  const fracNorm = normFrac(frac);
  const { rolls } = validateClock(+hh, +mi, +ss, fracNorm);
  // Base date as a day count; a T24:00 clock rolls one day and resets the hour to 0.
  let days = daysFromCivil(BigInt(yy), BigInt(moN), BigInt(ddN));
  const hourN = rolls ? 0 : +hh;
  if (rolls) days += 1n;
  // UTC: subtract the offset (whole minutes); roll the date across midnight.
  const totalMin = hourN * 60 + +mi - offsetMin;
  days += BigInt(Math.floor(totalMin / 1440));
  const minInDay = ((totalMin % 1440) + 1440) % 1440;
  const { y, m: mm, d } = civilFromDays(days);
  // Range-check the NORMALIZED UTC instant, not the lexical components: a tz offset
  // or T24 roll can push a boundary value outside the i128 seconds range it would
  // otherwise pass, emitting a leaf for a value the store can't represent stably
  // (otReviewAgent). Out of range → verbatim (throw, caught upstream).
  if (!temporalInRange(y.toString(), Number(mm), Number(d), Math.floor(minInDay / 60), minInDay % 60, +ss))
    throw new Error('normalized dateTime overflows i128 seconds');
  return `${fmtYear(y)}-${pad2(Number(mm))}-${pad2(Number(d))}T${pad2(Math.floor(minInDay / 60))}:${pad2(minInDay % 60)}:${ss}${fracNorm}Z`;
}

// OT-RFC-57: time has no date, so a tz offset just wraps the wall clock mod 24h;
// normalize to UTC + Z, ms-truncated.
function canonTime(lex: string): string {
  const { body, offsetMin } = splitTzToOffset(lex);
  const m = /^(\d{2}):(\d{2}):(\d{2})(\.\d+)?$/.exec(body);
  if (!m) throw new Error('invalid xsd:time');
  const [, hh, mi, ss, frac] = m;
  const fracNorm = normFrac(frac);
  const { rolls } = validateClock(+hh, +mi, +ss, fracNorm);
  const hourN = rolls ? 0 : +hh;
  const minInDay = (((hourN * 60 + +mi - offsetMin) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(minInDay / 60))}:${pad2(minInDay % 60)}:${ss}${fracNorm}Z`;
}

// OT-RFC-57: xsd:date / gYear / gYearMonth normalize to the UTC date of
// midnight-in-tz, with NO timezone emitted (Blazegraph's value form).
function canonDate(lex: string): string {
  const { body, offsetMin } = splitTzToOffset(lex);
  const m = new RegExp(`^(${YEAR})-(\\d{2})-(\\d{2})$`).exec(body);
  if (!m) throw new Error('invalid xsd:date');
  const moN = +m[2];
  const ddN = +m[3];
  if (moN < 1 || moN > 12) throw new Error('month');
  if (ddN < 1 || ddN > daysInMonth(m[1], moN)) throw new Error('day');
  const { y, m: mm, d } = utcDateFromMidnight(BigInt(m[1]), BigInt(moN), BigInt(ddN), offsetMin);
  // Validate the NORMALIZED date (the tz roll can cross the year boundary) — see canonDateTime.
  if (!temporalInRange(y.toString(), Number(mm), Number(d))) throw new Error('normalized date overflows i128 seconds');
  return `${fmtYear(y)}-${pad2(Number(mm))}-${pad2(Number(d))}`;
}

function canonGYear(lex: string): string {
  const { body, offsetMin } = splitTzToOffset(lex);
  if (!new RegExp(`^${YEAR}$`).test(body)) throw new Error('invalid xsd:gYear');
  const { y, m: mm, d } = utcDateFromMidnight(BigInt(body), 1n, 1n, offsetMin);
  // Validate the NORMALIZED date (a negative offset can roll 01-01 into the prior year).
  if (!temporalInRange(y.toString(), Number(mm), Number(d))) throw new Error('normalized gYear overflows i128 seconds');
  return fmtYear(y);
}

function canonGYearMonth(lex: string): string {
  const { body, offsetMin } = splitTzToOffset(lex);
  const m = new RegExp(`^(${YEAR})-(\\d{2})$`).exec(body);
  if (!m || +m[2] < 1 || +m[2] > 12) throw new Error('invalid xsd:gYearMonth');
  const { y, m: mm, d } = utcDateFromMidnight(BigInt(m[1]), BigInt(+m[2]), 1n, offsetMin);
  // Validate the NORMALIZED date (the tz roll can cross the year boundary).
  if (!temporalInRange(y.toString(), Number(mm), Number(d))) throw new Error('normalized gYearMonth overflows i128 seconds');
  return `${fmtYear(y)}-${pad2(Number(mm))}`;
}

// gMonthDay day bounds. oxigraph 0.5.5 validates --MM-DD against a NON-leap
// reference year, so --02-29 is rejected (kept verbatim) — February's max is 28
// here, unlike a real leap date which needs the year context of xsd:date.
const MONTH_MAX_DAY = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// OT-RFC-57: gMonthDay / gMonth / gDay have no year/date context to convert a
// timezone into UTC. We therefore fold ONLY a UTC-equivalent zone (Z / +00:00 /
// -00:00 → offsetMin 0) to the no-timezone value form. A NON-UTC offset is kept
// VERBATIM (the whole literal, offset included): stripping it would silently
// COLLAPSE distinct values — "--06-29+14:00" and "--06-29-14:00" are different
// literals — onto one leaf (otReviewAgent). Verbatim keeps them distinct and defers
// to the store's own preservation; such exotic offsets on bare gregorian types are
// vanishingly rare and out of the consensus-verified set (see OT-RFC-57 §7.8).
function bareGregorian(lex: string, re: RegExp, validate: (m: RegExpExecArray) => boolean): string {
  const { body, offsetMin } = splitTzToOffset(lex);
  const m = re.exec(body);
  if (!m || !validate(m)) throw new Error('invalid bare gregorian');
  return offsetMin === 0 ? body : lex; // fold UTC-equivalent zone only; else verbatim
}
function canonGMonthDay(lex: string): string {
  return bareGregorian(lex, /^--(\d{2})-(\d{2})$/, (m) => {
    const moN = +m[1];
    const ddN = +m[2];
    return moN >= 1 && moN <= 12 && ddN >= 1 && ddN <= MONTH_MAX_DAY[moN - 1];
  });
}

function canonGMonth(lex: string): string {
  return bareGregorian(lex, /^--(\d{2})$/, (m) => +m[1] >= 1 && +m[1] <= 12);
}

function canonGDay(lex: string): string {
  return bareGregorian(lex, /^---(\d{2})$/, (m) => +m[1] >= 1 && +m[1] <= 31);
}

// ── xsd:duration / dayTimeDuration / yearMonthDuration ─────────────────────────
// Value-space canonicalization mirroring oxsdatatypes Duration { months: i64,
// seconds: Decimal(i128 / 10^18) }. Parse to (months, scaledSeconds), reject if
// either overflows its integer type (→ verbatim), then re-emit the canonical
// component breakdown (Y=months/12, M=months%12; D/H/M/S from seconds).
// Seconds accept a trailing dot with no fraction (oxigraph: "PT1.S" → "PT1S") and a
// leading dot ("PT.5S" → "PT0.5S"), matching Rust's lenient parse.
const RE_DURATION =
  /^(-?)P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d*)?|\.\d+)S)?)?$/;
function canonDuration(lex: string, dt: string): string {
  const m = RE_DURATION.exec(lex);
  if (!m) throw new Error(`invalid duration: ${lex}`);
  const [, sign, y, mo, d, h, mi, sTok] = m;
  if (!y && !mo && !d && !h && !mi && !sTok) throw new Error('empty duration'); // "P" / "PT"

  const isYM = dt === XSD + 'yearMonthDuration';
  const isDT = dt === XSD + 'dayTimeDuration';
  // Subtype component constraints (oxigraph keeps a mis-componented subtype verbatim).
  if (isYM && (d || h || mi || sTok)) throw new Error('yearMonthDuration: time/day component');
  if (isDT && (y || mo)) throw new Error('dayTimeDuration: year/month component');

  // Seconds token → whole + fractional (≤18 significant fractional digits; the
  // oxsdatatypes Decimal scale is 10^18, so a 19th significant digit is rejected).
  let sWhole = '0';
  let fracScaled = 0n;
  if (sTok) {
    const dot = sTok.indexOf('.');
    if (dot === -1) {
      sWhole = sTok;
    } else {
      sWhole = sTok.slice(0, dot) || '0';
      const fracDigits = trimTrailingAsciiZeros(sTok.slice(dot + 1));
      if (fracDigits.length > 18) throw new Error('sub-1e-18 seconds');
      fracScaled = fracDigits === '' ? 0n : BigInt(fracDigits.padEnd(18, '0'));
    }
  }

  const months = 12n * BigInt(y || '0') + BigInt(mo || '0');
  const wholeSeconds =
    86400n * BigInt(d || '0') + 3600n * BigInt(h || '0') + 60n * BigInt(mi || '0') + BigInt(sWhole);
  const scaledSeconds = wholeSeconds * DEC_SCALE + fracScaled;

  // Overflow at oxigraph's stored-integer boundaries (signed) → verbatim.
  const neg = sign === '-';
  const signedMonths = neg ? -months : months;
  const signedScaled = neg ? -scaledSeconds : scaledSeconds;
  if (signedMonths < I64_MIN || signedMonths > I64_MAX) throw new Error('months overflow i64');
  if (signedScaled < I128_MIN || signedScaled > I128_MAX) throw new Error('seconds overflow i128');

  // Re-derive canonical components from magnitudes (sign emitted once).
  const yy = months / 12n;
  const MM = months % 12n;
  const totalWhole = scaledSeconds / DEC_SCALE;
  const fracRem = scaledSeconds % DEC_SCALE;
  const D = totalWhole / 86400n;
  let rem = totalWhole % 86400n;
  const H = rem / 3600n;
  rem %= 3600n;
  const Min = rem / 60n;
  const S = rem % 60n;

  let date = '';
  if (yy > 0n) date += `${yy}Y`;
  if (MM > 0n) date += `${MM}M`;
  if (D > 0n) date += `${D}D`;
  let time = '';
  if (H > 0n) time += `${H}H`;
  if (Min > 0n) time += `${Min}M`;
  if (S > 0n || fracRem > 0n) {
    const fracStr = fracRem === 0n ? '' : `.${trimTrailingAsciiZeros(fracRem.toString().padStart(18, '0'))}`;
    time += `${S}${fracStr}S`;
  }
  const body = time ? `${date}T${time}` : date;
  // All-zero canonical form is subtype-dependent: yearMonthDuration → "P0M",
  // duration / dayTimeDuration → "PT0S".
  if (body === '') return isYM ? 'P0M' : 'PT0S';
  return `${neg ? '-' : ''}P${body}`;
}
