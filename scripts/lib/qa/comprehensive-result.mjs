// Existing suite exit codes are opaque: any nonzero remains FAIL:<code>.
// In particular, exit 2 in a legacy suite is not translated to INCONCLUSIVE.
// SKIPPED is recorded by the orchestrator only for a suite registered with the
// "exit 3 = a precondition was unmet, nothing was exercised" convention. It is
// neither a pass nor a failure of the product: the run cannot certify what it
// did not exercise, so it is incomplete.
export function summarizeComprehensive(suites, { partial = false, interrupted = false } = {}) {
  const totals = { pass: 0, fail: 0, missing: 0, skipped: 0, unfinished: 0, executed: 0, registered: suites.length };
  for (const suite of suites) {
    if (suite.result === 'PASS') { totals.pass++; totals.executed++; }
    else if (/^FAIL:[0-9]+$/.test(suite.result)) { totals.fail++; totals.executed++; }
    else if (suite.result === 'MISSING') totals.missing++;
    else if (suite.result === 'SKIPPED') totals.skipped++;
    else totals.unfinished++;
  }
  const incomplete = interrupted || totals.registered === 0 || totals.executed === 0
    || totals.missing > 0 || totals.skipped > 0 || totals.unfinished > 0;
  const selectionOutcome = incomplete ? 'INCONCLUSIVE' : totals.fail > 0 ? 'FAIL' : 'PASS';
  const outcome = partial ? 'INCONCLUSIVE' : selectionOutcome;
  return { outcome, selectionOutcome, completeSuccess: outcome === 'PASS', partial, interrupted, totals };
}
