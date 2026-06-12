/**
 * Liveness/regression test for GH #709 —
 * "EPCIS no-filter events query returns EPCISDocument container rows".
 * https://github.com/OriginTrail/dkg/issues/709
 *
 * `buildEpcisQuery` matches every RDF type under the EPCIS namespace via
 * `FILTER(STRSTARTS(STR(?eventType), "https://gs1.github.io/EPCIS/"))`. That
 * prefix also matches `https://gs1.github.io/EPCIS/EPCISDocument` — the
 * document container — so an unfiltered `/api/epcis/events` query returns the
 * container as if it were an event. (Confirmed live on rc.17: a no-filter query
 * returned `[ObjectEvent, EPCISDocument]`.) The fix should exclude container /
 * document classes from the event result set.
 *
 * This asserts the CORRECT (post-fix) behaviour, so it is RED while the bug is
 * live and GREEN once the builder excludes containers — then close #709. The
 * assertion is written to be agnostic to HOW the fix excludes the container so
 * it can't stay red after a valid fix (Codex review on PR #1129): it fails for
 * the buggy bare-prefix match and passes for either an explicit
 * `!= …/EPCISDocument` exclusion OR a narrowed allow-list of concrete event
 * classes.
 */
import { describe, expect, it } from 'vitest';
import { buildEpcisQuery } from '../src/query-builder.js';

// Opt-in gate: these repros assert post-fix behaviour, so they are RED while
// the bug is live. They are EXCLUDED from the default test lane (which must stay
// green / mergeable) and run only under `RUN_ISSUE_LIVENESS=1` (the dedicated
// issue-liveness CI lane). See package.json `test:issue-liveness`.
const LIVENESS_ENABLED = process.env.RUN_ISSUE_LIVENESS === '1';


const CG = 'epcis-709-cg';

describe.runIf(LIVENESS_ENABLED)('GH #709 — EPCIS event-type filter excludes the document container', () => {
  it('CONTROL: a no-filter events query is generated and scopes ?eventType to the EPCIS namespace', () => {
    const sparql = buildEpcisQuery({}, CG);
    expect(sparql).toContain('?event a ?eventType');
    expect(sparql).toContain('https://gs1.github.io/EPCIS/');
  });

  it('a no-filter events query does not admit the EPCISDocument container as an event', () => {
    const sparql = buildEpcisQuery({}, CG);

    // The bug: `?eventType` is matched ONLY by the namespace prefix, which also
    // matches the `.../EPCISDocument` container class. A correct fix either
    // (a) explicitly excludes the container URI, or (b) narrows the type match
    // to concrete event classes — in BOTH cases the bare prefix-only match is
    // gone or guarded.
    const usesBarePrefixMatch =
      /STRSTARTS\(\s*STR\(\?eventType\)\s*,\s*"https:\/\/gs1\.github\.io\/EPCIS\/"\s*\)/.test(sparql);
    const guardsTheContainer = sparql.includes('EPCISDocument');

    // Correct iff the query is NOT "bare prefix match with no container guard".
    // Today it IS exactly that → this is RED until #709 is fixed.
    expect(usesBarePrefixMatch && !guardsTheContainer).toBe(false);
  });
});
