/**
 * Unit coverage for the `isExternalBackend` helper that gates
 * backend-aware daemon behaviour (metrics, chain-reset-wipe, health
 * check). Plan: `.cursor/plans/blazegraph_v10_support_178da670.plan.md`
 * §PR 1 item 1.
 */
import { describe, it, expect } from 'vitest';
import { isExternalBackend } from '../src/triple-store.js';

describe('isExternalBackend', () => {
  it('returns true for blazegraph', () => {
    expect(isExternalBackend('blazegraph')).toBe(true);
  });

  it('returns true for sparql-http', () => {
    expect(isExternalBackend('sparql-http')).toBe(true);
  });

  it('returns false for the oxigraph family', () => {
    expect(isExternalBackend('oxigraph')).toBe(false);
    expect(isExternalBackend('oxigraph-persistent')).toBe(false);
  });

  it('returns false for unknown backends', () => {
    expect(isExternalBackend('neptune')).toBe(false);
    expect(isExternalBackend('graphdb')).toBe(false);
    expect(isExternalBackend('')).toBe(false);
  });

  it('returns false for null and undefined', () => {
    expect(isExternalBackend(undefined)).toBe(false);
    expect(isExternalBackend(null)).toBe(false);
  });
});
