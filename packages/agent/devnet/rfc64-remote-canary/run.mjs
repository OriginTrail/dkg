#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RemoteCanaryError,
  runRemoteCanaryArtifactLifecycleV1,
} from './certify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ARTIFACT = join(HERE, 'artifacts', 'latest.json');

function usage() {
  return 'Usage: node run.mjs --config /absolute/config.json [--artifact /absolute/result.json] [--dry-run]';
}

function parseArgs(argv) {
  const parsed = { artifact: DEFAULT_ARTIFACT, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') parsed.dryRun = true;
    else if (arg === '--config' || arg === '--artifact') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('missing-argument');
      parsed[arg.slice(2)] = value;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else throw new Error('unknown-argument');
  }
  if (typeof parsed.config !== 'string') throw new Error('config-required');
  if (!isAbsolute(parsed.config)) throw new Error('config-path-must-be-absolute');
  parsed.artifact = resolve(parsed.artifact);
  return parsed;
}

try {
  const args = parseArgs(process.argv.slice(2));
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
