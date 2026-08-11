import { describe, expect, it } from 'vitest';
import { SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import {
  automaticDurableSyncContextGraphs,
  isSystemContextGraphExcludedFromChangelogLane,
  resolveAutomaticSystemContextGraphSync,
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
});

describe('changelog lane exclusion policy (#2052 D-13)', () => {
  it('keeps the agent registry off the changelog lane', () => {
    expect(isSystemContextGraphExcludedFromChangelogLane(SYSTEM_CONTEXT_GRAPHS.AGENTS)).toBe(true);
  });

  it('leaves ordinary Context Graphs on the changelog lane', () => {
    expect(isSystemContextGraphExcludedFromChangelogLane('public-cg')).toBe(false);
    expect(isSystemContextGraphExcludedFromChangelogLane('')).toBe(false);
  });

  it('does not divert ontology today, which is the absence of a decision', () => {
    // Pins CURRENT ROUTING BEHAVIOUR, not clearance: a later decision to exclude
    // ontology updates this assertion as part of that decision. Load-bearing —
    // without it, `disposition !== undefined` marks every row of the table
    // excluded and still passes every other test here.
    expect(isSystemContextGraphExcludedFromChangelogLane(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY)).toBe(false);
  });

  // Exhaustiveness is enforced at BUILD time rather than here: the disposition
  // table is `satisfies Record<SystemContextGraphId, ...>`, so a new system graph
  // fails `tsc` with TS1360 until it is given a disposition.
});
