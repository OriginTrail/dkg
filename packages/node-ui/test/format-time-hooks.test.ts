import { describe, expect, it } from 'vitest';
import { formatTime } from '../src/ui/hooks.js';

const NOW = new Date('2026-05-26T14:00:00Z');

describe('formatTime (BUG-003 — Operations table column)', () => {
  it('returns em-dash for nullish input (matches historical contract)', () => {
    expect(formatTime(undefined, NOW)).toBe('—');
    expect(formatTime(null, NOW)).toBe('—');
    expect(formatTime('', NOW)).toBe('—');
  });

  it('returns em-dash for unparseable timestamps so the column never breaks layout', () => {
    expect(formatTime('not-a-date', NOW)).toBe('—');
  });

  it('shows H:MM:SS for same-day events (preserves the dense form Operations relied on)', () => {
    const sameDay = new Date('2026-05-26T13:55:30Z');
    const out = formatTime(sameDay, NOW);
    expect(out).toMatch(/\d{1,2}/);
    expect(out).not.toContain('Yesterday');
    expect(out).not.toMatch(/Mar|May/);
  });

  it('annotates yesterday so a sub-24h-but-not-same-day event is recognisable at a glance', () => {
    // Build "yesterday" relative to NOW in the local TZ — the helper
    // uses `toDateString()` which is local-TZ-aware, so a UTC literal
    // would flap depending on where CI runs.
    const yesterday = new Date(NOW);
    yesterday.setDate(NOW.getDate() - 1);
    yesterday.setHours(22, 30, 0, 0);
    expect(formatTime(yesterday, NOW)).toMatch(/^Yesterday\s/);
  });

  it('uses weekday for events earlier in the week', () => {
    const earlier = new Date(NOW);
    earlier.setDate(NOW.getDate() - 4);
    earlier.setHours(8, 0, 0, 0);
    expect(formatTime(earlier, NOW)).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/);
  });

  it('shows month/day for older events (older than 7d)', () => {
    const old = new Date(NOW);
    old.setMonth(NOW.getMonth() - 2);
    // Locale-robust: assert a month abbreviation is present, not that it
    // leads. `toLocaleDateString` is month-first in en-US ("Mar 26") but
    // day-first elsewhere ("26 Mar"); both convey month/day for an old event.
    expect(formatTime(old, NOW)).toMatch(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/);
  });

  it('type-checks every accepted input shape (number | string | Date)', () => {
    // Compile-time guard for the public signature widened in BUG-003.
    // If the parameter type ever drops `Date` again, this file will
    // fail `tsc` even before vitest sees it.
    const numeric: number = NOW.getTime();
    const stringy: string = NOW.toISOString();
    const date: Date = NOW;
    expect(formatTime(numeric, NOW)).toBeTypeOf('string');
    expect(formatTime(stringy, NOW)).toBeTypeOf('string');
    expect(formatTime(date, NOW)).toBeTypeOf('string');
  });
});
