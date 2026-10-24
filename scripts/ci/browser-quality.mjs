#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function summarizeBrowserQuality(report) {
  const summary = { cases: 0, firstAttemptFailed: 0, recoveredOnRetry: 0, failed: 0, skipped: 0, retries: 0, firstAttemptFailures: [] };
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        summary.cases++;
        const results = test.results ?? [];
        if (!results.length) throw new Error(`browser test has no attempt results: ${spec.title}`);
        const expected = test.expectedStatus ?? 'passed';
        const unexpected = (status) => status !== 'skipped' && status !== expected;
        const firstFailed = unexpected(results[0].status);
        if (firstFailed) {
          summary.firstAttemptFailed++;
          summary.firstAttemptFailures.push({ file: spec.file, title: spec.title, ...(spec.id ? { id: spec.id } : {}), ...(test.projectName ? { project: test.projectName } : {}), status: results[0].status });
        }
        const last = results.at(-1).status;
        if (firstFailed && last === expected) summary.recoveredOnRetry++;
        if (unexpected(last)) summary.failed++;
        if (last === 'skipped') summary.skipped++;
        summary.retries += Math.max(0, results.length - 1);
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  visit(report);
  if (summary.cases === 0) throw new Error('browser report has no test cases');
  return summary;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const summary = summarizeBrowserQuality(report);
  fs.writeFileSync(process.argv[3] ?? 'browser-quality.json', JSON.stringify(summary, null, 2) + '\n');
  console.log(`Browser quality: ${summary.firstAttemptFailed}/${summary.cases} first attempts failed; ${summary.recoveredOnRetry} recovered on retry; ${summary.failed} final failures; ${summary.skipped} skipped.`);
}
