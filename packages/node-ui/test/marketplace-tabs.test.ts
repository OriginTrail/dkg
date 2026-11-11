// @vitest-environment happy-dom
// The marketplace section's flag: `?marketplace` turns it on once, as the app
// starts; rendering and routing only read it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MARKETPLACE_FLAG_KEY, activateMarketplaceFromUrl, marketplaceEnabled } from '../src/ui/marketplace/tabs.js';

describe('marketplace activation', () => {
  afterEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('turns the section on from ?marketplace, and keeps it on for a later page without the query', () => {
    expect(marketplaceEnabled()).toBe(false);
    activateMarketplaceFromUrl('?marketplace');
    expect(marketplaceEnabled()).toBe(true);
    // The next start-up, a reload without the query, leaves it on.
    activateMarketplaceFromUrl('');
    expect(marketplaceEnabled()).toBe(true);
  });

  it('reads the flag without writing it, whatever the address says', () => {
    window.history.replaceState({}, '', '/ui/marketplace/plans?marketplace');
    expect(marketplaceEnabled()).toBe(false);
    expect(localStorage.getItem(MARKETPLACE_FLAG_KEY)).toBeNull();
  });

  it('is turned on by the app once, as it starts, before anything renders', () => {
    const main = readFileSync(resolve(__dirname, '../src/ui/main.tsx'), 'utf8');
    const start = main.indexOf('activateMarketplaceFromUrl();');
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(main.indexOf('createRoot('));
  });
});
