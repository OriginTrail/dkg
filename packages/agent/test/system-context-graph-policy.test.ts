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

  // `ontology` is deliberately NOT asserted here, and the omission is the point.
  // Its changelog disposition is an OPEN question owned by the ontology plane.
  // Pinning either value would convert that question into a contract: asserting
  // `false` today would read as clearance it never received, and a later
  // decision to exclude it would then surface as a regression rather than as
  // the decision it is. The policy records it as `undecided-rides-changelog-lane`,
  // which is a state, not a permission.
  //
  // EXHAUSTIVENESS IS NOT TESTED HERE BECAUSE IT IS ENFORCED EARLIER. The
  // disposition table is `satisfies Record<SystemContextGraphId, ...>`, so a new
  // member of SYSTEM_CONTEXT_GRAPHS fails the BUILD, not a test. That was
  // verified by counterfactual rather than assumed: adding a third member made
  // `tsc` reject the table with TS1360 until it was given a disposition. A
  // runtime mirror would need a new export whose only consumer is this file,
  // and would fire strictly later than the compile error it duplicates.
});
