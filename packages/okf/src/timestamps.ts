/**
 * Timestamp primitives for any frontmatter value (SPEC §5): the lexical form a
 * timestamp-valued value is read as (`dateTimeLexical`), and validation of an
 * XSD `dateTime` / `date` lexical, calendar, clock and zone included. They know
 * nothing of families, verification or lifecycle, so document parsing, term
 * encoding, the diagnostics and the trust helpers all read them without
 * depending on one another.
 */

import { yamlLexicalOf } from './yaml-lexical.js';

/** XSD `dateTime` lexical form (`YYYY-MM-DDThh:mm:ss[.s+][Z|±hh:mm]`). The zone is optional in XSD; OKF wants it explicit (§5). */
const XSD_DATE_TIME_RE = /^(-?\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
/** XSD `date` lexical form (`YYYY-MM-DD[Z|±hh:mm]`). */
const XSD_DATE_RE = /^(-?\d{4,})-(\d{2})-(\d{2})(Z|[+-]\d{2}:\d{2})?$/;
const EXPLICIT_OFFSET_RE = /(Z|[+-]\d{2}:\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Calendar check: month 1–12, day within that month (Gregorian, proleptic). */
function isValidCalendarDate(year: string, month: string, day: string): boolean {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || m < 1 || m > 12 || d < 1) return false;
  const days = m === 2 ? (isLeapYear(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
  return d <= days;
}

/** Time check: `hh` 0–23, `mm` / `ss` 0–59; XSD also allows the end-of-day instant `24:00:00[.0+]`. */
function isValidTime(hour: string, minute: string, second: string, fraction?: string): boolean {
  const h = Number(hour);
  const mi = Number(minute);
  const se = Number(second);
  if (h === 24) return mi === 0 && se === 0 && (fraction === undefined || /^\.0+$/.test(fraction));
  return h <= 23 && mi <= 59 && se <= 59;
}

/** Zone check: `Z`, or an offset between −14:00 and +14:00 inclusive (minutes 0–59). */
function isValidZone(zone?: string): boolean {
  if (zone === undefined || zone === 'Z') return true;
  const hh = Number(zone.slice(1, 3));
  const mm = Number(zone.slice(4, 6));
  return hh < 14 ? mm <= 59 : hh === 14 && mm === 0;
}

/**
 * The lexical form of a timestamp-valued frontmatter field.
 *
 * YAML parsers (js-yaml here, PyYAML in the reference agent) turn an unquoted
 * `2026-06-30T14:00:00Z` into a native datetime; a quoted one stays a string.
 * A native `Date` is rendered in the XSD *canonical* form (`Z`, no `.000`),
 * so `2026-06-30T14:00:00Z` round-trips byte-for-byte and an offset-bearing
 * value folds to UTC (same instant — the deployed store canonicalises
 * xsd:dateTime the same way). A string is kept exactly as written.
 */
export function dateTimeLexical(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // A date-only or offset-less YAML timestamp is read as written, as its
    // quoted form would be: no invented UTC offset, no date turned into a time.
    const lexical = yamlLexicalOf(value);
    if (lexical !== undefined && !hasExplicitOffset(lexical)) return lexical;
    const iso = value.toISOString(); // always `YYYY-MM-DDThh:mm:ss.sssZ`
    return value.getUTCMilliseconds() === 0 ? iso.replace('.000Z', 'Z') : iso;
  }
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * True when `lexical` is a valid xsd:dateTime value — shape AND calendar / time /
 * zone ranges. Shape alone would let `2026-02-30T00:00:00Z` or
 * `2026-13-40T25:70:70Z` through as typed literals, which the store keeps
 * verbatim and which then make `YEAR()` and every date comparison unbound.
 */
export function isXsdDateTime(lexical: string): boolean {
  const m = XSD_DATE_TIME_RE.exec(lexical);
  if (!m) return false;
  return isValidCalendarDate(m[1], m[2], m[3]) && isValidTime(m[4], m[5], m[6], m[7]) && isValidZone(m[8]);
}

/** True when `lexical` is a valid xsd:date value (date-only), with the same calendar / zone checks. */
export function isXsdDate(lexical: string): boolean {
  const m = XSD_DATE_RE.exec(lexical);
  if (!m) return false;
  return isValidCalendarDate(m[1], m[2], m[3]) && isValidZone(m[4]);
}

/** True when a dateTime lexical carries the explicit UTC offset OKF requires (§5). */
export function hasExplicitOffset(lexical: string): boolean {
  return EXPLICIT_OFFSET_RE.test(lexical);
}

/**
 * The instant (milliseconds since the epoch) a valid xsd:dateTime or xsd:date
 * lexical names, or `null` for any other text. A value without an explicit
 * offset is read as UTC, so nothing depends on the machine's time zone, and a
 * date names its midnight, in its own zone when it carries one
 * (`2026-06-15+02:00` is 2026-06-14T22:00:00Z), which `Date.parse` alone
 * cannot read.
 */
export function instantOf(lexical: string): number | null {
  let iso: string | null = null;
  if (isXsdDateTime(lexical)) {
    iso = hasExplicitOffset(lexical) ? lexical : `${lexical}Z`;
  } else {
    const m = isXsdDate(lexical) ? XSD_DATE_RE.exec(lexical) : null;
    if (m) iso = `${m[1]}-${m[2]}-${m[3]}T00:00:00${m[4] ?? 'Z'}`;
  }
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}
