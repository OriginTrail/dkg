#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectJunitResults } from '../lib/junit-results.mjs';
import { coverageReceipt } from '../lib/coverage-artifacts.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');

function repositoryPath(relativePath, optionName, root) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`${optionName} must be a repository-relative path`);
  }
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${optionName} must stay inside the repository`);
  }
  return resolved;
}

function parseArguments(argv) {
  const separator = argv.indexOf('--');
  const optionArguments = separator === -1 ? argv : argv.slice(0, separator);
  const testArguments = separator === -1 ? [] : argv.slice(separator + 1);
  const options = {};

  for (let index = 0; index < optionArguments.length; index += 2) {
    const option = optionArguments[index];
    const value = optionArguments[index + 1];
    if (!['--lane', '--shard'].includes(option) || !value) {
      throw new Error('expected --lane NAME and optional --shard ID before --');
    }
    options[option.slice(2)] = value;
  }
  if (!options.lane) throw new Error('--lane is required');
  if (testArguments.some((argument) => argument.startsWith('--reporter') || argument.startsWith('--outputFile'))) {
    throw new Error('reporter and output options are managed by the shared CI runner');
  }
  return { laneName: options.lane, shard: options.shard, testArguments };
}

export function buildVitestJunitInvocation(
  argv,
  { readPackageJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8')), coverage = process.env.DKG_CI_COVERAGE === '1', repoRoot = REPO_ROOT } = {},
) {
  const { laneName, shard, testArguments } = parseArguments(argv);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(laneName)) {
    throw new Error('--lane must be a package directory name');
  }
  if (shard !== undefined && !/^\d+$/.test(shard)) {
    throw new Error('--shard must be numeric');
  }

  const packageRelativePath = `packages/${laneName}`;
  const packageDirectory = repositoryPath(packageRelativePath, 'lane package directory', repoRoot);
  const packageJsonPath = path.join(packageDirectory, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`${packageRelativePath}/package.json does not exist`);
  }
  const packageJson = readPackageJson(packageJsonPath);
  if (typeof packageJson.devDependencies?.vitest !== 'string') {
    throw new Error(`${packageRelativePath}/package.json must declare Vitest as a devDependency`);
  }

  const output = `test-results/${laneName}${shard === undefined ? '' : `-${shard}`}.xml`;
  const outputPath = path.resolve(packageDirectory, output);
  const relativeOutput = path.relative(packageDirectory, outputPath);
  if (relativeOutput === '..' || relativeOutput.startsWith(`..${path.sep}`)) {
    throw new Error('JUnit output must stay inside its package directory');
  }

  return {
    coverage,
    laneName,
    shard,
    command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    output,
    outputPath,
    args: [
      '--dir',
      packageDirectory,
      'exec',
      'vitest',
      'run',
      ...testArguments,
      ...(coverage ? ['--coverage', '--coverage.thresholds.lines=0', '--coverage.thresholds.functions=0', '--coverage.thresholds.branches=0', '--coverage.thresholds.statements=0'] : []),
      '--reporter=default',
      '--reporter=junit',
      `--outputFile.junit=${output}`,
    ],
  };
}

export function runVitestJunit(argv, { spawnProcess = spawnSync, repoRoot = REPO_ROOT, ...options } = {}) {
  let invocation;
  try {
    invocation = buildVitestJunitInvocation(argv, { ...options, repoRoot });
  } catch (error) {
    console.error(`vitest-junit: ${error.message}`);
    return 2;
  }

  fs.mkdirSync(path.dirname(invocation.outputPath), { recursive: true });
  fs.rmSync(invocation.outputPath, { force: true });
  const receiptPath = invocation.outputPath.replace(/\.xml$/, '.coverage.json');
  fs.rmSync(receiptPath, { force: true });
  if (invocation.coverage) fs.rmSync(path.join(repoRoot, 'packages', invocation.laneName, 'coverage'), { recursive: true, force: true });
  const result = spawnProcess(invocation.command, invocation.args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`vitest-junit: ${result.error.message}`);
    return 2;
  }
  if (result.signal) {
    console.error(`vitest-junit: test process terminated by ${result.signal}`);
    return 1;
  }
  if (result.status !== 0) return result.status ?? 1;

  try {
    const report = fs.statSync(invocation.outputPath);
    if (!report.isFile() || report.size === 0) throw new Error('report is empty');
    const execution = inspectJunitResults(fs.readFileSync(invocation.outputPath, 'utf8'));
    if (invocation.coverage) fs.writeFileSync(receiptPath, JSON.stringify(coverageReceipt(repoRoot, invocation.laneName, invocation.shard, execution)));
  } catch (error) {
    console.error(`vitest-junit: invalid results for ${invocation.output}: ${error.message}`);
    return 1;
  }
  return 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  process.exitCode = runVitestJunit(process.argv.slice(2));
}
