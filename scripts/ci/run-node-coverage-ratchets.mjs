#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIRECTORY, '../..');
const MANIFEST_PATH = path.join(SCRIPT_DIRECTORY, 'node-coverage-packages.json');

export function loadNodeCoverageManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  if (
    manifest?.version !== 1
    || !Number.isInteger(manifest.maxConcurrency)
    || manifest.maxConcurrency < 1
    || !Array.isArray(manifest.packages)
    || manifest.packages.length === 0
  ) {
    throw new Error('node coverage manifest must define version, maxConcurrency, and packages');
  }
  const names = new Set();
  const paths = new Set();
  for (const entry of manifest.packages) {
    if (typeof entry?.name !== 'string' || typeof entry?.path !== 'string') {
      throw new Error('every coverage package needs name and path strings');
    }
    if (names.has(entry.name) || paths.has(entry.path)) {
      throw new Error(`duplicate coverage package entry: ${entry.name}`);
    }
    names.add(entry.name);
    paths.add(entry.path);
  }
  return manifest;
}

export function buildNodeCoverageInvocation(manifest = loadNodeCoverageManifest()) {
  return {
    command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args: [
      'exec',
      'turbo',
      'test:coverage',
      ...manifest.packages.map((entry) => `--filter=${entry.name}`),
      `--concurrency=${manifest.maxConcurrency}`,
      '--continue=always',
    ],
    reportPaths: manifest.packages.map((entry) => `${entry.path}/coverage/`),
  };
}

function githubOutputPath(argv) {
  if (argv.length === 0) return undefined;
  if (argv.length === 2 && argv[0] === '--github-output' && argv[1]) return argv[1];
  throw new Error('usage: run-node-coverage-ratchets.mjs [--github-output FILE]');
}

export function runNodeCoverageRatchets(argv, { spawnProcess = spawnSync } = {}) {
  try {
    const outputPath = githubOutputPath(argv);
    const invocation = buildNodeCoverageInvocation();
    if (outputPath) {
      fs.appendFileSync(
        outputPath,
        `report_paths<<EOF\n${invocation.reportPaths.join('\n')}\nEOF\n`,
      );
    }
    const result = spawnProcess(invocation.command, invocation.args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`coverage process terminated by ${result.signal}`);
    return result.status ?? 1;
  } catch (error) {
    console.error(`node-coverage: ${error.message}`);
    return 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  process.exitCode = runNodeCoverageRatchets(process.argv.slice(2));
}
