// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { failure } from './errors.mjs';

const MAX_RPC_EVIDENCE_BYTES = 1_048_576;
const RPC_EVIDENCE_CLOCK_SKEW_MS = 60_000;
const RPC_EVIDENCE_MAX_PRECEDING_MS = 5 * 60_000;
const RPC_EVIDENCE_SCHEMA = 'dkg-rpc-usage-minutes-v1';

const rpcEvidenceSchema = JSON.parse(readFileSync(
  new URL('./rpc-usage-evidence.schema.json', import.meta.url),
  'utf8',
));
const rpcSchemaValidator = new Ajv2020({ allErrors: false, strict: true });
addFormats(rpcSchemaValidator);
const matchesRpcEvidenceV1 = rpcSchemaValidator.compile(rpcEvidenceSchema);

export async function collectRpcUsageEvidenceV1(config, context) {
  if (config.kind === 'required') {
    return Object.freeze({
      status: 'EVIDENCE_REQUIRED',
      requirement: RPC_EVIDENCE_SCHEMA,
      acceptedSources: Object.freeze(['evidence-file', 'command']),
    });
  }
  let text;
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
  let evidence;
  try {
    evidence = JSON.parse(text);
    if (!matchesRpcEvidenceV1(evidence)) throw new Error('rpc-evidence-malformed');
  } catch {
    throw failure('rpc-evidence-malformed', 'evidence');
  }
  const samples = validateRpcEvidenceV1(evidence, config.minimumSamples, context);
  const byMethod = {};
  let total = 0;
  let durationSeconds = 0;
  for (const sample of samples) {
    total = checkedRpcCountAddV1(total, sample.total);
    durationSeconds += (Date.parse(sample.windowEndedAt) - Date.parse(sample.windowStartedAt)) / 1000;
    for (const [method, count] of Object.entries(sample.byMethod)) {
      byMethod[method] = checkedRpcCountAddV1(byMethod[method] ?? 0, count);
    }
  }
  return Object.freeze({
    status: 'PASS',
    source: config.kind,
    cohortRef: context.cohortRef,
    windowStartedAt: samples[0].windowStartedAt,
    windowEndedAt: samples.at(-1).windowEndedAt,
    sampleCount: samples.length,
    measuredSeconds: durationSeconds,
    total,
    requestsPerMinute: durationSeconds === 0 ? 0 : round(total * 60 / durationSeconds),
    byMethod: Object.freeze(Object.fromEntries(Object.entries(byMethod).sort())),
  });
}

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
  const earliest = Date.parse(samples[0].windowStartedAt);
  const latest = Date.parse(samples.at(-1).windowEndedAt);
  if (latest < runStart - RPC_EVIDENCE_MAX_PRECEDING_MS) {
    throw failure('rpc-evidence-stale', 'evidence');
  }
  if (earliest > observed + RPC_EVIDENCE_CLOCK_SKEW_MS || latest > observed + RPC_EVIDENCE_CLOCK_SKEW_MS) {
    throw failure('rpc-evidence-future', 'evidence');
  }
  return samples;
}

function assertRpcCountV1(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw failure('rpc-evidence-count-out-of-range', 'evidence');
  }
}

function canonicalInstant(value) {
  if (typeof value !== 'string') throw failure('rpc-evidence-time-invalid', 'evidence');
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw failure('rpc-evidence-time-invalid', 'evidence');
  }
  return timestamp;
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

function checkedRpcCountAddV1(left, right) {
  assertRpcCountV1(left);
  assertRpcCountV1(right);
  if (left > Number.MAX_SAFE_INTEGER - right) {
    throw failure('rpc-evidence-count-overflow', 'evidence');
  }
  return left + right;
}
