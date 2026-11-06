// @vitest-environment happy-dom
// The open Observability tab lives in the address, so a refresh or bookmark keeps it.
import { afterEach, describe, expect, it } from 'vitest';
import { tabFromSearch, writeTabToAddress } from '../src/ui/stores/observability.js';

describe('Observability tab in the address', () => {
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('reads the tab, and ignores anything unknown', () => {
    expect(tabFromSearch('?tab=network')).toBe('network');
    expect(tabFromSearch('')).toBe('operations');
    expect(tabFromSearch('?tab=nonsense')).toBe('operations');
  });

  it('writes a tab, and keeps the default out of the address', () => {
    writeTabToAddress('network');
    expect(window.location.search).toBe('?tab=network');
    writeTabToAddress('operations');
    expect(window.location.search).toBe('');
  });

  it('keeps other query values', () => {
    window.history.replaceState(null, '', '/?keep=1');
    writeTabToAddress('logs');
    expect(new URLSearchParams(window.location.search).get('keep')).toBe('1');
  });
});
