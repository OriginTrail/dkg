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

function nulSeparatedPathBuffers(buffer) {
  const paths = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) paths.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start < buffer.length) paths.push(buffer.subarray(start));
  return paths;
}

function absolutePathBuffer(repoRoot, relativePath) {
  return Buffer.concat([
    Buffer.from(path.resolve(repoRoot)),
    Buffer.from(path.sep),
    relativePath,
  ]);
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
  // One portable path on every platform: Git applies the text allowlist, emits raw NUL-delimited
  // pathname bytes, and Node inspects the working-tree file as bytes. Do not decode a pathname
  // before opening it: Git permits non-UTF-8 names and fs.readFileSync accepts a Buffer path.
  const listing = runGit(
    spawnProcess,
    ['ls-files', '-z', '--', ...TRACKED_TEXT_PATHS],
    repoRoot,
  );
  if (listing.status !== 0) throw commandFailure('git ls-files', listing);

  const offenders = [];
  for (const filePath of nulSeparatedPathBuffers(listing.stdout)) {
    try {
      if (readFile(absolutePathBuffer(repoRoot, filePath)).includes(0)) offenders.push(filePath);
    } catch (error) {
      // A tracked file can be absent in a developer's unstaged deletion. Preserve that local
      // workflow, but fail closed for every other read error; CI checkouts are complete.
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return offenders;
}

export function runTrackedTextNulCheck({
  log = console.log,
  logError = console.error,
  ...scanOptions
} = {}) {
  const offenders = findTrackedTextFilesWithNul(scanOptions);
  if (offenders.length === 0) {
    log('Tracked text NUL-byte check passed.');
    return 0;
  }
  logError('Literal NUL byte(s) found in tracked text files:');
  for (const filePath of offenders) {
    // Decode only for human diagnostics; file lookup above always uses the original bytes.
    logError(`  ${JSON.stringify(filePath.toString('utf8'))}`);
  }
  logError('Remove the NUL bytes from these source/config/document files.');
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
