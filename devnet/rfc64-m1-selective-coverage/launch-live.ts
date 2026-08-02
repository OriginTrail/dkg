import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  atomicWriteExactBytes,
  readCleanRepositoryHead,
} from '../rfc64-persistence-lifecycle/evidence.ts';
import {
  buildGate2RuntimeManifestV1,
  runGate2CleanRuntimeBuildV1,
} from '../rfc64-gate2-multi-asset-completeness/runtime-provenance.ts';
import {
  canonicalJson,
  type ExpectedSelectiveCoverageProvenanceV1,
  type SelectiveCoverageCorpusV1,
} from './manifest.ts';
import { ProcessSelectiveCoverageRuntimeV1 } from './process-runtime.ts';
import { collectSelectiveCoverageEvidenceV1 } from './runtime.ts';
import { runSelectiveCoverageLiveV1 } from './live-runner.ts';

const repoRoot = resolve(import.meta.dirname, '../..');
const corpusPath = resolveRequiredPath('DKG_RFC64_M1_CORPUS_FILE');
const trustAnchorPath = resolveRequiredPath('DKG_RFC64_M1_TRUST_ANCHOR_FILE');
const artifactPath = resolve(
  process.env['DKG_RFC64_M1_ARTIFACT']
    ?? resolve(import.meta.dirname, 'artifacts/selective-coverage-evidence.json'),
);
const adapterCommand = requiredEnvironment('DKG_RFC64_M1_ADAPTER_COMMAND');
const adapterArgs = parseStringArray(
  process.env['DKG_RFC64_M1_ADAPTER_ARGS_JSON'] ?? '[]',
  'DKG_RFC64_M1_ADAPTER_ARGS_JSON',
);
const adapterCwd = resolve(process.env['DKG_RFC64_M1_ADAPTER_CWD'] ?? repoRoot);
const timeoutMs = parseTimeout(process.env['DKG_RFC64_M1_ADAPTER_TIMEOUT_MS']);

const corpus = readJson(corpusPath) as SelectiveCoverageCorpusV1;
const expectedProvenance = readJson(trustAnchorPath) as ExpectedSelectiveCoverageProvenanceV1;
const sourceCommit = readCleanRepositoryHead(repoRoot);
if (sourceCommit !== expectedProvenance.testedHeadCommit) {
  throw new Error('M1 trust anchor names a different checked-out source commit');
}
runGate2CleanRuntimeBuildV1(repoRoot);
if (readCleanRepositoryHead(repoRoot) !== sourceCommit) {
  throw new Error('M1 source HEAD changed during the clean runtime build');
}
const runtimeManifest = buildGate2RuntimeManifestV1(repoRoot, sourceCommit);
if (runtimeManifest.manifestDigest !== expectedProvenance.runtimeManifestDigest) {
  throw new Error('M1 trust anchor names a different clean runtime manifest');
}

const runtime = new ProcessSelectiveCoverageRuntimeV1({
  command: adapterCommand,
  args: adapterArgs,
  cwd: adapterCwd,
  timeoutMs,
  env: adapterEnvironment(),
});
await runSelectiveCoverageLiveV1({
  collect: () => collectSelectiveCoverageEvidenceV1({
    corpus,
    expectedProvenance,
    runtime,
  }),
  close: () => runtime.close(),
  publish: (evidence) => {
    const bytes = Buffer.from(`${canonicalJson(evidence)}\n`, 'utf8');
    const published = atomicWriteExactBytes(artifactPath, bytes);
    process.stdout.write(
      `[rfc64-m1] PASS ${artifactPath} sha256:${published.sha256}\n`,
    );
  },
});

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function resolveRequiredPath(name: string): string {
  return resolve(requiredEnvironment(name));
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read M1 JSON input: ${path}`, { cause: error });
  }
}

function parseStringArray(value: string, label: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be a JSON string array`, { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`${label} must be a JSON string array`);
  }
  return parsed;
}

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError('DKG_RFC64_M1_ADAPTER_TIMEOUT_MS must be an integer');
  }
  return parsed;
}

function adapterEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
  for (const name of [
    'DKG_RFC64_M1_CORPUS_FILE',
    'DKG_RFC64_M1_TRUST_ANCHOR_FILE',
    'DKG_RFC64_M1_ARTIFACT',
  ]) delete env[name];
  return env;
}
