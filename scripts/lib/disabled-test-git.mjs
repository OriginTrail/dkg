import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { analyzeTestSource, analyzeD1Source, analyzeD2Source, isD1ScannableFile, isD2ScannableFile, isScannableFile } from './disabled-test-scanner.mjs';

export function auditTestFiles(filePaths, options) {
  return filePaths.filter(isScannableFile).map((filePath) => ({
    filePath, ...analyzeTestSource(readFileSync(filePath, 'utf8'), filePath, options),
  }));
}

export function auditFiles(filePaths) {
  return auditTestFiles(filePaths).flatMap(({ disabled }) => disabled);
}

function git(args, cwd = process.cwd()) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function changedEntries(baseRevision, headRevision, cwd) {
  const entries = [];
  const fields = git([
    'diff',
    '--name-status',
    '-z',
    '--find-renames',
    '--find-copies-harder',
    '--diff-filter=ACDMR',
    baseRevision,
    headRevision,
  ], cwd).split('\0');

  for (let index = 0; index < fields.length - 1;) {
    const status = fields[index++];
    const firstPath = fields[index++];
    const secondPath = status.startsWith('R') || status.startsWith('C')
      ? fields[index++]
      : undefined;
    if (status.startsWith('R')) {
      if (isScannableFile(firstPath) || isScannableFile(secondPath)) {
        entries.push({
          basePath: isScannableFile(firstPath) ? firstPath : null,
          headPath: isScannableFile(secondPath) ? secondPath : null,
        });
      }
    } else if (status.startsWith('C')) {
      if (isScannableFile(secondPath)) {
        entries.push({ basePath: null, headPath: secondPath });
      }
    } else if (isScannableFile(firstPath)) {
      entries.push({
        basePath: status === 'A' ? null : firstPath,
        headPath: status === 'D' ? null : firstPath,
      });
    }
  }
  return entries;
}

function findingsAt(revision, filePath, cwd) {
  if (!filePath) return [];
  const source = git(['show', `${revision}:${filePath}`], cwd);
  return [
    ...(isD1ScannableFile(filePath) ? analyzeD1Source(source, filePath) : []),
    ...(isD2ScannableFile(filePath) ? analyzeD2Source(source, filePath) : []),
  ];
}

export function computeDiffFindings(baseRevision, headRevision, cwd = process.cwd()) {
  const entries = changedEntries(baseRevision, headRevision, cwd);
  const baseline = new Map();
  for (const entry of entries) {
    for (const finding of findingsAt(baseRevision, entry.basePath, cwd)) {
      baseline.set(finding.fingerprint, (baseline.get(finding.fingerprint) ?? 0) + 1);
    }
  }

  const results = entries.flatMap((entry) => findingsAt(headRevision, entry.headPath, cwd))
    .map((finding) => {
      const remaining = baseline.get(finding.fingerprint) ?? 0;
      if (remaining === 0) return { ...finding, verdict: 'new' };
      baseline.set(finding.fingerprint, remaining - 1);
      return { ...finding, verdict: 'grandfathered' };
    });
  return { results };
}

export function listTrackedFiles() {
  return git(['ls-files', '-z'])
    .split('\0')
    .filter(isScannableFile);
}

