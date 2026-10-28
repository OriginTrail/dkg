#!/usr/bin/env node
import fs from 'node:fs';
import { listTrackedFiles } from '../lib/disabled-test-git.mjs';
import { isD1ScannableFile } from '../lib/disabled-test-scanner.mjs';
import { swallowedAssertions } from '../lib/swallowed-assertions.mjs';
// The shared D1 policy selects test source; D2 discovery configuration is not an assertion surface.
const files = listTrackedFiles().filter(isD1ScannableFile);
const findings = files.flatMap(file => swallowedAssertions(fs.readFileSync(file, 'utf8'), file));
for (const row of findings) console.error(`${row.file}:${row.line}: ${row.message}`);
if (findings.length) process.exitCode = 1;
else console.log('No confirmed swallowed assertions');
