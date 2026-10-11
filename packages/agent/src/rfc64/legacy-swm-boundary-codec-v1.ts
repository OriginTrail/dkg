// SPDX-License-Identifier: Apache-2.0
import {
  assertCanonicalDeterministicUalV1,
  assertCanonicalDecimalU64,
  assertContextGraphIdV1,
  assertSwmAuthorInventoryShareOperationIdV1,
  type CanonicalDeterministicUalV1,
  type ContextGraphIdV1,
  type PositiveDecimalU64V1,
} from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';

export const RFC64_LEGACY_SWM_HEAD_LIMIT_V1 = 100_000;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface Rfc64LegacySwmBoundaryEntryV1 {
  readonly contextGraphId: ContextGraphIdV1;
  readonly kaUal: CanonicalDeterministicUalV1;
}

export interface Rfc64LegacySwmBoundaryCaptureV1 {
  readonly version: 1;
  readonly entries: readonly Rfc64LegacySwmBoundaryEntryV1[];
}

interface Rfc64LegacySwmRepublishedMarkerV1
  extends Rfc64LegacySwmBoundaryEntryV1 {
  readonly version: 1;
}

export interface Rfc64LateLegacySwmBoundaryEntryV1
  extends Rfc64LegacySwmBoundaryEntryV1 {
  readonly version: 1;
  readonly shareOperationId: string;
  readonly assertionVersion: PositiveDecimalU64V1;
}

export function decodeRfc64BindingValueV1(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const literal = parseRdfLiteralTerm(raw);
  if (literal === null) {
    throw new Error('RFC-64 legacy SWM boundary contains a malformed RDF literal');
  }
  return literal.value;
}

export function encodeRfc64LegacySwmBoundaryCaptureV1(
  capture: Readonly<Rfc64LegacySwmBoundaryCaptureV1>,
): Uint8Array {
  return UTF8_ENCODER.encode(`${JSON.stringify(capture)}\n`);
}

export function parseRfc64LegacySwmBoundaryCaptureV1(
  bytes: Uint8Array,
): Readonly<Rfc64LegacySwmBoundaryCaptureV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_DECODER.decode(bytes));
  } catch (cause) {
    throw new Error('RFC-64 legacy SWM boundary capture is not valid JSON', { cause });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RFC-64 legacy SWM boundary capture is malformed');
  }
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).sort().join('\n') !== 'entries\nversion' || value.version !== 1) {
    throw new Error('RFC-64 legacy SWM boundary capture has unknown fields or version');
  }
  if (!Array.isArray(value.entries) || value.entries.length > RFC64_LEGACY_SWM_HEAD_LIMIT_V1) {
    throw new Error('RFC-64 legacy SWM boundary capture has an invalid entry set');
  }
  const entries = value.entries.map((raw): Rfc64LegacySwmBoundaryEntryV1 => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('RFC-64 legacy SWM boundary entry is malformed');
    }
    const entry = raw as Record<string, unknown>;
    if (
      Object.keys(entry).sort().join('\n') !== 'contextGraphId\nkaUal'
      || typeof entry.contextGraphId !== 'string'
      || typeof entry.kaUal !== 'string'
    ) {
      throw new Error('RFC-64 legacy SWM boundary entry has unknown fields');
    }
    assertContextGraphIdV1(
      entry.contextGraphId,
      'RFC-64 legacy SWM boundary contextGraphId',
    );
    return Object.freeze({
      contextGraphId: entry.contextGraphId,
      kaUal: assertCanonicalDeterministicUalV1(entry.kaUal).ual,
    });
  });
  const sorted = [...entries].sort(compareEntries);
  if (
    sorted.some((entry, index) => compareEntries(entry, entries[index]!) !== 0)
    || sorted.some((entry, index) => index > 0 && compareEntries(entry, sorted[index - 1]!) === 0)
  ) {
    throw new Error('RFC-64 legacy SWM boundary entries are duplicate or non-canonical');
  }
  return Object.freeze({ version: 1, entries: Object.freeze(entries) });
}

export function encodeRfc64LegacySwmRepublishedMarkerV1(
  entry: Readonly<Rfc64LegacySwmBoundaryEntryV1>,
): Uint8Array {
  const marker: Rfc64LegacySwmRepublishedMarkerV1 = Object.freeze({
    version: 1,
    contextGraphId: entry.contextGraphId,
    kaUal: entry.kaUal,
  });
  return UTF8_ENCODER.encode(`${JSON.stringify(marker)}\n`);
}

export function encodeRfc64LateLegacySwmBoundaryEntryV1(
  entry: Readonly<Rfc64LateLegacySwmBoundaryEntryV1>,
): string {
  return JSON.stringify({
    version: 1,
    contextGraphId: entry.contextGraphId,
    kaUal: entry.kaUal,
    shareOperationId: entry.shareOperationId,
    assertionVersion: entry.assertionVersion,
  });
}

export function parseRfc64LateLegacySwmBoundaryEntryV1(
  encoded: string,
): Readonly<Rfc64LateLegacySwmBoundaryEntryV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (cause) {
    throw new Error('RFC-64 late legacy SWM boundary marker is not valid JSON', { cause });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('RFC-64 late legacy SWM boundary marker is malformed');
  }
  const value = parsed as Record<string, unknown>;
  if (
    Object.keys(value).sort().join('\n')
      !== 'assertionVersion\ncontextGraphId\nkaUal\nshareOperationId\nversion'
    || value.version !== 1
    || typeof value.contextGraphId !== 'string'
    || typeof value.kaUal !== 'string'
    || typeof value.shareOperationId !== 'string'
    || typeof value.assertionVersion !== 'string'
  ) {
    throw new Error('RFC-64 late legacy SWM boundary marker has unknown fields');
  }
  assertContextGraphIdV1(
    value.contextGraphId,
    'RFC-64 late legacy SWM boundary contextGraphId',
  );
  const entry = Object.freeze({
    version: 1,
    contextGraphId: value.contextGraphId,
    kaUal: assertCanonicalDeterministicUalV1(value.kaUal).ual,
    shareOperationId: value.shareOperationId,
    assertionVersion: assertPositiveDecimalU64V1(value.assertionVersion),
  } satisfies Rfc64LateLegacySwmBoundaryEntryV1);
  assertSwmAuthorInventoryShareOperationIdV1(entry.shareOperationId);
  if (encoded !== encodeRfc64LateLegacySwmBoundaryEntryV1(entry)) {
    throw new Error('RFC-64 late legacy SWM boundary marker is not canonical');
  }
  return entry;
}

export function compareEntries(
  left: Readonly<Rfc64LegacySwmBoundaryEntryV1>,
  right: Readonly<Rfc64LegacySwmBoundaryEntryV1>,
): number {
  return left.contextGraphId.localeCompare(right.contextGraphId)
    || left.kaUal.localeCompare(right.kaUal);
}

export function compareLateEntries(
  left: Readonly<Rfc64LateLegacySwmBoundaryEntryV1>,
  right: Readonly<Rfc64LateLegacySwmBoundaryEntryV1>,
): number {
  return compareEntries(left, right)
    || left.shareOperationId.localeCompare(right.shareOperationId);
}

export function assertPositiveDecimalU64V1(input: string): PositiveDecimalU64V1 {
  assertCanonicalDecimalU64(input, 'RFC-64 legacy SWM assertionVersion');
  if (BigInt(input) < 1n) {
    throw new Error('RFC-64 legacy SWM assertionVersion must be positive');
  }
  return input as PositiveDecimalU64V1;
}
