#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { swallowedAssertions } from '../lib/swallowed-assertions.mjs';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0')
  .filter(file => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) && !file.includes('/archive/'));
const findings = files.flatMap(file => swallowedAssertions(fs.readFileSync(file, 'utf8'), file));
for (const row of findings) console.error(`${row.file}:${row.line}: ${row.message}`);
if (findings.length) process.exitCode = 1;
else console.log('No confirmed swallowed assertions');
