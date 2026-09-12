#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RemoteCanaryError,
  runRemoteCanaryArtifactLifecycleV1,
} from './certify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ARTIFACT = join(HERE, 'artifacts', 'latest.json');

/** @typedef {{ config: string, artifact: string, dryRun: boolean }} ParsedArgsV1 */

function usage() {
  return 'Usage: node run.mjs --config /absolute/config.json [--artifact /absolute/result.json] [--dry-run]';
}

/** @param {readonly string[]} argv @returns {ParsedArgsV1} */
function parseArgs(argv) {
  /** @type {Partial<ParsedArgsV1> & Pick<ParsedArgsV1, 'artifact' | 'dryRun'>} */
  const parsed = { artifact: DEFAULT_ARTIFACT, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--config' || arg === '--artifact') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('missing-argument');
      if (arg === '--config') parsed.config = value;
      else parsed.artifact = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else throw new Error('unknown-argument');
  }
  if (typeof parsed.config !== 'string') throw new Error('config-required');
  if (!isAbsolute(parsed.config)) throw new Error('config-path-must-be-absolute');
  parsed.artifact = resolve(parsed.artifact);
  return /** @type {ParsedArgsV1} */ (parsed);
}

/** @param {string} path @returns {Promise<string>} */
async function canonicalizePotentialPath(path) {
  let cursor = resolve(path);
  const missingSegments = [];
  while (true) {
    try {
      return join(await realpath(cursor), ...missingSegments);
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      missingSegments.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/** @param {string} path */
async function statIfPresent(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null;
    throw error;
  }
}

/** @param {string} configPath @param {string} artifactPath */
async function assertDistinctConfigAndArtifactPaths(configPath, artifactPath) {
  const resolvedConfig = resolve(configPath);
  const resolvedArtifact = resolve(artifactPath);
  if (resolvedConfig === resolvedArtifact) {
    throw new RemoteCanaryError('config-artifact-path-alias', 'configuration');
  }
  const [canonicalConfig, canonicalArtifact, configStat, artifactStat] = await Promise.all([
    canonicalizePotentialPath(resolvedConfig),
    canonicalizePotentialPath(resolvedArtifact),
    statIfPresent(resolvedConfig),
    statIfPresent(resolvedArtifact),
  ]);
  if (
    canonicalConfig === canonicalArtifact
    || (
      configStat !== null
      && artifactStat !== null
      && configStat.dev === artifactStat.dev
      && configStat.ino === artifactStat.ino
    )
  ) throw new RemoteCanaryError('config-artifact-path-alias', 'configuration');
}

/** @param {unknown} error @param {string} code @returns {boolean} */
function hasErrorCode(error, code) {
  return error !== null
    && typeof error === 'object'
    && !Array.isArray(error)
    && /** @type {{ code?: unknown }} */ (error).code === code;
}

try {
  const args = parseArgs(process.argv.slice(2));
  await assertDistinctConfigAndArtifactPaths(args.config, args.artifact);
  const artifact = await runRemoteCanaryArtifactLifecycleV1({
    loadConfig: async () => JSON.parse(await readFile(args.config, 'utf8')),
    artifactPath: args.artifact,
    dryRun: args.dryRun,
  });
  process.stdout.write(`${artifact.status} ${args.artifact}\n`);
  process.exitCode = artifact.status === 'INCOMPLETE' ? 2 : 0;
} catch (error) {
  const code = error instanceof RemoteCanaryError ? error.code : 'runner-failed';
  process.stderr.write(`FAIL ${code}\n${usage()}\n`);
  process.exitCode = 1;
}
