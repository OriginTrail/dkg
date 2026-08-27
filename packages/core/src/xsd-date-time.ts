// SPDX-License-Identifier: Apache-2.0

export interface XsdDateTimeCanonicalizationOptions {
  /** Require a lexical timezone, or treat an absent timezone as UTC. */
  readonly timezone: 'required' | 'optional-assume-utc';
  /** Assertion seals intentionally accept only Z and the positive zero offset. */
  readonly timezoneOffsets: 'any' | 'z-or-positive-zero';
  /** Consensus term canonicalization supports signed, arbitrarily wide years. */
  readonly year: 'four-digit' | 'extended';
  /** Make each caller's precision policy explicit. */
  readonly fractionalSeconds:
    | 'truncate-to-milliseconds'
    | 'at-most-milliseconds'
    | 'reject-nonzero-submillisecond';
  /** Hash terms use their shortest millisecond form; seals use fixed millis. */
  readonly fractionalOutput: 'trim' | 'milliseconds';
  /** Oxigraph's term-value policy admits a restricted hour-24 rollover. */
  readonly hour24: 'oxigraph-rollover' | 'reject';
  /** Extended XSD years and ECMAScript ISO instants use different spellings. */
  readonly yearOutput: 'xsd' | 'ecmascript-iso';
  /** Optional caller-specific value-space bound, applied after UTC rollover. */
  readonly normalizedValueAllowed?: (value: Readonly<{
    year: string;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  }>) => boolean;
}

/**
 * Parse, validate and normalize one xsd:dateTime lexical value to UTC.
 * Returns null rather than throwing so policy wrappers can preserve their own
 * fail-closed/verbatim error contracts.
 */
export function canonicalizeXsdDateTimeValue(
  value: string,
  options: Readonly<XsdDateTimeCanonicalizationOptions>,
): string | null {
  const match = /^(-?\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))?$/.exec(value);
  if (match === null) return null;
  const [
    , yearText, monthText, dayText, hourText, minuteText, secondText,
    fraction = '', timezone, offsetSign, offsetHourText, offsetMinuteText,
  ] = match;
  if (options.year === 'four-digit' && !/^\d{4}$/.test(yearText)) return null;
  if (options.timezone === 'required' && timezone === undefined) return null;
  if (
    options.timezoneOffsets === 'z-or-positive-zero'
    && timezone !== 'Z'
    && timezone !== '+00:00'
  ) return null;

  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = timezone === undefined || timezone === 'Z'
    ? 0
    : Number(offsetHourText);
  const offsetMinute = timezone === undefined || timezone === 'Z'
    ? 0
    : Number(offsetMinuteText);
  if (
    month < 1 || month > 12
    || day < 1 || day > xsdDaysInMonth(yearText, month)
    || minute > 59
    || second > 59
    || offsetHour > 14
    || offsetMinute > 59
    || (offsetHour === 14 && offsetMinute !== 0)
  ) return null;

  const millisecondDigits = fraction.padEnd(3, '0').slice(0, 3);
  const trimmedMilliseconds = millisecondDigits.replace(/0+$/, '');
  if (
    options.fractionalSeconds === 'at-most-milliseconds'
    && fraction.length > 3
  ) return null;
  if (
    options.fractionalSeconds === 'reject-nonzero-submillisecond'
    && /[1-9]/.test(fraction.slice(3))
  ) return null;

  let rollsToNextDay = false;
  if (options.hour24 === 'reject') {
    if (hour > 23) return null;
  } else {
    if (hour > 24) return null;
    if (hour === 24) {
      const normalizedSecondIsZero = second === 0 && trimmedMilliseconds === '';
      if (minute !== 0 && !normalizedSecondIsZero) return null;
      rollsToNextDay = true;
    }
  }

  let days = daysFromCivil(BigInt(yearText), BigInt(month), BigInt(day));
  if (rollsToNextDay) days += 1n;
  const localHour = rollsToNextDay ? 0 : hour;
  const signedOffsetMinutes = offsetSign === '-'
    ? -((offsetHour * 60) + offsetMinute)
    : (offsetHour * 60) + offsetMinute;
  const utcMinutes = (localHour * 60) + minute - signedOffsetMinutes;
  days += BigInt(Math.floor(utcMinutes / 1440));
  const minuteOfDay = ((utcMinutes % 1440) + 1440) % 1440;
  const normalized = civilFromDays(days);
  const normalizedHour = Math.floor(minuteOfDay / 60);
  const normalizedMinute = minuteOfDay % 60;
  const normalizedValue = {
    year: normalized.y.toString(),
    month: Number(normalized.m),
    day: Number(normalized.d),
    hour: normalizedHour,
    minute: normalizedMinute,
    second,
  };
  if (options.normalizedValueAllowed?.(normalizedValue) === false) return null;

  const outputYear = options.yearOutput === 'ecmascript-iso'
    ? formatEcmascriptIsoYear(normalized.y)
    : formatXsdYear(normalized.y);
  const outputFraction = options.fractionalOutput === 'milliseconds'
    ? `.${millisecondDigits}`
    : trimmedMilliseconds === '' ? '' : `.${trimmedMilliseconds}`;
  return `${outputYear}-${padXsdDateTimeComponent(normalizedValue.month)}`
    + `-${padXsdDateTimeComponent(normalizedValue.day)}`
    + `T${padXsdDateTimeComponent(normalizedHour)}`
    + `:${padXsdDateTimeComponent(normalizedMinute)}`
    + `:${secondText}${outputFraction}Z`;
}

/** Proleptic-Gregorian day count relative to 1970-01-01. */
export function daysFromCivil(y: bigint, m: bigint, d: bigint): bigint {
  const yy = m <= 2n ? y - 1n : y;
  const era = (yy >= 0n ? yy : yy - 399n) / 400n;
  const yoe = yy - era * 400n;
  const doy = (153n * (m + (m > 2n ? -3n : 9n)) + 2n) / 5n + d - 1n;
  const doe = yoe * 365n + yoe / 4n - yoe / 100n + doy;
  return era * 146097n + doe - 719468n;
}

/** Proleptic-Gregorian inverse of daysFromCivil. */
export function civilFromDays(zIn: bigint): { y: bigint; m: bigint; d: bigint } {
  const z = zIn + 719468n;
  const era = (z >= 0n ? z : z - 146096n) / 146097n;
  const doe = z - era * 146097n;
  const yoe = (doe - doe / 1460n + doe / 36524n - doe / 146096n) / 365n;
  const y = yoe + era * 400n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const d = doy - (153n * mp + 2n) / 5n + 1n;
  const m = mp < 10n ? mp + 3n : mp - 9n;
  return { y: m <= 2n ? y + 1n : y, m, d };
}

export function xsdDaysInMonth(yearText: string, month: number): number {
  if (month === 2) {
    const year = BigInt(yearText);
    return year % 4n === 0n && (year % 100n !== 0n || year % 400n === 0n) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function formatXsdYear(year: bigint): string {
  const negative = year < 0n;
  const absolute = (negative ? -year : year).toString().padStart(4, '0');
  return negative ? `-${absolute}` : absolute;
}

export function padXsdDateTimeComponent(value: number): string {
  return String(value).padStart(2, '0');
}

function formatEcmascriptIsoYear(year: bigint): string {
  if (year >= 0n && year <= 9999n) return year.toString().padStart(4, '0');
  const sign = year < 0n ? '-' : '+';
  const absolute = year < 0n ? -year : year;
  return `${sign}${absolute.toString().padStart(6, '0')}`;
}
