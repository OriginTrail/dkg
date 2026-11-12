import { describe, expect, it } from 'vitest';
import {
  BUILD_OUTPUT_LINE_CHARS,
  BUILD_OUTPUT_TAIL_LINES,
  buildStepFailureSummary,
  buildStepOutputLines,
  outputTail,
} from '../src/daemon/auto-update-build-output.js';
import { runBuildStep } from '../src/daemon/auto-update.js';

// How `promisify(exec)` rejects on a non-zero exit: stderr appended to the
// message, both captured streams attached.
function execFailure(cmd: string, stdout: string, stderr = '') {
  return Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), {
    code: 1, killed: false, signal: null, cmd, stdout, stderr,
  });
}

// The end of a git-mode node's runtime build whose semantic runtime prebuild
// found no rustc. pnpm printed all of it on stdout; stderr stayed empty.
const RUNTIME_BUILD_STDOUT = [
  ...Array.from({ length: 40 }, (_, index) => `packages/p${index} build$ tsc`),
  'packages/semantic-runtime prebuild$ node ../../scripts/build-semantic-runtime.mjs',
  'packages/semantic-runtime prebuild: spawnSync rustc ENOENT',
  'packages/semantic-runtime prebuild: Failed',
  ' ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @origintrail-official/dkg-semantic-runtime@10.1.1 prebuild: `node ../../scripts/build-semantic-runtime.mjs`',
  'Exit status 1',
  ' ELIFECYCLE  Command failed with exit code 1.',
  '',
].join('\n');

describe('updater build step output', () => {
  it('logs the end of stdout when a failed step leaves stderr empty', async () => {
    const logs: string[] = [];
    const failure = execFailure('pnpm build:runtime:packages', RUNTIME_BUILD_STDOUT);
    await expect(runBuildStep(async () => { throw failure; }, 'pnpm build:runtime:packages', {
      cwd: '/srv/dkg/releases/b',
      timeoutMs: 600_000,
      label: 'pnpm build:runtime:packages',
      log: (message) => logs.push(message),
    })).rejects.toBe(failure);
    expect(logs[0]).toMatch(
      /^Auto-update: build step "pnpm build:runtime:packages" failed after \d+ms — Command failed: pnpm build:runtime:packages$/,
    );
    expect(logs[1]).toBe(
      `Auto-update: build step "pnpm build:runtime:packages" stdout, last ${BUILD_OUTPUT_TAIL_LINES} line(s):`,
    );
    expect(logs).toHaveLength(2 + BUILD_OUTPUT_TAIL_LINES);
    expect(logs).toContain('Auto-update:   packages/semantic-runtime prebuild: spawnSync rustc ENOENT');
    expect(logs.at(-1)).toBe('Auto-update:    ELIFECYCLE  Command failed with exit code 1.');
    expect(logs.some((line) => line.includes('stderr') || line.includes('\n'))).toBe(false);
  });

  it('keeps the summary to one line and gives stderr its own tail after stdout', () => {
    const failure = execFailure(
      'pnpm install --frozen-lockfile',
      'Lockfile is up to date, resolution step is skipped\n',
      ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"\n\n  Note that in CI environments\n',
    );
    expect(buildStepFailureSummary(failure)).toBe('Command failed: pnpm install --frozen-lockfile');
    expect(buildStepOutputLines('pnpm install', failure)).toEqual([
      'Auto-update: build step "pnpm install" stdout, last 1 line(s):',
      'Auto-update:   Lockfile is up to date, resolution step is skipped',
      'Auto-update: build step "pnpm install" stderr, last 2 line(s):',
      'Auto-update:    ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile"',
      'Auto-update:     Note that in CI environments',
    ]);
  });

  it('removes terminal escapes and control characters, caps long lines and reads only the end of a large stream', () => {
    const long = 'x'.repeat(BUILD_OUTPUT_LINE_CHARS + 50);
    const link = '\x1b]8;;https://pnpm.io/errors\x07pnpm docs\x1b]8;;\x07';
    expect(outputTail(`\x1b[31merror\x1b[39m TS2307\r\nstep 1\rstep 2\u0007\nsee ${link}\n${long}\n`)).toEqual([
      'error TS2307',
      'step 1',
      'step 2',
      'see pnpm docs',
      `${'x'.repeat(BUILD_OUTPUT_LINE_CHARS)}…`,
    ]);
    const tail = outputTail(`${'early\n'.repeat(200_000)}late 1\nlate 2\n`, 3);
    expect(tail).toEqual(['early', 'late 1', 'late 2']);
  });

  it('adds no lines when a step captured no output', () => {
    expect(buildStepOutputLines('pnpm install', new Error('spawn /bin/sh ENOENT'))).toEqual([]);
    expect(buildStepOutputLines('pnpm install', execFailure('pnpm install', '', '\n \n'))).toEqual([]);
    expect(buildStepOutputLines('pnpm install', undefined)).toEqual([]);
    expect(buildStepFailureSummary('a plain failure')).toBe('a plain failure');
  });
});
