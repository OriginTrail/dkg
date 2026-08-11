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
    // This pins CURRENT ROUTING BEHAVIOUR, not product clearance. Ontology's
    // disposition is `undecided-rides-changelog-lane`, and this asserts only what
    // that state does today: it does not divert. If the ontology plane later
    // DECIDES to exclude it, this assertion gets updated as part of that decision
    // — a failure here means "a decision was made", not "a regression happened".
    //
    // It is load-bearing rather than decorative, and that was measured: rewriting
    // the predicate as `disposition !== undefined` treats EVERY graph in the
    // exhaustive table as excluded — silently handing ontology to the legacy lane
    // — and passed all 35 tests in this file and the lifecycle suite before this
    // assertion existed.
    expect(isSystemContextGraphExcludedFromChangelogLane(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY)).toBe(false);
  });

  // A NOTE ON THE ONTOLOGY ASSERTION ABOVE, because an earlier revision of this
  // file deliberately omitted it and that was wrong. The reasoning for omitting
  // it was that pinning ontology would convert an open question into a contract.
  // The flaw: leaving it unasserted did not protect the open question, it just
  // left the only non-agent row in the table uncovered — and a predicate
  // rewritten as `disposition !== undefined` then passed every test here while
  // silently diverting ontology to the legacy lane. Measured, not hypothesised.
  // The resolution is wording, not omission: assert CURRENT ROUTING BEHAVIOUR
  // and say plainly that it is not clearance. The open question lives in the
  // policy's `undecided-rides-changelog-lane` state, which is where a state
  // belongs — a test asserting today's behaviour cannot close it.
  //
  // EXHAUSTIVENESS IS NOT TESTED HERE BECAUSE IT IS ENFORCED EARLIER. The
  // disposition table is `satisfies Record<SystemContextGraphId, ...>`, so a new
  // member of SYSTEM_CONTEXT_GRAPHS fails the BUILD, not a test. That was
  // verified by counterfactual rather than assumed: adding a third member made
  // `tsc` reject the table with TS1360 until it was given a disposition. A
  // runtime mirror would need a new export whose only consumer is this file,
  // and would fire strictly later than the compile error it duplicates.
});
