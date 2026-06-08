import { describe, it, expect } from 'vitest';
import { parseRdfInt } from '../src/daemon/metrics-queries.js';

// Guards the shared COUNT parser the daemon's metric getters depend on. The
// getters themselves are intentionally uncached (metricsSource is consumed only
// by the 30s MetricsCollector tick, so each snapshot re-reads the store fresh).
describe('parseRdfInt', () => {
  it('parses RDF typed-integer literals and bare numbers, defaulting to 0', () => {
    expect(parseRdfInt('"1000"^^<http://www.w3.org/2001/XMLSchema#integer>')).toBe(1000);
    expect(parseRdfInt('42')).toBe(42);
    expect(parseRdfInt(undefined)).toBe(0);
    expect(parseRdfInt('not-a-number')).toBe(0);
  });
});
