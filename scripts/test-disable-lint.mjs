#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { auditFiles, computeDiffFindings, listTrackedFiles } from './lib/disabled-test-git.mjs';
export { auditFiles, computeDiffFindings } from './lib/disabled-test-git.mjs';
export { analyzeD1Source, analyzeD2Source, isD1ScannableFile, isD2ScannableFile } from './lib/disabled-test-scanner.mjs';

function runDiff(baseRevision, headRevision) {
  const blocking = computeDiffFindings(baseRevision, headRevision).results
    .filter(({ verdict }) => verdict === 'new');
  for (const finding of blocking) {
    process.stdout.write(
      `${finding.filePath}:${finding.line}:${finding.column}: ${finding.rule} ${finding.api}\n`,
    );
  }
  return blocking.length === 0 ? 0 : 1;
}

export function runCli(argv = process.argv.slice(2)) {
  if (argv[0] === '--self-test') {
    return spawnSync(process.execPath, ['--test', fileURLToPath(new URL('./lib/__tests__/test-disable-lint.test.mjs', import.meta.url))], { stdio: 'inherit' }).status ?? 1;
  }
  if (argv[0] === '--diff') {
    const [, baseRevision, headRevision] = argv;
    if (!baseRevision || !headRevision) {
      process.stderr.write(
        'Usage: node scripts/test-disable-lint.mjs --diff <base> <head>\n',
      );
      return 2;
    }
    return runDiff(baseRevision, headRevision);
  }
  if (argv[0] === '--all') {
    for (const finding of auditFiles(listTrackedFiles())) {
      process.stdout.write(
        `${finding.filePath}:${finding.line}:${finding.column}: ${finding.rule} ${finding.api}\n`,
      );
    }
    return 0;
  }
  if (argv[0] !== '--files' || argv.length === 1) {
    process.stderr.write(
      'Usage: node scripts/test-disable-lint.mjs '
        + '--diff <base> <head> | --all | --files <path...> | --self-test\n',
    );
    return 2;
  }

  for (const finding of auditFiles(argv.slice(1))) {
    process.stdout.write(
      `${finding.filePath}:${finding.line}:${finding.column}: ${finding.rule} ${finding.api}\n`,
    );
  }
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runCli();
