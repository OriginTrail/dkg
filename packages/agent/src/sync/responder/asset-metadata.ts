import { compareCodePoint } from '@origintrail-official/dkg-core';
import {
  parseConfirmedGraphKnowledgeAssetMetadataEnvelope,
  type ConfirmedGraphKnowledgeAssetMetadataRead,
} from '@origintrail-official/dkg-publisher';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const ENCODER = new TextEncoder();
const ACCESS_POLICY = 'http://dkg.io/ontology/accessPolicy';

export interface ResponderAssetMetadataBinding {
  readonly predicate: string;
  readonly object: string;
}

export interface ResponderAssetMetadata {
  readonly bindings: readonly ResponderAssetMetadataBinding[];
  /** Covers every raw metadata row, including policy and unknown predicates. */
  readonly identity: string;
  readonly confirmed: ConfirmedGraphKnowledgeAssetMetadataRead;
  readonly accessPolicy: 'public' | 'absent' | 'non-public';
}

/** Validate fetched rows and derive their envelope and identity without IO or authority. */
export function parseResponderAssetMetadata(
  rows: readonly unknown[],
  input: { contextGraphId: string; ual: string },
): ResponderAssetMetadata | null {
  const bindings: ResponderAssetMetadataBinding[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object'
      || !('predicate' in row) || typeof row.predicate !== 'string'
      || !('object' in row) || typeof row.object !== 'string') return null;
    bindings.push({ predicate: row.predicate, object: row.object });
  }
  const identity = bytesToHex(sha256(ENCODER.encode(JSON.stringify(bindings
    .map((row) => [row.predicate, row.object])
    .sort((a, b) => compareCodePoint(a[0]!, b[0]!) || compareCodePoint(a[1]!, b[1]!))))));
  const policies = bindings.filter((row) => row.predicate === ACCESS_POLICY);
  const accessPolicy = policies.length === 0 ? 'absent'
    : policies.length === 1 && /^"public"(?:\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#string>)?$/.test(policies[0]!.object)
      ? 'public' : 'non-public';
  return { bindings, identity, accessPolicy,
    confirmed: parseConfirmedGraphKnowledgeAssetMetadataEnvelope(bindings, input) };
}
