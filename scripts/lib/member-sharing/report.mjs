// The report of the issue-3251 member-sharing suite
// (scripts/devnet-test-issue-3251-member-sharing.mjs): one line per check
// under its case, the known gaps applied to every result before it is
// reported (../qa/known-gaps.mjs), and the summary at the end.

import { classify, gapSummaries, xfailLine, xpassLine } from '../qa/known-gaps.mjs';
import { caseVerdicts, pairResult, subscriptionResults } from '../qa/member-sharing.mjs';

export function createReport(cases, { print = console.log } = {}) {
  const findings = Object.fromEntries(Object.keys(cases).map(id => [id, { pass: 0, fail: [], xfail: [], xpass: [] }]));
  const gapCounts = {};
  const countGap = (gap, kind) => {
    gapCounts[gap.issue] ??= { expected: 0, unexpected: 0 };
    gapCounts[gap.issue][kind] += 1;
  };

  const say = text => print(`[issue-3251] ${text}`);
  const note = text => print(`  [NOTE] ${text}`);
  const pass = (id, text) => { findings[id].pass += 1; print(`  [PASS] case ${id}: ${text}`); };
  const fail = (id, text) => { findings[id].fail.push(text); print(`  [FAIL] case ${id}: ${text}`); };

  /** A check's result under its case, with the known gaps applied. */
  function record(id, result) {
    const { verdict, text, gap } = classify(result);
    if (verdict === 'pass') return pass(id, text);
    if (verdict === 'fail') return fail(id, text);
    if (verdict === 'xfail') {
      findings[id].xfail.push(text);
      countGap(gap, 'expected');
      return print(xfailLine(id, text, gap));
    }
    if (verdict === 'xpass') {
      findings[id].pass += 1;
      findings[id].xpass.push(text);
      countGap(gap, 'unexpected');
      return print(xpassLine(id, text, gap));
    }
    return undefined; // a quiet pass: a precondition that held
  }

  /** One pair's result (a write, a node that must hold it), under its case. */
  const reportPair = (pair, { boundMs }) => record(pair.caseId, pairResult(pair, { boundMs }));

  /** An observed subscription: the definition under `caseId`, the synced flag under case 8. */
  function reportSubscription(caseId, { node, graph, observation }, deadlines) {
    const { definition, synced } = subscriptionResults(observation, { registered: graph.registered, private: graph.private, member: node.member === true, ...deadlines });
    for (const [id, result] of [[caseId, definition], [8, synced]]) record(id, { ...result, text: `${node.label}, ${graph.key}: ${result.text}` });
  }

  const anyFailed = () => Object.values(findings).some(f => f.fail.length > 0);

  /** The summary of the run; returns the cases that did not pass. */
  function summary(heading) {
    print('');
    say(heading);
    const { rows, failed } = caseVerdicts(cases, findings);
    for (const row of rows) {
      const known = [row.expected && `${row.expected} expected failure(s)`, row.unexpected && `${row.unexpected} known-gap check(s) held`].filter(Boolean);
      print(`  case ${row.id} ${row.verdict.padEnd(7)} ${row.title} (${row.held} held, ${row.failed} failed${known.length ? `, ${known.join(', ')}` : ''})`);
    }
    for (const line of gapSummaries(gapCounts)) say(line);
    const expected = rows.reduce((n, row) => n + row.expected, 0);
    say(failed.length ? `NOT PASSED: case(s) ${failed.join(', ')}` : expected ? 'every case passed, apart from the expected failures of known gaps' : 'every case passed');
    return failed;
  }

  return { say, note, pass, fail, record, reportPair, reportSubscription, anyFailed, summary };
}
