#!/usr/bin/env node
/**
 * Wrapper to run Claude Code in print mode with proper stdio piping.
 * Claude Code can hang in TTY-less environments; spawnSync with piped stdio fixes this.
 *
 * Usage: node claude-run.mjs <output-file> <cwd> [claude args...]
 */

import { spawnSync, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const [,, outputFile, cwd, ...claudeArgs] = process.argv;

if (!outputFile || !cwd || claudeArgs.length === 0) {
  console.error('Usage: node claude-run.mjs <output-file> <cwd> [claude args...]');
  process.exit(1);
}

// Resolve full path to claude binary — backgrounded subshells may not inherit PATH
let claudeBin = process.env.CLAUDE_BIN || '';
if (!claudeBin) {
  const candidates = [
    `${process.env.HOME}/.local/bin/claude`,
    '/usr/local/bin/claude',
  ];
  claudeBin = candidates.find(p => existsSync(p)) || 'claude';
}

mkdirSync(dirname(outputFile), { recursive: true });

const startTime = Date.now();
console.log(`  Started:  ${new Date().toISOString()}`);
console.log(`  CWD:      ${cwd}`);
console.log(`  Output:   ${outputFile}`);

const result = spawnSync(claudeBin, claudeArgs, {
  encoding: 'utf8',
  timeout: 15 * 60 * 1000, // 15 minutes per feature
  maxBuffer: 50 * 1024 * 1024,
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd,
  env: process.env,
});

const elapsed = Math.round((Date.now() - startTime) / 1000);

if (result.error) {
  console.error(`  Error: ${result.error.message}`);
}

const output = result.stdout || result.stderr || JSON.stringify({
  error: result.error?.message ?? `exit ${result.status}`,
  elapsed,
});

writeFileSync(outputFile, output);
console.log(`  Duration: ${elapsed}s`);
console.log(`  Exit:     ${result.status}`);
console.log(`  Size:     ${output.length} bytes`);
