import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { summarizeComprehensive } from './comprehensive-result.mjs';
const [file, start, end, branch, commit, partial, interrupted, phase, filters] = process.argv.slice(2);
const input = readFileSync(0, 'utf8').trim();
const suites = input ? input.split('\n').map(line => {
  const [id, group, result, elapsed, log, command] = line.split('\t');
  return { id, group, result, elapsedSeconds: Number(elapsed), log: log ?? '', command: command ?? '' };
}) : [];
const result = summarizeComprehensive(suites, { partial: partial === '1', interrupted: interrupted === '1' });
const report = {
  startedAt: new Date(Number(start) * 1000).toISOString(),
  endedAt: phase === 'plan' ? null : new Date(Number(end) * 1000).toISOString(),
  wallSeconds: Number(end) - Number(start), branch, commit,
  ...result, phase, filters: filters ? filters.split(',') : [], suites,
};
writeFileSync(`${file}.tmp`, JSON.stringify(report, null, 2) + '\n');
renameSync(`${file}.tmp`, file);
// Explicit adapter to legacy orchestrator exit semantics. Filtered exploratory
// runs may succeed for their selection, but never certify complete success.
process.exitCode = phase === 'plan' || result.selectionOutcome === 'PASS' ? 0 : 1;
