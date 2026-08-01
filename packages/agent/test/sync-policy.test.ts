import { describe, expect, it } from 'vitest';
import {
  SYNC_ADMISSION_SOURCES,
  contextGraphPriority,
  countSyncPriorityClasses,
  normalizeSyncAdmissionSource,
  normalizeSyncContextGraphPriorities,
  orderContextGraphIdsByPriority,
  syncPriorityClass,
  validateSyncResponderSnapshotLimitsConfig,
} from '../src/sync/policy.js';
import { classifySyncPeerProvenance } from '../src/dkg-agent-lifecycle.js';

describe('sync Context Graph policy', () => {
  it('normalizes safe integer priorities and preserves stable input order for ties', () => {
    const priorities = normalizeSyncContextGraphPriorities({ high: 10, low: -4, tied: 10 });
    expect(orderContextGraphIdsByPriority(
      ['default-a', 'low', 'high', 'default-b', 'tied', 'high'],
      priorities,
    )).toEqual(['high', 'tied', 'default-a', 'default-b', 'low']);
    expect(contextGraphPriority(priorities, 'unknown')).toBe(0);
    expect(Object.isFrozen(priorities)).toBe(true);
  });

  it('allows preconfigured unknown IDs but rejects empty IDs and unsafe priorities', () => {
    expect(normalizeSyncContextGraphPriorities({ 'future-graph': -1 })).toEqual({ 'future-graph': -1 });
    expect(() => normalizeSyncContextGraphPriorities({ '': 1 })).toThrow(/syncContextGraphPriorities/);
    expect(() => normalizeSyncContextGraphPriorities({ graph: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow(/syncContextGraphPriorities\.graph/);
  });

  it('uses bounded priority classes and counts configured entries only', () => {
    expect(syncPriorityClass(9)).toBe('elevated');
    expect(syncPriorityClass(0)).toBe('default');
    expect(syncPriorityClass(-9)).toBe('deprioritized');
    expect(countSyncPriorityClasses({ a: 1, b: 0, c: -1, d: 2 })).toEqual({
      elevated: 2,
      default: 1,
      deprioritized: 1,
    });
  });
});

describe('sync responder snapshot config validation', () => {
  it('accepts positive safe integer leaves', () => {
    expect(() => validateSyncResponderSnapshotLimitsConfig({
      global: { rows: 10, bytesEstimate: 20 },
      local: { rows: 5, bytesEstimate: 10 },
    })).not.toThrow();
  });

  it.each([
    ['global.rows', { global: { rows: 0 } }],
    ['global.bytesEstimate', { global: { bytesEstimate: 1.5 } }],
    ['local.rows', { local: { rows: -1 } }],
    ['local.bytesEstimate', { local: { bytesEstimate: Number.MAX_SAFE_INTEGER + 1 } }],
  ])('reports the exact invalid leaf path %s', (path, config) => {
    expect(() => validateSyncResponderSnapshotLimitsConfig(config))
      .toThrow(`syncResponderSnapshotLimits.${path}`);
  });
});

describe('normalizeSyncAdmissionSource', () => {
  it('passes through every declared admission origin', () => {
    for (const source of SYNC_ADMISSION_SOURCES) {
      expect(normalizeSyncAdmissionSource(source)).toBe(source);
    }
  });

  it('clamps unknown, absent, and identifier-bearing origins to `unspecified`', () => {
    // These values become metric and log dimensions on the node-wide
    // `sync-global` scheduler, so the label space is a contract: an unbounded
    // or identifier-bearing origin would re-open the correlation-identifier
    // leak that collapsing the operation label was added to close, and would
    // multiply the diagnostic cardinality.
    expect(normalizeSyncAdmissionSource(undefined)).toBe('unspecified');
    expect(normalizeSyncAdmissionSource('')).toBe('unspecified');
    expect(normalizeSyncAdmissionSource('Catchup-Foreground')).toBe('unspecified');
    expect(normalizeSyncAdmissionSource('durable:urn:cg:private:abc')).toBe('unspecified');
    expect(normalizeSyncAdmissionSource('__proto__')).toBe('unspecified');
    expect(normalizeSyncAdmissionSource('toString')).toBe('unspecified');
  });

  it('keeps the declared origin set small and free of punctuation', () => {
    expect(new Set(SYNC_ADMISSION_SOURCES).size).toBe(SYNC_ADMISSION_SOURCES.length);
    expect(SYNC_ADMISSION_SOURCES.length).toBeLessThanOrEqual(12);
    for (const source of SYNC_ADMISSION_SOURCES) {
      expect(source).toMatch(/^[a-z][a-z-]*$/);
    }
  });
});

describe('classifySyncPeerProvenance', () => {
  const HINT = '12D3KooWBootstrapHint';
  const CURATOR = '12D3KooWMetadataCurator';

  it('marks a metadata-resolved curator as authoritative', () => {
    expect(classifySyncPeerProvenance(undefined, CURATOR))
      .toEqual({ peerId: CURATOR, provenance: 'metadata' });
    expect(classifySyncPeerProvenance(HINT, CURATOR))
      .toEqual({ peerId: CURATOR, provenance: 'metadata' });
  });

  it('marks an echoed bootstrap hint as NOT authoritative', () => {
    // `resolveCuratorPeerId` echoes the join-approval hint when metadata
    // resolves no curator. That hint can be stale — peer ids are cryptographic
    // identities, so a curator that has rotated its libp2p key leaves an
    // ordinary member on the id the hint still names — so it may rank the walk
    // but must never let one peer stand for the whole graph.
    expect(classifySyncPeerProvenance(HINT, HINT))
      .toEqual({ peerId: HINT, provenance: 'bootstrap-hint' });
    expect(classifySyncPeerProvenance(HINT, undefined))
      .toEqual({ peerId: HINT, provenance: 'bootstrap-hint' });
  });

  it('reports no peer when neither source produced one', () => {
    expect(classifySyncPeerProvenance(undefined, undefined))
      .toEqual({ provenance: 'none' });
  });

  it('keeps ranking availability identical to authority eligibility only for metadata', () => {
    // The ranking caller takes `.peerId` regardless of provenance; the
    // early-stop caller takes it only for 'metadata'. Pin that they differ
    // exactly on the hint case.
    for (const [hint, curator] of [[HINT, HINT], [HINT, undefined]] as const) {
      const resolved = classifySyncPeerProvenance(hint, curator);
      expect(resolved.peerId).toBe(HINT);
      expect(resolved.provenance).not.toBe('metadata');
    }
  });
});
