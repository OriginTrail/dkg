#!/usr/bin/env node
// Reuses the AST scanner proposed in OriginTrail/dkg#1769 (8bd5d905), with a
// checked-in debt ledger so push, merge queue and local checks also fail closed.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { auditFiles, isD1ScannableFile, isD2ScannableFile } from '../test-disable-lint.mjs';
import { inspectTestExceptions } from '../lib/test-exceptions.mjs';

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter((file) => file && fs.existsSync(file));
const findings = auditFiles([...new Set(files)]);
const baseline = JSON.parse(fs.readFileSync('test-policy/disabled-tests.json', 'utf8'));
const remaining = new Map(baseline.map((entry) => [entry.key, entry.count]));
const failures = [];
let invalid = 0;
for (const file of files.filter((file) => isD1ScannableFile(file) || isD2ScannableFile(file))) {
  const extra = inspectTestExceptions(fs.readFileSync(file, 'utf8'), file);
  for (const line of extra.focused) { console.error(`${file}:${line}: focused test is forbidden`); invalid++; }
  for (const line of extra.invalidExceptions) { console.error(`${file}:${line}: test exception requires owner=NAME, lane=EXECUTION-OBLIGATION and expires=YYYY-MM-DD within 31 days`); invalid++; }
}
for (const finding of findings) {
  const key = `${finding.filePath}:${finding.rule}:${finding.fingerprint}`;
  const count = remaining.get(key) ?? 0;
  if (count <= 0) failures.push(finding);
  else remaining.set(key, count - 1);
}
for (const finding of failures) console.error(`${finding.filePath}:${finding.line}: new disabled test/discovery exclusion (${finding.api}); restore execution or record a reviewed, issue-linked exception`);
console.log(`Disabled-test audit: ${findings.length} existing findings, ${failures.length} additions.`);
if (failures.length || invalid) process.exitCode = 1;
