import { describe, expect, it } from 'vitest';
import { formatNotificationTimestamp } from '../src/ui/lib/formatTimestamp.js';

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
    // Locale-robust: the older-date form must surface a month abbreviation
    // AND the year somewhere — not a specific token order. `toLocaleString`
    // renders month-first in en-US ("Mar 26, 2026, …") but day-first in many
    // locales ("26 Mar 2026, …"); both are correct and both must pass. The
    // intent is only that an old notification reads as dated, not fresh.
    expect(out).toMatch(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
    expect(out).toMatch(/202\d/);
  });
});
