#!/usr/bin/env node
// Reuses the AST scanner proposed in OriginTrail/dkg#1769 (8bd5d905), with a
// checked-in debt ledger so push, merge queue and local checks also fail closed.
//
// An exception whose review deadline has passed fails by default. CI's lint
// step sets DKG_TEST_EXCEPTION_EXPIRY=warn: a lapsed deadline is the same on
// every branch, so failing there would fail every unrelated change at once
// (2026-11-09); the nightly gate fails on the expired count instead.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { auditTestFiles } from '../lib/disabled-test-git.mjs';

const expiryMode = process.env.DKG_TEST_EXCEPTION_EXPIRY ?? 'fail';
if (!['fail', 'warn'].includes(expiryMode)) throw new Error('DKG_TEST_EXCEPTION_EXPIRY must be fail or warn');
const warn = (file, line, message) => console.log(process.env.GITHUB_ACTIONS === 'true' ? `::warning file=${file},line=${line}::${message}` : `${file}:${line}: warning: ${message}`);
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter((file) => file && fs.existsSync(file));
const analysis = auditTestFiles([...new Set(files)]);
const findings = analysis.flatMap(({ disabled }) => disabled);
const baseline = JSON.parse(fs.readFileSync('test-policy/disabled-tests.json', 'utf8'));
const remaining = new Map(baseline.map((entry) => [entry.key, entry.count]));
const failures = [];
let invalid = 0;
let expired = 0;
let expiring = 0;
for (const { filePath: file, ...extra } of analysis) {
  for (const line of extra.focused) { console.error(`${file}:${line}: focused test is forbidden`); invalid++; }
  const lapsed = new Map(extra.expiredExceptions.map((exception) => [exception.line, exception]));
  for (const line of extra.invalidExceptions) {
    const exception = lapsed.get(line);
    if (!exception) { console.error(`${file}:${line}: test exception requires owner=NAME, lane=EXECUTION-OBLIGATION and expires=YYYY-MM-DD within 31 days`); invalid++; continue; }
    const message = `test exception expired on ${exception.expires}; confirm lane=${exception.lane} still runs it, then renew expires= (at most 31 days ahead)`;
    expired++;
    if (expiryMode === 'fail') { console.error(`${file}:${line}: ${message}`); invalid++; } else warn(file, line, message);
  }
  for (const exception of extra.expiringExceptions) {
    expiring++;
    warn(file, exception.line, `test exception expires on ${exception.expires} (${exception.daysLeft} day(s) left); confirm lane=${exception.lane} still runs it and renew expires=`);
  }
}
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `expired_test_exceptions=${expired}\nexpiring_test_exceptions=${expiring}\n`);
for (const finding of findings) {
  const key = `${finding.filePath}:${finding.rule}:${finding.fingerprint}`;
  const count = remaining.get(key) ?? 0;
  if (count <= 0) failures.push(finding);
  else remaining.set(key, count - 1);
}
for (const finding of failures) console.error(`${finding.filePath}:${finding.line}: new disabled test/discovery exclusion (${finding.api}); restore execution or record a reviewed, issue-linked exception`);
console.log(`Disabled-test audit: ${findings.length} existing findings, ${failures.length} additions.`);
if (failures.length || invalid) process.exitCode = 1;
