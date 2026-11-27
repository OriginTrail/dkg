#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mergePackageCoverage } from '../lib/merge-package-coverage.mjs';
import { sourceFingerprint, validateReceipts } from '../lib/coverage-artifacts.mjs';
import { checkPackageCoverage } from './check-coverage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resultFile = path.join(root, 'coverage-results.json');
function readReceipts(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? readReceipts(file) : entry.name.endsWith('.coverage.json') ? [JSON.parse(fs.readFileSync(file, 'utf8'))] : [];
  });
}
try {
  fs.rmSync(resultFile, { force: true });
  const receipts = readReceipts(process.argv[2] ?? 'ci-test-results');
  const needs = JSON.parse(process.env.NEEDS_JSON ?? '{}');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const packages = validateReceipts(receipts, needs, { revision, fingerprint: (name) => sourceFingerprint(root, name) });
  const results = [];
  for (const name of packages) {
    mergePackageCoverage(root, name, receipts);
    results.push(checkPackageCoverage(name, { base: process.env.COVERAGE_BASE || undefined }));
  }
  fs.writeFileSync(resultFile, JSON.stringify({ revision, node: process.version, platform: process.platform, propertySeed: process.env.DKG_PROPERTY_SEED, propertyRuns: process.env.DKG_PROPERTY_RUNS, packages: results }, null, 2) + '\n');
  console.log(`Verified full-source coverage for ${packages.length} selected packages.`);
} catch (error) {
  console.error(`coverage merge: ${error.message}`);
  process.exitCode = 1;
}
