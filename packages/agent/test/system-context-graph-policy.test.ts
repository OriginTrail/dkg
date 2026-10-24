import { describe, expect, it } from 'vitest';
import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import {
  automaticDurableSyncContextGraphs,
  resolveAutomaticSystemContextGraphSync,
  systemContextGraphSyncOptionsOf,
} from '../src/sync/system-context-graph-policy.js';

describe('automatic system Context Graph sync policy', () => {
  it('defaults automatic system graph replay on for Core and off for Edge', () => {
    expect(resolveAutomaticSystemContextGraphSync({ nodeRole: 'core' })).toBe(true);
    expect(resolveAutomaticSystemContextGraphSync({ nodeRole: 'edge' })).toBe(false);
    expect(resolveAutomaticSystemContextGraphSync({})).toBe(false);
  });

  it('allows an explicit config override for either role', () => {
    expect(resolveAutomaticSystemContextGraphSync({
      nodeRole: 'core',
      configValue: false,
    })).toBe(false);
    expect(resolveAutomaticSystemContextGraphSync({
      nodeRole: 'edge',
      configValue: true,
    })).toBe(true);
  });

  it('gives a recognized environment override precedence over config', () => {
    expect(resolveAutomaticSystemContextGraphSync({
      nodeRole: 'edge',
      configValue: false,
      envValue: '1',
    })).toBe(true);
    expect(resolveAutomaticSystemContextGraphSync({
      nodeRole: 'core',
      configValue: true,
      envValue: '0',
    })).toBe(false);
    expect(resolveAutomaticSystemContextGraphSync({
      nodeRole: 'edge',
      configValue: true,
      envValue: 'not-a-boolean',
    })).toBe(true);
  });

  it('keeps an Edge automatic durable scope limited to selected graphs', () => {
    expect(automaticDurableSyncContextGraphs(['selected-cg', 'selected-cg'], {
      nodeRole: 'edge',
    })).toEqual(['selected-cg']);
  });

  it('retains system graphs in the Core automatic durable scope', () => {
    expect(automaticDurableSyncContextGraphs([
      SYSTEM_CONTEXT_GRAPHS.AGENTS,
      'selected-cg',
    ], {
      nodeRole: 'core',
    })).toEqual([
      SYSTEM_CONTEXT_GRAPHS.AGENTS,
      SYSTEM_CONTEXT_GRAPHS.ONTOLOGY,
      'selected-cg',
    ]);
  });

  it('maps a node config and the environment onto the policy options', () => {
    expect(systemContextGraphSyncOptionsOf(
      { nodeRole: 'edge', syncSystemContextGraphsOnConnect: false },
      { DKG_SYNC_SYSTEM_CONTEXT_GRAPHS_ON_CONNECT: '1' },
    )).toEqual({ nodeRole: 'edge', configValue: false, envValue: '1' });
    expect(systemContextGraphSyncOptionsOf({ nodeRole: 'core' }, {})).toEqual({
      nodeRole: 'core',
      configValue: undefined,
      envValue: undefined,
    });
  });

  it('reads the process environment at call time by default', () => {
    const previous = process.env.DKG_SYNC_SYSTEM_CONTEXT_GRAPHS_ON_CONNECT;
    try {
      process.env.DKG_SYNC_SYSTEM_CONTEXT_GRAPHS_ON_CONNECT = '1';
      expect(resolveAutomaticSystemContextGraphSync(
        systemContextGraphSyncOptionsOf({ nodeRole: 'edge' }),
      )).toBe(true);
      process.env.DKG_SYNC_SYSTEM_CONTEXT_GRAPHS_ON_CONNECT = '0';
      expect(resolveAutomaticSystemContextGraphSync(
        systemContextGraphSyncOptionsOf({ nodeRole: 'core' }),
      )).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.DKG_SYNC_SYSTEM_CONTEXT_GRAPHS_ON_CONNECT;
      else process.env.DKG_SYNC_SYSTEM_CONTEXT_GRAPHS_ON_CONNECT = previous;
    }
  });
});
