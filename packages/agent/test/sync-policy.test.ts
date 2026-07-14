import { describe, expect, it } from 'vitest';
import {
  contextGraphPriority,
  countSyncPriorityClasses,
  normalizeSyncContextGraphPriorities,
  orderContextGraphIdsByPriority,
  syncPriorityClass,
  validateSyncResponderSnapshotLimitsConfig,
} from '../src/sync/policy.js';

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
