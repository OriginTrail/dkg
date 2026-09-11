// SPDX-License-Identifier: Apache-2.0

import {
  MAX_COMMAND_OUTPUT_BYTES,
  RPC_EVIDENCE_CLOCK_SKEW_MS,
  RPC_EVIDENCE_MAX_PRECEDING_MS,
  RPC_EVIDENCE_SCHEMA,
  canonicalInstant,
  failure,
  round,
} from './common.mjs';
import { assertRpcEvidenceShapeV1 } from './config.mjs';

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
      throw failure('rpc-evidence-read-failed', 'rpc-usage');
    });
  } else {
    const result = await context.runCommand(config.command, config.commandTimeoutMs);
    if (result.code !== 0) throw failure('rpc-evidence-command-failed', 'rpc-usage');
    text = result.stdout;
  }
  if (Buffer.byteLength(text) > MAX_COMMAND_OUTPUT_BYTES) {
    throw failure('rpc-evidence-too-large', 'rpc-usage');
  }
  let evidence;
  try {
    evidence = JSON.parse(text);
    assertRpcEvidenceShapeV1(evidence);
  } catch {
    throw failure('rpc-evidence-malformed', 'rpc-usage');
  }
  const samples = validateRpcEvidenceV1(evidence, config.minimumSamples, context);
  const byMethod = {};
  let total = 0;
  let durationSeconds = 0;
  for (const sample of samples) {
    total += sample.total;
    durationSeconds += (Date.parse(sample.windowEndedAt) - Date.parse(sample.windowStartedAt)) / 1000;
    for (const [method, count] of Object.entries(sample.byMethod)) {
      byMethod[method] = (byMethod[method] ?? 0) + count;
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
    throw failure('rpc-evidence-commit-mismatch', 'rpc-usage');
  }
  if (evidence.cohortRef !== context.cohortRef) {
    throw failure('rpc-evidence-cohort-mismatch', 'rpc-usage');
  }
  if (evidence.samples.length < minimumSamples) {
    throw failure('rpc-evidence-sample-count', 'rpc-usage');
  }
  let precedingEnd = -Infinity;
  const samples = evidence.samples.map((sample) => {
    const start = canonicalInstant(sample.windowStartedAt);
    const end = canonicalInstant(sample.windowEndedAt);
    const durationMs = end - start;
    if (durationMs < 45_000 || durationMs > 75_000 || start < precedingEnd) {
      throw failure('rpc-evidence-window-not-minutely', 'rpc-usage');
    }
    precedingEnd = end;
    const methodTotal = Object.values(sample.byMethod).reduce((sum, count) => sum + count, 0);
    if (methodTotal !== sample.total) throw failure('rpc-evidence-total-mismatch', 'rpc-usage');
    return sample;
  });
  const runStart = Date.parse(context.startedAt);
  const observed = Date.parse(context.observedAt);
  const earliest = Date.parse(samples[0].windowStartedAt);
  const latest = Date.parse(samples.at(-1).windowEndedAt);
  if (latest < runStart - RPC_EVIDENCE_MAX_PRECEDING_MS) {
    throw failure('rpc-evidence-stale', 'rpc-usage');
  }
  if (earliest > observed + RPC_EVIDENCE_CLOCK_SKEW_MS || latest > observed + RPC_EVIDENCE_CLOCK_SKEW_MS) {
    throw failure('rpc-evidence-future', 'rpc-usage');
  }
  return samples;
}
