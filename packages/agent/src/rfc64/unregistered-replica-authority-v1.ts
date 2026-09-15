// SPDX-License-Identifier: Apache-2.0

import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  MAX_CONTROL_OBJECT_BYTES,
  assertSafeIri,
  canonicalizeSignedContextGraphPolicyEnvelopeBytesV1,
  contextGraphDataGraphUri,
  computeContextGraphPolicyObjectDigestV1,
  parseCanonicalSignedContextGraphPolicyEnvelopeV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type NetworkIdV1,
  type UnsignedContextGraphPolicyEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  verifyControlEnvelopeIssuerSignatureV1,
} from '@origintrail-official/dkg-chain';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  composeRfc64UnregisteredCatalogAuthorityV1,
  type Rfc64ReleaseNativeAuthoritySnapshotV1,
  type Rfc64UnregisteredAuthorityInputV1,
} from './release-native-catalog-authority-v1.js';
import {
  signAndVerifyRfc64ControlEnvelopeV1,
  type Rfc64ControlEnvelopeEip191SignerV1,
} from './control-envelope-signer-v1.js';

/**
 * Public ontology carrier for an owner-signed, graph-bound unregistered
 * authority generation. The literal is canonical signed-envelope bytes encoded
 * as unpadded base64url, so it remains an RDF-safe scalar across gossip and
 * ordinary ontology sync.
 */
export const RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1 =
  'https://dkg.network/ontology#rfc64UnregisteredReplicaAuthorityV1';

const MAX_AUTHORITY_EVIDENCE_ROWS_V1 = 32;
const MAX_AUTHORITY_EVIDENCE_BASE64URL_CHARS_V1 =
  Math.ceil(MAX_CONTROL_OBJECT_BYTES * 4 / 3) + 4;
const EVM_ADDRESS_PREFIXED_CONTEXT_GRAPH_V1 = /^(0x[0-9a-f]{40})(?:\/|$)/iu;
const BASE64URL_V1 = /^[A-Za-z0-9_-]+$/u;

export interface MintRfc64UnregisteredReplicaAuthorityEvidenceInputV1
  extends Rfc64UnregisteredAuthorityInputV1 {
  readonly signer: Rfc64ControlEnvelopeEip191SignerV1;
}

/** Mint the standard RFC-64 policy object used as durable replica evidence. */
export async function mintRfc64UnregisteredReplicaAuthorityEvidenceV1(
  input: MintRfc64UnregisteredReplicaAuthorityEvidenceInputV1,
): Promise<string> {
  const authority = composeRfc64UnregisteredCatalogAuthorityV1(input);
  const unsigned = Object.freeze({
    issuer: input.ownerAddress,
    objectType: CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
    payload: authority.policy,
    signatureEvidence: Object.freeze({ kind: 'none' as const }),
    signatureSuite: 'eip191-personal-sign-digest-v1' as const,
  }) as unknown as UnsignedContextGraphPolicyEnvelopeV1;
  const objectDigest = computeContextGraphPolicyObjectDigestV1(unsigned);
  const signed = await signAndVerifyRfc64ControlEnvelopeV1(
    unsigned,
    objectDigest,
    input.signer,
  );
  const canonical = canonicalizeSignedContextGraphPolicyEnvelopeBytesV1(
    signed.envelope,
  );
  return Buffer.from(canonical).toString('base64url');
}

/**
 * Load and authenticate replica evidence. This proves only the unregistered
 * policy generation; callers MUST separately prove finalized on-chain absence
 * before accepting it.
 */
