import { describe, expect, it } from 'vitest';
import { expiryDistance, formatExpiryShort, formatRelativeExpiry } from '../src/ui/components/Pca/format.js';

const NOW = 2_000_000_000;
const DAY = 86_400;

describe('expiry labels share one calculation', () => {
  it('future', () => {
    expect(expiryDistance(NOW + 221 * DAY, NOW)).toEqual({ past: false, days: 221 });
    expect(formatRelativeExpiry(NOW + 221 * DAY, NOW)).toBe('Expires in ~221 days');
    expect(formatExpiryShort(NOW + 221 * DAY, NOW)).toBe('~221 days');
    expect(formatExpiryShort(NOW + 1 * DAY, NOW)).toBe('~1 day');
  });

  it('today', () => {
    expect(formatRelativeExpiry(NOW, NOW)).toBe('Expired today');
    expect(formatExpiryShort(NOW - 3600, NOW)).toBe('Expired today');
  });

  it('past', () => {
    expect(formatRelativeExpiry(NOW - 3 * DAY, NOW)).toBe('Expired ~3 days ago');
    expect(formatExpiryShort(NOW - 3 * DAY, NOW)).toBe('Expired 3 days ago');
    expect(formatExpiryShort(NOW - 1 * DAY, NOW)).toBe('Expired 1 day ago');
  });

  it('unknown', () => {
    expect(expiryDistance(undefined, NOW)).toBeNull();
    expect(expiryDistance(0, NOW)).toBeNull();
    expect(formatRelativeExpiry(undefined, NOW)).toBe('Expiry unknown');
    expect(formatExpiryShort(0, NOW)).toBeNull();
  });
});
