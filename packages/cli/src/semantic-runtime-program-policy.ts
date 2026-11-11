import { createHash } from 'node:crypto';

import type { SemanticDisclosurePolicy, SemanticProgramPolicy } from '@origintrail-official/dkg-semantic-runtime';

import type { SafeLlmChildResult, SafeLlmProgram } from './semantic-runtime-safe-llm-adapter.js';
import { validateSemanticQueryPins } from './semantic-runtime-query-pins.js';

type JsonObject = Record<string, unknown>;
const HASH = /^[0-9a-f]{64}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_BYTES = 1_048_576;
const MAX_RELEASE_BYTES = 65_536;

/** Only trusted node configuration can install this policy. */
export function validateSemanticProgramPolicy(config: SemanticProgramPolicy): void {
  if (!isObject(config)) throw new Error('INVALID_SEMANTIC_PROGRAM_POLICY');
  if (!Array.isArray(config.contextGraphIds) || config.contextGraphIds.length < 1 || config.contextGraphIds.length > 128
    || config.contextGraphIds.some((graph) => !shortString(graph))) throw new Error('INVALID_SEMANTIC_GRAPH_SCOPE');
  if (!Array.isArray(config.programs) || config.programs.length < 1 || config.programs.length > 128
    || config.programs.some((pin) => !isObject(pin) || !shortString(pin.programIri) || !HASH.test(pin.sourceHash))
    || new Set(config.programs.map((pin) => pin.programIri)).size !== config.programs.length) {
    throw new Error('INVALID_SEMANTIC_PROGRAM_PINS');
  }
  for (const pin of config.programs) if (pin.queries !== undefined) validateSemanticQueryPins(pin.queries);
  const egress = config.disclosure;
  if (egress === undefined) return;
  if (!isObject(egress) || !shortString(egress.policyId)
    || !Array.isArray(egress.promptSha256s) || egress.promptSha256s.length < 1
    || egress.promptSha256s.length > 128 || egress.promptSha256s.some((hash) => !HASH.test(hash))
    || !Array.isArray(egress.programs) || egress.programs.length > 32) {
    throw new Error('INVALID_SEMANTIC_DISCLOSURE_POLICY');
  }
  for (const release of egress.programs) {
    if (!isObject(release) || !config.programs.some((pin) => pin.programIri === release.programIri && pin.sourceHash === release.sourceHash)
      || !Array.isArray(release.outputIndexes) || release.outputIndexes.length < 1 || release.outputIndexes.length > 32
      || release.outputIndexes.some((index) => !safeInteger(index, 0, 1023))
      || new Set(release.outputIndexes).size !== release.outputIndexes.length
      || (release.allowedJsonPointers !== undefined && (!Array.isArray(release.allowedJsonPointers)
        || release.allowedJsonPointers.length < 1 || release.allowedJsonPointers.length > 32
        || release.allowedJsonPointers.some((pointer) => !validPointer(pointer))))) {
      throw new Error('INVALID_SEMANTIC_OUTPUT_PROJECTION');
    }
  }
  if (new Set(egress.programs.map((release) => release.programIri)).size !== egress.programs.length) {
    throw new Error('DUPLICATE_SEMANTIC_OUTPUT_PROJECTION');
  }
}

export function assertSemanticPrompt(policy: SemanticDisclosurePolicy, prompt: string): void {
  if (!policy.promptSha256s.includes(sha256(prompt))) throw new Error('SEMANTIC_PROMPT_NOT_PINNED');
}

export function projectSemanticOutput(policy: SemanticDisclosurePolicy, program: SafeLlmProgram, result: SafeLlmChildResult): string {
  const release = policy.programs.find((release) => release.programIri === program.programIri && release.sourceHash === program.sourceHash);
  if (!release || !Array.isArray(result.outputs)) throw new Error('SEMANTIC_OUTPUT_RELEASE_DENIED');
  const outputs = release.outputIndexes.map((index) => {
    const raw = result.outputs![index];
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BYTES) throw new Error('SEMANTIC_OUTPUT_RELEASE_DENIED');
    if (!release.allowedJsonPointers) return raw;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error('SEMANTIC_OUTPUT_RELEASE_DENIED'); }
    // A pointer->value projection cannot accidentally reproduce unselected siblings.
    return Object.fromEntries(release.allowedJsonPointers.map((pointer) => [pointer, atPointer(parsed, pointer)]));
  });
  const released = canonical({ outputs });
  if (Buffer.byteLength(released) > MAX_RELEASE_BYTES) throw new Error('SEMANTIC_RELEASE_TOO_LARGE');
  return released;
}

function validPointer(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value.length <= 512
    && !/~(?:[^01]|$)/.test(value) && value.slice(1).split('/').every((part) => !DANGEROUS_KEYS.has(part.replace(/~1/g, '/').replace(/~0/g, '~')));
}

function atPointer(value: unknown, pointer: string): unknown {
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
      throw new Error('SEMANTIC_OUTPUT_RELEASE_DENIED');
    }
    value = (value as JsonObject)[key];
  }
  // A schema change from an aggregate scalar to a container must not expand
  // the data-release grant to every private field nested under that pointer.
  if (value !== null && typeof value === 'object') throw new Error('SEMANTIC_OUTPUT_RELEASE_DENIED');
  return value;
}

function isObject(value: unknown): value is JsonObject { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function shortString(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 2048; }
function safeInteger(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
