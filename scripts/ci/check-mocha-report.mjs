#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkMochaReport(report) {
  if (!Number.isInteger(report.stats?.tests) || report.stats.tests <= 0 || !Array.isArray(report.tests) || report.tests.length !== report.stats.tests) throw new Error('Mocha report has no complete test inventory');
  if (report.stats.failures !== 0 || !Array.isArray(report.failures) || report.failures.length !== 0) throw new Error('Mocha report contains failures');
  if (!(report.stats.passes > 0) || report.stats.passes !== report.passes?.length) throw new Error('Mocha report has no verified passing tests');
  return { cases: report.stats.tests, passed: report.stats.passes, pending: report.stats.pending, durationMs: report.stats.duration };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  console.log(checkMochaReport(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))));
}
