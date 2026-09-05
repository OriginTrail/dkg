#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkMochaReport(report) {
  const stats = report.stats;
  if (!stats || !['tests', 'passes', 'pending', 'failures'].every((key) => Number.isInteger(stats[key]) && stats[key] >= 0)) throw new Error('Mocha report has no complete test inventory');
  if (!Array.isArray(report.tests) || report.tests.length !== stats.tests
    || !Array.isArray(report.passes) || report.passes.length !== stats.passes
    || !Array.isArray(report.pending) || report.pending.length !== stats.pending
    || !Array.isArray(report.failures) || report.failures.length !== stats.failures
    || stats.passes + stats.pending + stats.failures !== stats.tests) {
    throw new Error('Mocha report has inconsistent outcome totals');
  }
  if (stats.failures !== 0) throw new Error('Mocha report contains failures');
  if (stats.passes <= 0) throw new Error('Mocha report has no verified passing tests');
  return { cases: report.stats.tests, passed: report.stats.passes, pending: report.stats.pending, durationMs: report.stats.duration };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  console.log(checkMochaReport(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))));
}
