import { describe, it, expect } from 'vitest';
import {
  dateTimeLexical,
  isXsdDateTime,
  isXsdDate,
  hasExplicitOffset,
  actorKind,
  normalizeVerified,
  deriveTrustTier,
  conceptStatus,
  isKnownStatus,
  isStale,
  isAttestedComputationType,
} from '../src/index.js';

describe('dateTimeLexical (SPEC §5 timestamps)', () => {
  it('renders a YAML-parsed Date in XSD canonical form (Z, no .000)', () => {
    expect(dateTimeLexical(new Date('2026-06-30T14:00:00Z'))).toBe('2026-06-30T14:00:00Z');
    expect(dateTimeLexical(new Date('2026-05-28T22:44:47+00:00'))).toBe('2026-05-28T22:44:47Z');
  });
  it('keeps non-zero fractional seconds', () => {
    expect(dateTimeLexical(new Date('2026-06-30T14:00:00.250Z'))).toBe('2026-06-30T14:00:00.250Z');
  });
  it('folds an offset to UTC (same instant)', () => {
    expect(dateTimeLexical(new Date('2026-06-25T09:00:00+02:00'))).toBe('2026-06-25T07:00:00Z');
  });
  it('keeps a quoted string exactly as written and returns null for absent / invalid values', () => {
    expect(dateTimeLexical(' 2026-05-28T22:44:47+00:00 ')).toBe('2026-05-28T22:44:47+00:00');
    expect(dateTimeLexical(undefined)).toBeNull();
    expect(dateTimeLexical(null)).toBeNull();
    expect(dateTimeLexical(new Date('garbage'))).toBeNull();
    expect(dateTimeLexical({ nested: true })).toBeNull();
    expect(dateTimeLexical(42)).toBe('42');
  });
});

describe('lexical checks', () => {
  it('recognises xsd:dateTime / xsd:date and explicit offsets', () => {
    expect(isXsdDateTime('2026-06-30T14:00:00Z')).toBe(true);
    expect(isXsdDateTime('2026-06-30T14:00:00+02:00')).toBe(true);
    expect(isXsdDateTime('2026-06-30T14:00:00')).toBe(true); // XSD allows no zone…
    expect(hasExplicitOffset('2026-06-30T14:00:00')).toBe(false); // …OKF wants one
    expect(hasExplicitOffset('2026-06-30T14:00:00Z')).toBe(true);
    expect(isXsdDateTime('2026-06-30')).toBe(false);
    expect(isXsdDate('2026-06-30')).toBe(true);
    expect(isXsdDate('2026-06-30T14:00:00Z')).toBe(false);
    expect(isXsdDateTime('next tuesday')).toBe(false);
  });
  it('rejects impossible calendar dates, times and zones, not just bad shapes', () => {
    expect(isXsdDateTime('2026-02-30T00:00:00Z')).toBe(false);
    expect(isXsdDateTime('2026-13-40T25:70:70Z')).toBe(false);
    expect(isXsdDateTime('2023-02-29T00:00:00Z')).toBe(false); // not a leap year
    expect(isXsdDateTime('2024-02-29T00:00:00Z')).toBe(true); // leap year
    expect(isXsdDateTime('2000-02-29T00:00:00Z')).toBe(true); // divisible by 400
    expect(isXsdDateTime('1900-02-29T00:00:00Z')).toBe(false); // divisible by 100 only
    expect(isXsdDateTime('2026-04-31T00:00:00Z')).toBe(false);
    expect(isXsdDateTime('2026-01-01T24:00:00Z')).toBe(true); // XSD end-of-day instant
    expect(isXsdDateTime('2026-01-01T24:00:00.000Z')).toBe(true);
    expect(isXsdDateTime('2026-01-01T24:00:01Z')).toBe(false);
    expect(isXsdDateTime('2026-01-01T23:60:00Z')).toBe(false);
    expect(isXsdDateTime('2026-01-01T23:59:60Z')).toBe(false);
    expect(isXsdDateTime('2026-01-01T00:00:00+14:00')).toBe(true);
    expect(isXsdDateTime('2026-01-01T00:00:00-14:00')).toBe(true);
    expect(isXsdDateTime('2026-01-01T00:00:00+14:30')).toBe(false);
    expect(isXsdDateTime('2026-01-01T00:00:00+15:00')).toBe(false);
    expect(isXsdDateTime('2026-01-01T00:00:00+05:60')).toBe(false);
    expect(isXsdDate('2026-02-30')).toBe(false);
    expect(isXsdDate('2026-00-10')).toBe(false);
    expect(isXsdDate('2024-02-29')).toBe(true);
    expect(isXsdDate('2026-06-30+14:30')).toBe(false);
  });
});

