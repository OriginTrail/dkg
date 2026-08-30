#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Every tracked file is inspected unless it is explicitly classified as an intentional binary.
// Keep this policy beside the scanner so a future CI controller can pin both together; never read
// an exclusion policy from the untrusted candidate checkout.
export const TRACKED_BINARY_PATHS = Object.freeze({
  suffixes: Object.freeze(['.docx', '.jpeg', '.jpg', '.png', '.zip']),
  basenames: Object.freeze(['.DS_Store']),
  exact: Object.freeze([
    'packages/evm-module/utils/converters/darwin-evm-contract-into-substrate-address',
    'packages/evm-module/utils/converters/linux-evm-contract-into-substrate-address',
  ]),
});

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

function isExplicitBinaryPath(filePath) {
  const diagnosticPath = filePath.toString('utf8');
  // Binary exceptions are a text policy. Invalid UTF-8 must never acquire an
  // exception through replacement-character decoding, even when its decoded
  // suffix happens to look like a known binary format.
  if (!Buffer.from(diagnosticPath, 'utf8').equals(filePath)) return false;
  const basename = path.posix.basename(diagnosticPath);
  return TRACKED_BINARY_PATHS.exact.includes(diagnosticPath)
    || TRACKED_BINARY_PATHS.basenames.includes(basename)
    || TRACKED_BINARY_PATHS.suffixes.some((suffix) => diagnosticPath.endsWith(suffix));
}

/** Return non-binary tracked paths containing at least one literal NUL byte. */
export function findTrackedFilesWithNul({
  repoRoot = REPO_ROOT,
  spawnProcess = spawnSync,
  readFile = fs.readFileSync,
} = {}) {
  // Git emits raw NUL-delimited pathname bytes and Node inspects working-tree files as bytes. Do
  // not decode a pathname before opening it: Git permits non-UTF-8 names and fs accepts Buffer
  // paths. Invalid UTF-8 cannot match an explicit binary exception and therefore fails closed.
  const listing = runGit(spawnProcess, ['ls-files', '-z'], repoRoot);
  if (listing.status !== 0) throw commandFailure('git ls-files', listing);

  const offenders = [];
  for (const filePath of nulSeparatedPathBuffers(listing.stdout)) {
    if (isExplicitBinaryPath(filePath)) continue;
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
  const offenders = findTrackedFilesWithNul(scanOptions);
  if (offenders.length === 0) {
    log('Tracked non-binary NUL-byte check passed.');
    return 0;
  }
  logError('Literal NUL byte(s) found in tracked non-binary files:');
  for (const filePath of offenders) {
    // Decode only for human diagnostics; file lookup above always uses the original bytes.
    logError(`  ${JSON.stringify(filePath.toString('utf8'))}`);
  }
  logError('Remove the NUL bytes or explicitly classify an intentional binary in the trusted scanner.');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { repo: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    });
    process.exitCode = runTrackedTextNulCheck({
      repoRoot: path.resolve(values.repo ?? REPO_ROOT),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
