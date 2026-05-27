import { describe, expect, it } from 'vitest';
import { compareNotificationByTsDesc, formatNotificationTimestamp } from '../src/ui/lib/formatTimestamp.js';

const NOW = new Date('2026-05-26T14:00:00Z');

describe('formatNotificationTimestamp (BUG-003)', () => {
  it('returns empty string for missing timestamps so the UI doesn\'t render "Invalid Date"', () => {
    expect(formatNotificationTimestamp(undefined, NOW)).toBe('');
    expect(formatNotificationTimestamp('', NOW)).toBe('');
    expect(formatNotificationTimestamp('not-a-date', NOW)).toBe('');
    expect(formatNotificationTimestamp(NaN as unknown as number, NOW)).toBe('');
  });

  it('shows only time (no date) for same-day events to keep the dropdown compact', () => {
    const sameDay = new Date('2026-05-26T13:55:00Z');
    const out = formatNotificationTimestamp(sameDay, NOW);
    expect(out).not.toMatch(/May|Yesterday|Mon|Tue|Wed|Thu|Fri|Sat|Sun/i);
    expect(out).toMatch(/\d/);
  });

  it('annotates yesterday explicitly so close-but-not-same-day is unambiguous', () => {
    const yesterday = new Date(NOW);
    yesterday.setDate(NOW.getDate() - 1);
    yesterday.setHours(22, 30, 0, 0);
    expect(formatNotificationTimestamp(yesterday, NOW)).toMatch(/^Yesterday\s/);
  });

  it('shows a weekday short name for events earlier in the same week', () => {
    const earlier = new Date(NOW);
    earlier.setDate(NOW.getDate() - 4);
    earlier.setHours(10, 0, 0, 0);
    const out = formatNotificationTimestamp(earlier, NOW);
    expect(out).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/);
  });

  it('shows full date for older events so a 2-month-old notification is NOT visually fresh (BUG-003 reproducer)', () => {
    const old = new Date(NOW);
    old.setMonth(NOW.getMonth() - 2);
    const out = formatNotificationTimestamp(old, NOW);
    expect(out).toMatch(/^[A-Z][a-z]{2}/);
    expect(out).toMatch(/202\d/);
  });
});

describe('compareNotificationByTsDesc (BUG-019)', () => {
  it('sorts numeric epoch timestamps newest-first (the production shape)', () => {
    // Reproducer for the regression we just fixed: the previous
    // comparator did `Date.parse(String(<epoch>))` which always
    // returned NaN for numeric timestamps, leaving the dropdown in
    // arbitrary insertion order.
    const items = [
      { id: 'a', ts: 1_716_700_000_000 },
      { id: 'b', ts: 1_716_900_000_000 },
      { id: 'c', ts: 1_716_800_000_000 },
    ];
    const sorted = [...items].sort(compareNotificationByTsDesc);
    expect(sorted.map((n) => n.id)).toEqual(['b', 'c', 'a']);
  });

  it('handles missing / non-finite timestamps without poisoning the comparator (returns 0 for them)', () => {
    const items = [
      { id: 'has-ts', ts: 2000 },
      { id: 'no-ts' },
      { id: 'nan-ts', ts: Number.NaN },
      { id: 'null-ts', ts: null as unknown as number },
    ];
    const sorted = [...items].sort(compareNotificationByTsDesc);
    expect(sorted[0].id).toBe('has-ts');
  });

  it('preserves insertion order for equal timestamps (stable-comparator contract)', () => {
    const items = [
      { id: 'first', ts: 1000 },
      { id: 'second', ts: 1000 },
      { id: 'third', ts: 1000 },
    ];
    const sorted = [...items].sort(compareNotificationByTsDesc);
    expect(sorted.map((n) => n.id)).toEqual(['first', 'second', 'third']);
  });
});
