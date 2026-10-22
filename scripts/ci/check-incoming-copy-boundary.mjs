#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  findIncomingCopyBoundaryViolations,
  isPackageSourceFile,
} from '../lib/incoming-copy-boundary.mjs';

const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', 'packages'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
)
  .split('\0')
  .filter((file) => file && isPackageSourceFile(file) && fs.existsSync(file));
const violations = findIncomingCopyBoundaryViolations(
  files.map((file) => ({ path: file, text: fs.readFileSync(file, 'utf8') })),
);
for (const violation of violations) console.error(violation);
console.log(`Incoming-copy boundary: ${files.length} source files, ${violations.length} violations.`);
if (violations.length) process.exitCode = 1;