describe('actor convention (§7)', () => {
  it('classifies human:, process: and agent actors', () => {
    expect(actorKind('human:jsmith@acme')).toBe('human');
    expect(actorKind('process:finance-nightly')).toBe('process');
    expect(actorKind('reference_agent/gemini-2.5-pro')).toBe('agent');
    expect(actorKind('team:finance-fpa')).toBe('agent');
  });
});

describe('normalizeVerified (§5.2)', () => {
  it('treats a bare { by, at } mapping as a one-element list', () => {
    const events = normalizeVerified({ by: 'human:ahormati', at: '2026-06-25T09:00:00Z' });
    expect(events).toEqual([{ by: 'human:ahormati', at: '2026-06-25T09:00:00Z', extra: {} }]);
  });
  it('keeps every well-formed list entry, with extras preserved', () => {
    const events = normalizeVerified([
      { by: 'human:a', at: new Date('2026-06-25T09:00:00Z'), note: 'sign-off' },
      { by: 'process:nightly', at: '2026-06-26T02:00:00Z' },
    ]);
    expect(events.map((e) => e.by)).toEqual(['human:a', 'process:nightly']);
    expect(events[0].at).toBe('2026-06-25T09:00:00Z');
    expect(events[0].extra).toEqual({ note: 'sign-off' });
  });
  it('drops entries that cannot name a verifier and ignores scalars', () => {
    expect(normalizeVerified([{ at: '2026-06-25T09:00:00Z' }, 'nope', { by: '' }])).toEqual([]);
    expect(normalizeVerified(true)).toEqual([]);
    expect(normalizeVerified(undefined)).toEqual([]);
  });
});

describe('deriveTrustTier (§5.3)', () => {
  it('no verifier ⇒ unverified', () => {
    expect(deriveTrustTier(undefined)).toBe('unverified');
    expect(deriveTrustTier([])).toBe('unverified');
    expect(deriveTrustTier([{ at: '2026-06-25T09:00:00Z' }])).toBe('unverified');
  });
  it('non-human verifiers only ⇒ machine-confirmed', () => {
    expect(deriveTrustTier({ by: 'process:finance-nightly', at: '2026-06-26T02:00:00Z' })).toBe('machine-confirmed');
    expect(deriveTrustTier([{ by: 'reference_agent/gemini-2.5-pro' }])).toBe('machine-confirmed');
  });
  it('any human verifier ⇒ human-reviewed', () => {
    expect(deriveTrustTier([{ by: 'process:nightly' }, { by: 'human:ahormati' }])).toBe('human-reviewed');
  });
});

describe('lifecycle (§5.4, §5.5)', () => {
  it('status defaults to stable and tolerates unknown values', () => {
    expect(conceptStatus({})).toBe('stable');
    expect(conceptStatus({ status: 'deprecated' })).toBe('deprecated');
    expect(conceptStatus({ status: ' retired ' })).toBe('retired');
    expect(isKnownStatus('draft')).toBe(true);
    expect(isKnownStatus('retired')).toBe(false);
  });
  it('isStale is a plain instant comparison', () => {
    const staleAfter = '2026-12-31T00:00:00Z';
    expect(isStale(staleAfter, new Date('2026-12-30T23:59:59Z'))).toBe(false);
    expect(isStale(staleAfter, new Date('2026-12-31T00:00:00Z'))).toBe(true);
    expect(isStale(new Date(staleAfter), new Date('2027-01-01T00:00:00Z'))).toBe(true);
    expect(isStale(undefined, new Date('2099-01-01T00:00:00Z'))).toBe(false);
    expect(isStale('not a date', new Date('2099-01-01T00:00:00Z'))).toBe(false);
    // an impossible date is never stale — Date.parse would roll Feb 30 over to March
    expect(isStale('2026-02-30T00:00:00Z', new Date('2099-01-01T00:00:00Z'))).toBe(false);
    expect(isStale('2026-02-28', new Date('2099-01-01T00:00:00Z'))).toBe(true);
  });
});

describe('isAttestedComputationType (§10)', () => {
  it('matches the spec spelling and its PascalCased rdf:type form', () => {
    expect(isAttestedComputationType('Attested Computation')).toBe(true);
    expect(isAttestedComputationType('AttestedComputation')).toBe(true);
    expect(isAttestedComputationType('Metric')).toBe(false);
    expect(isAttestedComputationType(undefined)).toBe(false);
  });
});