export async function loadRfc64UnregisteredReplicaAuthorityV1(input: Readonly<{
  readonly store: TripleStore;
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly signal?: AbortSignal;
}>): Promise<Rfc64ReleaseNativeAuthoritySnapshotV1 | null> {
  const expectedOwner = input.contextGraphId
    .match(EVM_ADDRESS_PREFIXED_CONTEXT_GRAPH_V1)?.[1]?.toLowerCase();
  // Only wallet-namespaced CG IDs have an independently checkable owner before
  // registration. A signature cannot safely self-assign ownership of an
  // arbitrary global name.
  if (expectedOwner === undefined) return null;

  const graph = contextGraphDataGraphUri('ontology');
  const subject = contextGraphDataGraphUri(input.contextGraphId);
  const result = await input.store.query(
    `SELECT ?evidence WHERE { GRAPH <${assertSafeIri(graph)}> { ` +
    `<${assertSafeIri(subject)}> ` +
    `<${RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1}> ?evidence . ` +
    `FILTER(isLiteral(?evidence)) } } ` +
    `ORDER BY STR(?evidence) LIMIT ${MAX_AUTHORITY_EVIDENCE_ROWS_V1 + 1}`,
    { source: 'agent.rfc64.unregisteredReplicaAuthority', signal: input.signal },
  );
  if (result.type !== 'bindings' || result.bindings.length === 0) return null;
  if (result.bindings.length > MAX_AUTHORITY_EVIDENCE_ROWS_V1) {
    throw new Error('RFC-64 unregistered replica authority evidence exceeds its row bound');
  }

  const accepted = new Map<string, Rfc64ReleaseNativeAuthoritySnapshotV1>();
  for (const row of result.bindings) {
    if (input.signal?.aborted) throw input.signal.reason;
    const encoded = parseBase64UrlLiteralV1(row['evidence']);
    if (encoded === null) continue;
    let canonical: Uint8Array;
    try {
      canonical = decodeCanonicalBase64UrlV1(encoded);
    } catch {
      continue;
    }
    try {
      const envelope = parseCanonicalSignedContextGraphPolicyEnvelopeV1(canonical);
      await verifyControlEnvelopeIssuerSignatureV1(envelope, { signal: input.signal });
      const owner = envelope.issuer.toLowerCase();
      const policy = envelope.payload;
      if (
        owner !== expectedOwner
        || policy.networkId !== input.networkId
        || policy.contextGraphId !== input.contextGraphId
        || policy.source.kind !== 'owner-signed-unregistered'
        || policy.source.ownerAddress !== owner
        || policy.source.ownerAuthorityEra !== '0'
        || policy.governanceChainId !== null
        || policy.governanceContractAddress !== null
        || policy.ownershipTransitionDigest !== null
        || policy.era !== '0'
        || policy.version !== '0'
        || policy.previousPolicyDigest !== null
        || policy.accessPolicy !== 0
      ) continue;
      const snapshot = Object.freeze({
        policy,
        policyDigest: envelope.objectDigest as Digest32V1,
        roster: null,
        source: 'owner-signed-unregistered' as const,
      });
      accepted.set(envelope.objectDigest, snapshot);
    } catch {
      // Unauthenticated, malformed, wrong-owner, wrong-network and replayed
      // cross-CG values are inert ontology data, never authority.
    }
  }
  if (accepted.size === 0) return null;
  if (accepted.size !== 1) {
    throw new Error('RFC-64 unregistered replica authority has conflicting signed generations');
  }
  return accepted.values().next().value ?? null;
}

function parseBase64UrlLiteralV1(value: string | undefined): string | null {
  if (value === undefined) return null;
  const lexical = value.match(/^"([A-Za-z0-9_-]+)"(?:\^\^<[^>]+>)?$/u)?.[1];
  if (
    lexical === undefined
    || lexical.length === 0
    || lexical.length > MAX_AUTHORITY_EVIDENCE_BASE64URL_CHARS_V1
    || !BASE64URL_V1.test(lexical)
  ) return null;
  return lexical;
}

function decodeCanonicalBase64UrlV1(encoded: string): Uint8Array {
  const decoded = Buffer.from(encoded, 'base64url');
  if (
    decoded.byteLength === 0
    || decoded.byteLength > MAX_CONTROL_OBJECT_BYTES
    || decoded.toString('base64url') !== encoded
  ) {
    throw new Error('RFC-64 replica authority evidence is not canonical base64url');
  }
  return decoded;
}
