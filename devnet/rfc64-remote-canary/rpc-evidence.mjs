// SPDX-License-Identifier: Apache-2.0

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { failure } from './errors.mjs';
import { RPC_USAGE_EVIDENCE_SCHEMA_V1 } from './schemas.mjs';

/** @typedef {import('./domain-contract.js').CanaryCommandResultV1} CanaryCommandResultV1 */
/** @typedef {import('./domain-contract.js').NormalizedCanaryRpcUsageV1} NormalizedCanaryRpcUsageV1 */
/** @typedef {import('./domain-contract.js').RpcUsageSampleV1} RpcUsageSampleV1 */
/** @typedef {import('./domain-contract.js').RpcUsageEvidenceV1} RpcUsageEvidenceV1 */
/** @typedef {Readonly<{ readFileFn: (path: string, encoding: BufferEncoding) => Promise<string>, runCommand: (command: import('./domain-contract.js').CanaryCommandV1, timeoutMs?: number) => Promise<CanaryCommandResultV1>, startedAt: string, observedAt: string, expectedCommit: string, cohortRef: string }>} RpcEvidenceContextV1 */

const MAX_RPC_EVIDENCE_BYTES = 1_048_576;
const RPC_EVIDENCE_CLOCK_SKEW_MS = 60_000;
const RPC_EVIDENCE_MAX_PRECEDING_MS = 5 * 60_000;
const RPC_EVIDENCE_SCHEMA = 'dkg-rpc-usage-minutes-v1';

// @ts-expect-error Runtime ESM interop is covered by the evidence tests.
const rpcSchemaValidator = new Ajv2020({ allErrors: false, strict: true });
// @ts-expect-error Runtime ESM interop is covered by the evidence tests.
addFormats(rpcSchemaValidator);
/** @type {import('ajv').ValidateFunction<RpcUsageEvidenceV1>} */
const matchesRpcEvidenceV1 = rpcSchemaValidator.compile(RPC_USAGE_EVIDENCE_SCHEMA_V1);

/** @param {NormalizedCanaryRpcUsageV1} config @param {RpcEvidenceContextV1} context @returns {Promise<import('./domain-contract.js').RemoteCanaryRpcUsageResultV1>} */
export async function collectRpcUsageEvidenceV1(config, context) {
  if (config.kind === 'required') {
    return Object.freeze({
      status: 'EVIDENCE_REQUIRED',
      requirement: RPC_EVIDENCE_SCHEMA,
      acceptedSources: Object.freeze(/** @type {const} */ (['evidence-file', 'command'])),
    });
  }
  let text = '';
  if (config.kind === 'evidence-file') {
    text = await context.readFileFn(config.path, 'utf8').catch(() => {
      throw failure('rpc-evidence-read-failed', 'evidence');
    });
  } else {
    const result = await context.runCommand(config.command, config.commandTimeoutMs);
    if (result.code !== 0) throw failure('rpc-evidence-command-failed', 'evidence');
    text = result.stdout;
  }
  if (Buffer.byteLength(text) > MAX_RPC_EVIDENCE_BYTES) {
    throw failure('rpc-evidence-too-large', 'evidence');
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
    if (!matchesRpcEvidenceV1(parsed)) throw new Error('rpc-evidence-malformed');
  } catch {
    throw failure('rpc-evidence-malformed', 'evidence');
  }
  const evidence = /** @type {RpcUsageEvidenceV1} */ (parsed);
  const samples = validateRpcEvidenceV1(evidence, config.minimumSamples, context);
  /** @type {Map<string, number>} */
  const byMethod = new Map();
  let total = 0;
  let durationSeconds = 0;
  for (const sample of samples) {
    total = checkedRpcCountAddV1(total, sample.total);
    durationSeconds += (Date.parse(sample.windowEndedAt) - Date.parse(sample.windowStartedAt)) / 1000;
    for (const [method, count] of Object.entries(sample.byMethod)) {
      byMethod.set(method, checkedRpcCountAddV1(byMethod.get(method) ?? 0, count));
    }
  }
  const firstSample = samples[0];
  const lastSample = samples.at(-1);
  if (firstSample === undefined || lastSample === undefined) {
    throw failure('rpc-evidence-sample-count', 'evidence');
  }
  return Object.freeze({
    status: 'PASS',
    source: config.kind,
    cohortRef: context.cohortRef,
    windowStartedAt: firstSample.windowStartedAt,
    windowEndedAt: lastSample.windowEndedAt,
    sampleCount: samples.length,
    measuredSeconds: durationSeconds,
    total,
    requestsPerMinute: durationSeconds === 0 ? 0 : round(total * 60 / durationSeconds),
    byMethod: Object.freeze(Object.fromEntries([...byMethod.entries()].sort())),
  });
}

