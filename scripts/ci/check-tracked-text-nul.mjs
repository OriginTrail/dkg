#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_BLOB_BATCH_BYTES = 32 * 1024 * 1024;

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

function nulSeparatedBuffers(buffer) {
  const values = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) values.push(buffer.subarray(start, index));
    start = index + 1;
  }
  if (start < buffer.length) values.push(buffer.subarray(start));
  return values;
}

function commandFailure(command, result) {
  const detail = Buffer.from(result.stderr ?? '').toString('utf8').trim();
  return new Error(
    `${command} exited with status ${result.status ?? 'unknown'}${detail ? `: ${detail}` : ''}`,
  );
}

function runGit(spawnProcess, args, repoRoot, input, maxBuffer = 64 * 1024 * 1024) {
  const result = spawnProcess('git', args, {
    cwd: repoRoot,
    encoding: null,
    maxBuffer,
    input,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`git ${args[0]} terminated by ${result.signal}`);
  return result;
}

function parseBatchHeader(header, entry, command) {
  const [objectId, objectType, rawSize] = Buffer.from(header).toString('ascii').split(' ');
  const size = Number(rawSize);
  if (
    objectId !== entry.objectId
    || objectType !== 'blob'
    || !Number.isSafeInteger(size)
    || size < 0
  ) {
    throw new Error(`git cat-file ${command} returned invalid metadata for ${entry.objectId}`);
  }
  return size;
}

function attachBlobSizes(batchOutput, entries) {
  const lines = batchOutput.toString('ascii').trimEnd().split('\n');
  if (lines.length !== entries.length) {
    throw new Error('git cat-file --batch-check returned an unexpected number of entries');
  }
  return entries.map((entry, index) => ({
    ...entry,
    size: parseBatchHeader(lines[index], entry, '--batch-check'),
  }));
}

function blobBatches(entries) {
  const batches = [];
  let batch = [];
  let batchBytes = 0;
  for (const entry of entries) {
    if (batch.length > 0 && batchBytes + entry.size > MAX_BLOB_BATCH_BYTES) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(entry);
    batchBytes += entry.size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function parseIndexEntries(buffer) {
  return nulSeparatedBuffers(buffer).map((record) => {
    const tab = record.indexOf(0x09);
    if (tab < 0) throw new Error('git ls-files --stage returned a malformed index entry');
    const [mode, objectId, stage] = record.subarray(0, tab).toString('ascii').split(' ');
    if (!mode || !/^[0-9a-f]+$/u.test(objectId ?? '') || !stage) {
      throw new Error('git ls-files --stage returned malformed entry metadata');
    }
    return { mode, objectId, stage, filePath: record.subarray(tab + 1) };
  });
}

function decodeBlobBatch(batchOutput, entries) {
  const records = [];
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = batchOutput.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error('git cat-file --batch returned a truncated header');
    const size = parseBatchHeader(
      batchOutput.subarray(offset, headerEnd),
      entry,
      '--batch',
    );
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= batchOutput.length || batchOutput[contentEnd] !== 0x0a) {
      throw new Error(`git cat-file --batch returned a truncated blob for ${entry.objectId}`);
    }
    records.push({ filePath: entry.filePath, contents: batchOutput.subarray(contentStart, contentEnd) });
    offset = contentEnd + 1;
  }
  if (offset !== batchOutput.length) {
    throw new Error('git cat-file --batch returned unexpected trailing output');
  }
  return records;
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

/**
 * Yield regular staged files from Git's object database in bounded batches.
 * Candidate-controlled worktree paths are never opened; symlinks and gitlinks
 * are excluded by their index modes before any blob contents are requested.
 */
export function* readTrackedBlobs({
  repoRoot = REPO_ROOT,
  spawnProcess = spawnSync,
} = {}) {
  const listing = runGit(spawnProcess, ['ls-files', '--stage', '-z'], repoRoot);
  if (listing.status !== 0) throw commandFailure('git ls-files --stage', listing);
  const entries = parseIndexEntries(listing.stdout).filter((entry) =>
    entry.stage === '0'
    && (entry.mode === '100644' || entry.mode === '100755')
    && !isExplicitBinaryPath(entry.filePath));
  if (entries.length === 0) return;

  const input = Buffer.from(`${entries.map((entry) => entry.objectId).join('\n')}\n`, 'ascii');
  const metadata = runGit(spawnProcess, ['cat-file', '--batch-check'], repoRoot, input);
  if (metadata.status !== 0) throw commandFailure('git cat-file --batch-check', metadata);

  for (const batch of blobBatches(attachBlobSizes(metadata.stdout, entries))) {
    const batchInput = Buffer.from(`${batch.map((entry) => entry.objectId).join('\n')}\n`, 'ascii');
    const expectedOutputBytes = batch.reduce((sum, entry) => sum + entry.size + 128, 0);
    const blobs = runGit(
      spawnProcess,
      ['cat-file', '--batch'],
      repoRoot,
      batchInput,
      Math.max(1024, expectedOutputBytes),
    );
    if (blobs.status !== 0) throw commandFailure('git cat-file --batch', blobs);
    yield* decodeBlobBatch(blobs.stdout, batch);
  }
}

/** Return non-binary tracked paths containing at least one literal NUL byte. */
export function findTrackedFilesWithNul({
  repoRoot = REPO_ROOT,
  readTrackedBlobs: readBlobs = readTrackedBlobs,
} = {}) {
  const offenders = [];
  for (const { filePath, contents } of readBlobs({ repoRoot })) {
    if (contents.includes(0)) offenders.push(filePath);
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
