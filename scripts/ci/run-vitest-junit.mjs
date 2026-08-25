#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function resolveRepositoryPath(relativePath, optionName) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`${optionName} must be a repository-relative path`);
  }
  const resolved = path.resolve(REPO_ROOT, relativePath);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
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
    if (!['--package-dir', '--output'].includes(option) || !value) {
      throw new Error(`expected --package-dir DIR and --output FILE before --`);
    }
    options[option.slice(2)] = value;
  }
  if (!options['package-dir'] || !options.output) {
    throw new Error('--package-dir and --output are required');
  }
  if (testArguments.some((argument) => argument.startsWith('--reporter') || argument.startsWith('--outputFile'))) {
    throw new Error('reporter and output options are managed by the shared CI runner');
  }
  return { packageDirectory: options['package-dir'], output: options.output, testArguments };
}

export function buildVitestJunitInvocation(argv) {
  const { packageDirectory, output, testArguments } = parseArguments(argv);
  const absolutePackageDirectory = resolveRepositoryPath(packageDirectory, '--package-dir');
  const packageJsonPath = path.join(absolutePackageDirectory, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (typeof packageJson.scripts?.test !== 'string') {
    throw new Error(`${packageDirectory}/package.json must define the authoritative test script`);
  }

  const absoluteOutput = path.resolve(absolutePackageDirectory, output);
  const packageRelativeOutput = path.relative(absolutePackageDirectory, absoluteOutput);
  if (
    !output
    || path.isAbsolute(output)
    || packageRelativeOutput === '..'
    || packageRelativeOutput.startsWith(`..${path.sep}`)
  ) {
    throw new Error('--output must stay inside the package directory');
  }
  return {
    command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    outputDirectory: path.dirname(absoluteOutput),
    args: [
      '--dir',
      absolutePackageDirectory,
      'test',
      ...testArguments,
      '--reporter=default',
      '--reporter=junit',
      `--outputFile.junit=${output}`,
    ],
  };
}

export function runVitestJunit(argv) {
  let invocation;
  try {
    invocation = buildVitestJunitInvocation(argv);
  } catch (error) {
    console.error(`vitest-junit: ${error.message}`);
    return 2;
  }

  fs.mkdirSync(invocation.outputDirectory, { recursive: true });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: REPO_ROOT,
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
  return result.status ?? 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  process.exitCode = runVitestJunit(process.argv.slice(2));
}