/**
 * @param {RpcUsageEvidenceV1} evidence
 * @param {number} minimumSamples
 * @param {RpcEvidenceContextV1} context
 * @returns {readonly RpcUsageSampleV1[]}
 */
export function validateRpcEvidenceV1(evidence, minimumSamples, context) {
  if (evidence.expectedCommit.toLowerCase() !== context.expectedCommit) {
    throw failure('rpc-evidence-commit-mismatch', 'evidence');
  }
  if (evidence.cohortRef !== context.cohortRef) {
    throw failure('rpc-evidence-cohort-mismatch', 'evidence');
  }
  if (evidence.samples.length < minimumSamples) {
    throw failure('rpc-evidence-sample-count', 'evidence');
  }
  let precedingEnd = -Infinity;
  const samples = evidence.samples.map((sample) => {
    const start = canonicalInstant(sample.windowStartedAt);
    const end = canonicalInstant(sample.windowEndedAt);
    const durationMs = end - start;
    if (durationMs < 45_000 || durationMs > 75_000 || start < precedingEnd) {
      throw failure('rpc-evidence-window-not-minutely', 'evidence');
    }
    precedingEnd = end;
    assertRpcCountV1(sample.total);
    let methodTotal = 0;
    for (const count of Object.values(sample.byMethod)) {
      assertRpcCountV1(count);
      methodTotal = checkedRpcCountAddV1(methodTotal, count);
    }
    if (methodTotal !== sample.total) throw failure('rpc-evidence-total-mismatch', 'evidence');
    return sample;
  });
  const runStart = Date.parse(context.startedAt);
  const observed = Date.parse(context.observedAt);
  const firstSample = samples[0];
  const lastSample = samples.at(-1);
  if (firstSample === undefined || lastSample === undefined) {
    throw failure('rpc-evidence-sample-count', 'evidence');
  }
  const earliest = Date.parse(firstSample.windowStartedAt);
  const latestStart = Date.parse(lastSample.windowStartedAt);
  const latest = Date.parse(lastSample.windowEndedAt);
  if (latest < runStart - RPC_EVIDENCE_MAX_PRECEDING_MS) {
    throw failure('rpc-evidence-stale', 'evidence');
  }
  if (earliest > observed + RPC_EVIDENCE_CLOCK_SKEW_MS || latest > observed + RPC_EVIDENCE_CLOCK_SKEW_MS) {
    throw failure('rpc-evidence-future', 'evidence');
  }
  if (latestStart > runStart) {
    throw failure('rpc-evidence-window-not-bound-to-run', 'evidence');
  }
  return samples;
}

/** @param {number} value */
function assertRpcCountV1(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw failure('rpc-evidence-count-out-of-range', 'evidence');
  }
}

/** @param {unknown} value @returns {number} */
function canonicalInstant(value) {
  if (typeof value !== 'string') throw failure('rpc-evidence-time-invalid', 'evidence');
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw failure('rpc-evidence-time-invalid', 'evidence');
  }
  return timestamp;
}

/** @param {number} value @returns {number} */
function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

/** @param {number} left @param {number} right @returns {number} */
function checkedRpcCountAddV1(left, right) {
  assertRpcCountV1(left);
  assertRpcCountV1(right);
  if (left > Number.MAX_SAFE_INTEGER - right) {
    throw failure('rpc-evidence-count-overflow', 'evidence');
  }
  return left + right;
}
