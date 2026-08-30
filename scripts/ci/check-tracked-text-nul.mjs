#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Deliberately allowlisted: binary fixtures and packaged executables are valid tracked files.
// Keep this to source/config/document formats where a NUL makes grep-based tooling silently skip
// code. A basename pattern has no slash, so Git applies it at every repository depth.
export const TRACKED_TEXT_PATHS = Object.freeze([
  '*.alloy',
  '*.ccl',
  '*.cjs',
  '*.css',
  '*.ebnf',
  '*.example',
  '*.gitignore',
  '*.gitkeep',
  '*.html',
  '*.ini',
  '*.js',
  '*.json',
  '*.jsonc',
  '*.jsonl',
  '*.lock',
  '*.log',
  '*.md',
  '*.mdc',
  '*.mjs',
  '*.mts',
  '*.npmrc',
  '*.nq',
  '*.nt',
  '*.nvmrc',
  '*.patch',
  '*.py',
  '*.service',
  '*.sh',
  '*.snap',
  '*.sol',
  '*.solhintignore',
  '*.svg',
  '*.toml',
  '*.ts',
  '*.tsx',
  '*.ttl',
  '*.txt',
  '*.yaml',
  '*.yml',
  'CODEOWNERS',
  'LICENSE',
]);

function nulSeparatedPaths(buffer) {
  return buffer
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function commandFailure(command, result) {
  const detail = Buffer.from(result.stderr ?? '').toString('utf8').trim();
  return new Error(
    `${command} exited with status ${result.status ?? 'unknown'}${detail ? `: ${detail}` : ''}`,
  );
}

function runGit(spawnProcess, args, repoRoot) {
  const result = spawnProcess('git', args, {
    cwd: repoRoot,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`git ${args[0]} terminated by ${result.signal}`);
  return result;
}

/** Return tracked text paths containing at least one literal NUL byte. */
export function findTrackedTextFilesWithNul({
  repoRoot = REPO_ROOT,
  spawnProcess = spawnSync,
  readFile = fs.readFileSync,
} = {}) {
  // Do not add `-I`: it excludes the binary-classified files this guard exists to catch.
  const grep = runGit(
    spawnProcess,
    ['grep', '-z', '-l', '-P', '\\x00', '--', ...TRACKED_TEXT_PATHS],
    repoRoot,
  );
  if (grep.status === 0) return nulSeparatedPaths(grep.stdout);
  if (grep.status === 1) return [];

  const grepError = Buffer.from(grep.stderr ?? '').toString('utf8');
  if (!/(?:PCRE|Perl-compatible)/i.test(grepError)) {
    throw commandFailure('git grep', grep);
  }

  // Portable fallback for Git builds compiled without PCRE. `git ls-files` keeps the scope to
  // tracked paths; reading Buffers avoids any text-decoder normalization hiding a literal byte.
  const listing = runGit(
    spawnProcess,
    ['ls-files', '-z', '--', ...TRACKED_TEXT_PATHS],
    repoRoot,
  );
  if (listing.status !== 0) throw commandFailure('git ls-files', listing);

  const offenders = [];
  for (const filePath of nulSeparatedPaths(listing.stdout)) {
    try {
      if (readFile(path.join(repoRoot, filePath)).includes(0)) offenders.push(filePath);
    } catch (error) {
      // A tracked file can be absent in a developer's unstaged deletion. Git grep ignores that
      // working-tree path too; CI checkouts are complete, so parity is preferable to a false fail.
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return offenders;
}

export function runTrackedTextNulCheck(options) {
  const offenders = findTrackedTextFilesWithNul(options);
  if (offenders.length === 0) {
    console.log('Tracked text NUL-byte check passed.');
    return 0;
  }
  console.error('Literal NUL byte(s) found in tracked text files:');
  for (const filePath of offenders) console.error(`  ${JSON.stringify(filePath)}`);
  console.error('Remove the NUL bytes; do not suppress this check with git grep -I.');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runTrackedTextNulCheck();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
