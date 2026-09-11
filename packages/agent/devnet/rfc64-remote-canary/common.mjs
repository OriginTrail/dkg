// SPDX-License-Identifier: Apache-2.0

import { createHash, randomUUID } from 'node:crypto';

export const CONFIG_SCHEMA = 'dkg-rfc64-remote-canary-config-v1';
export const ARTIFACT_SCHEMA = 'dkg-rfc64-remote-canary-certificate-v1';
export const RPC_EVIDENCE_SCHEMA = 'dkg-rpc-usage-minutes-v1';
export const MAX_HTTP_BODY_BYTES = 1_048_576;
export const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
export const RPC_EVIDENCE_CLOCK_SKEW_MS = 60_000;
export const RPC_EVIDENCE_MAX_PRECEDING_MS = 5 * 60_000;

export class RemoteCanaryError extends Error {
  constructor(code, phase, options = {}) {
    super(code, options);
    this.name = 'RemoteCanaryError';
    this.code = code;
    this.phase = phase;
  }
}

export function failure(code, phase, cause) {
  return new RemoteCanaryError(code, phase, cause === undefined ? {} : { cause });
}

export function invalid(code) {
  throw failure(code, 'config');
}

export function boundedString(value, minimum, maximum, field) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    invalid(field);
  }
  return value;
}

export function canonicalInstant(value) {
  if (typeof value !== 'string') throw failure('rpc-evidence-time-invalid', 'rpc-usage');
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw failure('rpc-evidence-time-invalid', 'rpc-usage');
  }
  return timestamp;
}

export function canonicalChainId(value) {
  const canonical = String(value);
  if (!/^(0|[1-9][0-9]*)$/u.test(canonical)) {
    throw failure('node-chain-id-invalid', 'preflight');
  }
  return canonical;
}

export function assertRecord(value, field, code = 'invalid-config') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw failure(code, code === 'invalid-config' ? 'config' : 'rpc-usage');
  }
  return value;
}

export function assertJsonData(value, field, seen = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    if (seen.has(value)) invalid(`${field}-circular`);
    seen.add(value);
    for (const entry of value) assertJsonData(entry, field, seen);
    seen.delete(value);
    return;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) invalid(`${field}-circular`);
    seen.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (key.length > 256) invalid(`${field}-key-too-long`);
      assertJsonData(entry, field, seen);
    }
    seen.delete(value);
    return;
  }
  invalid(`${field}-not-json`);
}

export function jsonPointer(value, pointer) {
  return pointer.split('/').slice(1).reduce((current, token) => {
    if (current === null || typeof current !== 'object') return undefined;
    const decoded = token.replaceAll('~1', '/').replaceAll('~0', '~');
    return current[decoded];
  }, value);
}

export function createMarker() {
  const nonce = randomUUID();
  return Object.freeze({
    assetName: `rfc64-canary-${nonce}`,
    subject: `urn:dkg:rfc64-canary:${nonce}`,
    predicate: 'https://schema.origintrail.io/rfc64/canaryValue',
    value: nonce,
  });
}

export function opaqueRef(namespace, value) {
  return `${namespace}:${createHash('sha256').update(String(value)).digest('hex').slice(0, 20)}`;
}

export function round(value) {
  return Math.round(value * 1_000) / 1_000;
}
