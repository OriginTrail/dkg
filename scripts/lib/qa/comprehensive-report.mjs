import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { summarizeComprehensive } from './comprehensive-result.mjs';
import { basename, dirname, join } from 'node:path';
const [file, start, end, branch, commit, partial, interrupted, phase, filters] = process.argv.slice(2);
const input = readFileSync(0, 'utf8').trim();
const suites = input ? input.split('\n').map(line => {
  const [id, group, result, elapsed, log, command] = line.split('\t');
  return { id, group, result, elapsedSeconds: Number(elapsed), log: log ?? '', command: command ?? '' };
}) : [];
const result = summarizeComprehensive(suites, { partial: partial === '1', interrupted: interrupted === '1' });
const report = {
  startedAt: new Date(Number(start) * 1000).toISOString(),
  endedAt: phase === 'complete' ? new Date(Number(end) * 1000).toISOString() : null,
  wallSeconds: Number(end) - Number(start), branch, commit,
  ...result, phase, filters: filters ? filters.split(',') : [], suites,
};
writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 2) + '\n');
renameSync(`${file}.tmp`, file);
if (phase === 'complete') {
  const lines = ['# Comprehensive devnet test report', '',
    `- **Started**: ${report.startedAt}`, `- **Ended**: ${report.endedAt}`,
    `- **Wall**: ${report.wallSeconds}s`, `- **Branch**: ${branch} @ ${commit}`,
    `- **Outcome**: ${result.outcome}`, `- **Selection outcome**: ${result.selectionOutcome}`,
    `- **Partial**: ${result.partial}`, `- **Interrupted**: ${result.interrupted}`,
    `- **Filters**: ${report.filters.join(', ') || '(none)'}`, '', '## Summary', '',
    '| | count |', '|---|---|',
    ...Object.entries(result.totals).map(([key, value]) => `| ${key.toUpperCase()} | ${value} |`),
    '', '## Suites', '', '| id | group | result | elapsed | log |', '|---|---|---|---:|---|',
    ...suites.map(s => `| \`${s.id}\` | ${s.group} | ${s.result} | ${s.elapsedSeconds}s | \`${basename(s.log)}\` |`), '',
  ];
  for (const suite of suites.filter(s => s.result.startsWith('FAIL:'))) {
    let tail;
    try { tail = readFileSync(suite.log, 'utf8').trimEnd().split('\n').slice(-25).join('\n'); }
    catch { tail = '(no log)'; }
    lines.push(`### ${suite.id}`, '', '```', tail, '```', '');
  }
  const markdown = join(dirname(file), 'REPORT.md');
  writeFileSync(`${markdown}.tmp`, lines.join('\n'));
  renameSync(`${markdown}.tmp`, markdown);
  console.log(`FINISHED — ${report.wallSeconds}s wall; outcome=${result.outcome}, selection=${result.selectionOutcome}`);
  console.log(Object.entries(result.totals).map(([key, value]) => `${key.toUpperCase()}=${value}`).join(' '));
}
// Explicit adapter to legacy orchestrator exit semantics. Filtered exploratory
// runs may succeed for their selection, but never certify complete success.
process.exitCode = phase === 'plan' || result.selectionOutcome === 'PASS' ? 0 : 1;
