// SPDX-License-Identifier: Apache-2.0

import {
  CONTEXT_GRAPH_POLICY_OBJECT_TYPE_V1,
  assertSafeIri,
  canonicalizeSignedContextGraphPolicyEnvelopeBytesV1,
  contextGraphDataGraphUri,
  computeContextGraphPolicyObjectDigestV1,
  parseCanonicalSignedContextGraphPolicyEnvelopeV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type SignedContextGraphPolicyEnvelopeV1,
  type UnsignedContextGraphPolicyEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  verifyControlEnvelopeIssuerSignatureV1,
  type VerifiedControlEnvelopeIssuerSignatureV1,
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
import {
  RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1,
  resolveRfc64WalletNamespaceOwnerV1,
} from './unregistered-authority-seed-store-v1.js';

/**
 * DEPRECATED public ontology carrier for an owner-signed, graph-bound
 * unregistered authority generation. The literal is canonical signed-envelope
 * bytes encoded as unpadded base64url, so it remains an RDF-safe scalar across
 * gossip and ordinary ontology sync. The ontology system graph is being retired
 * as a carrier; the keyed seed store (`unregistered-authority-seed-store-v1`)
 * is the primary replica read path and this predicate stays only so older
 * peers and pre-migration replicas can still authenticate a seed.
 */
export const RFC64_UNREGISTERED_REPLICA_AUTHORITY_PREDICATE_V1 =
  'https://dkg.network/ontology#rfc64UnregisteredReplicaAuthorityV1';

const MAX_AUTHORITY_EVIDENCE_ROWS_V1 = 32;
const MAX_AUTHORITY_EVIDENCE_BASE64URL_CHARS_V1 =
  Math.ceil(RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1 * 4 / 3) + 4;
const BASE64URL_V1 = /^[A-Za-z0-9_-]+$/u;

export interface MintRfc64UnregisteredReplicaAuthorityEvidenceInputV1
  extends Rfc64UnregisteredAuthorityInputV1 {
  readonly signer: Rfc64ControlEnvelopeEip191SignerV1;
}

/** Everything the author holds after minting one owner-signed seed. */
export interface Rfc64MintedUnregisteredReplicaAuthoritySeedV1 {
  /** Unpadded base64url of `canonicalEnvelopeBytes` (deprecated ontology literal). */
  readonly evidence: string;
  /** Exact canonical signed policy envelope bytes for the keyed seed store and the wire. */
  readonly canonicalEnvelopeBytes: Uint8Array;
  /** The policy object digest (RFC-64 policyDigest of this generation). */
  readonly policyDigest: Digest32V1;
  readonly envelope: SignedContextGraphPolicyEnvelopeV1;
  readonly issuerSignature: VerifiedControlEnvelopeIssuerSignatureV1;
}

/** Mint the standard RFC-64 policy object used as durable replica evidence. */
export async function mintRfc64UnregisteredReplicaAuthoritySeedV1(
  input: MintRfc64UnregisteredReplicaAuthorityEvidenceInputV1,
): Promise<Rfc64MintedUnregisteredReplicaAuthoritySeedV1> {
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
  return Object.freeze({
    evidence: Buffer.from(canonical).toString('base64url'),
    canonicalEnvelopeBytes: canonical,
    policyDigest: objectDigest,
    envelope: signed.envelope as SignedContextGraphPolicyEnvelopeV1,
    issuerSignature: signed.issuerSignature,
  });
}

/** Base64url ontology literal only; see `mintRfc64UnregisteredReplicaAuthoritySeedV1`. */
export async function mintRfc64UnregisteredReplicaAuthorityEvidenceV1(
  input: MintRfc64UnregisteredReplicaAuthorityEvidenceInputV1,
): Promise<string> {
  return (await mintRfc64UnregisteredReplicaAuthoritySeedV1(input)).evidence;
}

/** An authenticated seed: the replica authority snapshot plus its exact carrier bytes. */
export interface Rfc64AuthenticatedUnregisteredReplicaAuthorityV1
  extends Rfc64ReleaseNativeAuthoritySnapshotV1 {
  readonly source: 'owner-signed-unregistered';
  /** Lowercase envelope issuer, proven equal to the Context Graph wallet namespace. */
  readonly ownerAddress: EvmAddressV1;
  readonly canonicalEnvelopeBytes: Uint8Array;
}

/**
 * Authenticate one canonical owner-signed seed against the graph it claims.
 * This is the single acceptance predicate shared by the keyed seed store, the
 * deprecated ontology carrier, and any peer transport: issuer signature, owner
 * equal to the wallet-namespace prefix, network/graph binding, and the exact
 * unregistered generation-0 public policy shape. Every failure throws; nothing
 * here proves finalized on-chain absence, which callers MUST establish
 * separately before accepting the result.
 */
export async function authenticateRfc64UnregisteredReplicaAuthorityEnvelopeV1(
  canonicalEnvelopeBytes: Uint8Array,
  input: Readonly<{
    readonly networkId: NetworkIdV1;
    readonly contextGraphId: ContextGraphIdV1;
    readonly signal?: AbortSignal;
  }>,
): Promise<Rfc64AuthenticatedUnregisteredReplicaAuthorityV1> {
  input.signal?.throwIfAborted();
  if (
    !(canonicalEnvelopeBytes instanceof Uint8Array)
    || canonicalEnvelopeBytes.byteLength < 1
    || canonicalEnvelopeBytes.byteLength > RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1
  ) {
    throw new Error('RFC-64 unregistered replica authority seed is outside its byte bound');
  }
  // Only wallet-namespaced CG IDs have an independently checkable owner before
  // registration. A signature cannot safely self-assign ownership of an
  // arbitrary global name.
  const expectedOwner = resolveRfc64WalletNamespaceOwnerV1(input.contextGraphId);
  if (expectedOwner === null) {
    throw new Error('RFC-64 unregistered replica authority requires a wallet-namespaced Context Graph');
  }
  const envelope = parseCanonicalSignedContextGraphPolicyEnvelopeV1(canonicalEnvelopeBytes, {
    maxBytes: RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1,
  });
  await verifyControlEnvelopeIssuerSignatureV1(envelope, { signal: input.signal });
  const owner = envelope.issuer.toLowerCase() as EvmAddressV1;
  const policy = envelope.payload;
  if (owner !== expectedOwner) {
    throw new Error('RFC-64 unregistered replica authority issuer is not the Context Graph wallet owner');
  }
  if (policy.networkId !== input.networkId || policy.contextGraphId !== input.contextGraphId) {
    throw new Error('RFC-64 unregistered replica authority is bound to a different network or Context Graph');
  }
  if (
    policy.source.kind !== 'owner-signed-unregistered'
    || policy.source.ownerAddress !== owner
    || policy.source.ownerAuthorityEra !== '0'
    || policy.governanceChainId !== null
    || policy.governanceContractAddress !== null
    || policy.ownershipTransitionDigest !== null
    || policy.era !== '0'
    || policy.version !== '0'
    || policy.previousPolicyDigest !== null
    || policy.accessPolicy !== 0
  ) {
    throw new Error('RFC-64 unregistered replica authority is not a generation-0 public owner policy');
  }
  return Object.freeze({
    policy,
    policyDigest: envelope.objectDigest as Digest32V1,
    roster: null,
    source: 'owner-signed-unregistered' as const,
    ownerAddress: owner,
    canonicalEnvelopeBytes: Uint8Array.from(canonicalEnvelopeBytes),
  });
}

/**
 * Keyed seed access supplied by the agent (see `Rfc64SeedStoreMethods`).
 * `read` is a point lookup that MUST NOT scan the ontology graph; `persist`
 * re-authenticates before writing and is expected to contain its own failures
 * so a resolved authority is never lost to a write-through fault.
 */
export interface Rfc64UnregisteredReplicaAuthoritySeedAccessV1 {
  readonly read: (input: Readonly<{
    readonly networkId: NetworkIdV1;
    readonly contextGraphId: ContextGraphIdV1;
    readonly signal?: AbortSignal;
  }>) => Promise<Uint8Array | null>;
  readonly persist: (input: Readonly<{
    readonly networkId: NetworkIdV1;
    readonly contextGraphId: ContextGraphIdV1;
    readonly canonicalEnvelopeBytes: Uint8Array;
    readonly signal?: AbortSignal;
  }>) => Promise<void>;
}

/**
 * Load and authenticate replica evidence. This proves only the unregistered
 * policy generation; callers MUST separately prove finalized on-chain absence
 * before accepting it.
 *
 * Order: (1) wallet-namespace gate, (2) keyed seed store point lookup, (3)
 * DEPRECATED ontology system-graph scan as backward-compat fallback, (4)
 * write-through of an ontology hit so the next read is a point lookup.
 */
export async function loadRfc64UnregisteredReplicaAuthorityV1(input: Readonly<{
  readonly store: TripleStore;
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly signal?: AbortSignal;
  readonly seeds?: Rfc64UnregisteredReplicaAuthoritySeedAccessV1;
}>): Promise<Rfc64AuthenticatedUnregisteredReplicaAuthorityV1 | null> {
  // Only wallet-namespaced CG IDs have an independently checkable owner before
  // registration. A signature cannot safely self-assign ownership of an
  // arbitrary global name.
  if (resolveRfc64WalletNamespaceOwnerV1(input.contextGraphId) === null) return null;

  const { seeds } = input;
  if (seeds !== undefined) {
    const stored = await seeds.read({
      networkId: input.networkId,
      contextGraphId: input.contextGraphId,
      signal: input.signal,
    });
    if (stored !== null) {
      try {
        return await authenticateRfc64UnregisteredReplicaAuthorityEnvelopeV1(stored, input);
      } catch (cause) {
        if (input.signal?.aborted) throw cause;
        // A stored row that no longer authenticates is inert data, never
        // authority. Fall through to the compat carrier rather than trust it.
      }
    }
  }

  // DEPRECATED: ontology system-graph carrier, backward-compat only. New code
  // must not depend on this scan; it exists so replicas that received the
  // seed through legacy ontology sync/gossip can still authenticate it.
  const authority = await loadRfc64UnregisteredReplicaAuthorityFromOntologyV1(input);
  if (authority !== null && seeds !== undefined) {
    await seeds.persist({
      networkId: input.networkId,
      contextGraphId: input.contextGraphId,
      canonicalEnvelopeBytes: authority.canonicalEnvelopeBytes,
      signal: input.signal,
    });
  }
  return authority;
}

async function loadRfc64UnregisteredReplicaAuthorityFromOntologyV1(input: Readonly<{
  readonly store: TripleStore;
  readonly networkId: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly signal?: AbortSignal;
}>): Promise<Rfc64AuthenticatedUnregisteredReplicaAuthorityV1 | null> {
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

  const accepted = new Map<string, Rfc64AuthenticatedUnregisteredReplicaAuthorityV1>();
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
      const snapshot = await authenticateRfc64UnregisteredReplicaAuthorityEnvelopeV1(
        canonical,
        input,
      );
      accepted.set(snapshot.policyDigest, snapshot);
    } catch (cause) {
      if (input.signal?.aborted) throw cause;
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
    || decoded.byteLength > RFC64_UNREGISTERED_AUTHORITY_SEED_MAX_BYTES_V1
    || decoded.toString('base64url') !== encoded
  ) {
    throw new Error('RFC-64 replica authority evidence is not canonical base64url');
  }
  return decoded;
}
