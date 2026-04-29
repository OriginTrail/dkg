import { contextGraphDataUri, keccak256 } from '@origintrail-official/dkg-core';
import { randomBytes } from 'node:crypto';
import type { Quad } from '@origintrail-official/dkg-storage';

/**
 * Ontology predicate: endorsement → knowledge asset.
 *
 * previously this predicate
 * was emitted as `<agent> dkg:endorses <ual>`. Combined with the
 * agent-keyed `endorsedAt`/`endorsementNonce`/`endorsementSignature`
 * quads that also sat on `<agent>`, two endorsements by the same
 * agent in one context graph produced FOUR timestamps, FOUR nonces,
 * FOUR signatures on the same subject — with no way to pair a
 * signature with its UAL. That made A-7 signatures unverifiable
 * once more than one endorsement existed.
 *
 * Fix: introduce a per-event endorsement resource (a deterministic
 * URN derived from the canonical digest), and hang the UAL,
 * timestamp, nonce, and signature off that subject. The full shape
 * is now:
 *
 *   <urn:dkg:endorsement:HEX>  rdf:type              dkg:Endorsement .
 *   <urn:dkg:endorsement:HEX>  dkg:endorses          <ual> .
 *   <urn:dkg:endorsement:HEX>  dkg:endorsedBy        <did:dkg:agent:0x…> .
 *   <urn:dkg:endorsement:HEX>  dkg:endorsedAt        "ts"^^xsd:dateTime .
 *   <urn:dkg:endorsement:HEX>  dkg:endorsementNonce  "nonce" .
 *   <urn:dkg:endorsement:HEX>  dkg:endorsementSignature "sig" .
 *
 * Verifiers reconstruct the canonical digest from the four
 * properties on a single endorsement subject, recover the signer,
 * and check it matches `<agent>` — no ambiguity possible.
 */
export const DKG_ENDORSES = 'https://dkg.network/ontology#endorses';

/**
 * Ontology predicate: endorsement → agent.
 *
 * The round-18-and-earlier
 * shape had no link back from the endorsement resource to the
 * endorsing agent because there WAS no endorsement resource — all
 * quads were agent-keyed. Introducing this predicate lets
 * consumers answer "which agent produced this signature?" without
 * guessing from co-occurring agent-keyed quads.
 */
export const DKG_ENDORSED_BY = 'https://dkg.network/ontology#endorsedBy';

/**
 * Ontology predicate: rdf:type hint for endorsement resources.
 *
 * Emitting an explicit `rdf:type dkg:Endorsement` triple gives
 * verifiers a stable SPARQL hook to enumerate every endorsement in
 * a context graph, regardless of which predicates they happen to
 * carry, and makes shape-matching (SHACL / schema guards) trivial.
 */
export const DKG_ENDORSEMENT_CLASS = 'https://dkg.network/ontology#Endorsement';

export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** Ontology predicate: timestamp of endorsement */
export const DKG_ENDORSED_AT = 'https://dkg.network/ontology#endorsedAt';

/** Ontology predicate: 128-bit random nonce bound to this endorsement (A-7 replay defence). */
export const DKG_ENDORSEMENT_NONCE = 'https://dkg.network/ontology#endorsementNonce';

/**
 * Ontology predicate: signature / proof over the canonical endorsement
 * digest (A-7).
 *
 * Two emission modes:
 *
 *  - **{@link buildEndorsementQuadsAsync} with `signer`** — the object is
 *    the EIP-191 personal-sign signature returned by the caller's wallet
 *    over `eip191Hash(canonicalDigest)`. Verifiers can recover the
 *    endorsing address from this value and reject endorsements whose
 *    recovered signer is not a member of the context graph.
 *
 *  - **{@link buildEndorsementQuads} (sync) or async without a signer** —
 *    the object falls back to the canonical digest hex ("unsigned proof").
 *    This still binds the quad to (agent, ual, cg, ts, nonce) so tampering
 *    with any field breaks the digest, but it is NOT a cryptographic
 *    signature: any peer that knows the public tuple can recompute it.
 *    Flows that need non-repudiation MUST use the async variant with a
 *    real signer.
 */
export const DKG_ENDORSEMENT_SIGNATURE = 'https://dkg.network/ontology#endorsementSignature';

/**
 * Options common to both sync and async endorsement builders.
 *
 * NOTE: the `signer` option lives ONLY on {@link BuildEndorsementQuadsAsyncOptions}
 * — it is deliberately absent from the sync variant's option type. An
 * earlier revision exposed `signer` on the sync builder as well, but the
 * sync path cannot call it (signing is async), so callers who passed one
 * still got the raw digest hex in `endorsementSignature` and believed
 * they had produced a verifiable endorsement. Removing
 * the option from the sync surface makes the contract honest.
 */
export interface BuildEndorsementQuadsOptions {
  /** Injectable timestamp for deterministic tests. */
  now?: Date;
  /** Injectable nonce for deterministic tests. Must be ≥ 16 bytes of entropy. */
  nonce?: string;
}

export interface BuildEndorsementQuadsAsyncOptions extends BuildEndorsementQuadsOptions {
  /**
   * EIP-191 signer — typically `(digest) => wallet.signMessage(digest)`.
   * Invoked exactly once with the canonical keccak256 digest bytes; the
   * returned signature is persisted into the endorsement signature quad.
   * If omitted, the quad falls back to the unsigned digest hex.
   */
  signer?: (digest: Uint8Array) => Promise<string> | string;
}

/**
 * Canonical endorsement preimage (A-7). Stable across implementations so
 * any verifier can reproduce it: pipe-separated tuple of lower-cased
 * address, UAL, context graph id, ISO-8601 timestamp, and nonce.
 */
export function canonicalEndorseDigest(
  agentAddress: string,
  knowledgeAssetUal: string,
  contextGraphId: string,
  endorsedAt: string,
  nonce: string,
): Uint8Array {
  const preimage = [
    agentAddress.toLowerCase(),
    knowledgeAssetUal,
    contextGraphId,
    endorsedAt,
    nonce,
  ].join('|');
  return keccak256(new TextEncoder().encode(preimage));
}

function toHex(bytes: Uint8Array): string {
  return '0x' + Buffer.from(bytes).toString('hex');
}

interface EndorsementCore {
  agentUri: string;
  knowledgeAssetUal: string;
  endorsementUri: string;
  graph: string;
  now: string;
  nonce: string;
  digest: Uint8Array;
}

/**
 * Deterministic per-event endorsement URN.
 *
 * Derived from the keccak256 digest of the canonical preimage, so
 * retrying the same logical endorsement (same agent, UAL, CG, ts,
 * nonce) regenerates byte-identical quads — idempotence across
 * retries is the whole point. Different UAL / ts / nonce → different
 * digest → different URN.
 */
export function endorsementUri(digest: Uint8Array): string {
  // Drop the 0x-prefix for a compact URN — the digest is always a
  // 32-byte keccak output so the hex length is fixed at 64 chars.
  return `urn:dkg:endorsement:${Buffer.from(digest).toString('hex')}`;
}

function prepareEndorsementCore(
  agentAddress: string,
  knowledgeAssetUal: string,
  contextGraphId: string,
  options: BuildEndorsementQuadsOptions,
): EndorsementCore {
  const agentUri = `did:dkg:agent:${agentAddress}`;
  const graph = contextGraphDataUri(contextGraphId);
  const now = (options.now ?? new Date()).toISOString();
  const nonce = options.nonce ?? toHex(randomBytes(16));
  const digest = canonicalEndorseDigest(
    agentAddress,
    knowledgeAssetUal,
    contextGraphId,
    now,
    nonce,
  );
  return {
    agentUri,
    knowledgeAssetUal,
    endorsementUri: endorsementUri(digest),
    graph,
    now,
    nonce,
    digest,
  };
}

function buildQuadsFromCore(core: EndorsementCore, proofValue: string): Quad[] {
  // every proof quad is now
  // keyed on the per-event `core.endorsementUri` instead of the
  // agent URI, so multiple endorsements by the same agent in the
  // same context graph no longer collide on a single subject. The
  // rdf:type + dkg:endorses + dkg:endorsedBy triples tie the four
  // pieces of the verifiable tuple (UAL, signer, timestamp, nonce,
  // signature) together under one SPARQL-enumerable resource.
  return [
    {
      subject: core.endorsementUri,
      predicate: RDF_TYPE,
      object: `<${DKG_ENDORSEMENT_CLASS}>`,
      graph: core.graph,
    },
    {
      subject: core.endorsementUri,
      predicate: DKG_ENDORSES,
      object: core.knowledgeAssetUal,
      graph: core.graph,
    },
    {
      subject: core.endorsementUri,
      predicate: DKG_ENDORSED_BY,
      object: core.agentUri,
      graph: core.graph,
    },
    {
      subject: core.endorsementUri,
      predicate: DKG_ENDORSED_AT,
      object: `"${core.now}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`,
      graph: core.graph,
    },
    {
      subject: core.endorsementUri,
      predicate: DKG_ENDORSEMENT_NONCE,
      object: `"${core.nonce}"`,
      graph: core.graph,
    },
    {
      subject: core.endorsementUri,
      predicate: DKG_ENDORSEMENT_SIGNATURE,
      object: `"${proofValue}"`,
      graph: core.graph,
    },
  ];
}

/**
 * Build endorsement triples (sync variant, no cryptographic signature).
 *
 * Emits the A-7 replay-protection nonce and a tamper-detection digest.
 * The signature quad here carries the **unsigned** canonical digest hex
 * and is NOT verifiable — use {@link buildEndorsementQuadsAsync} with a
 * real `signer` for non-repudiation.
 */
export function buildEndorsementQuads(
  agentAddress: string,
  knowledgeAssetUal: string,
  contextGraphId: string,
  options: BuildEndorsementQuadsOptions = {},
): Quad[] {
  const core = prepareEndorsementCore(agentAddress, knowledgeAssetUal, contextGraphId, options);
  return buildQuadsFromCore(core, toHex(core.digest));
}

/**
 * Async endorsement builder. If `options.signer` is supplied, it is
 * invoked with the canonical digest bytes and its return value (expected
 * to be a 0x-prefixed EIP-191 personal-sign signature) is stored in the
 * endorsement signature quad. Otherwise, falls back to the canonical
 * digest hex identical to {@link buildEndorsementQuads}.
 */
export async function buildEndorsementQuadsAsync(
  agentAddress: string,
  knowledgeAssetUal: string,
  contextGraphId: string,
  options: BuildEndorsementQuadsAsyncOptions = {},
): Promise<Quad[]> {
  const core = prepareEndorsementCore(agentAddress, knowledgeAssetUal, contextGraphId, options);
  let proofValue: string;
  if (options.signer) {
    const sig = await Promise.resolve(options.signer(core.digest));
    if (typeof sig !== 'string' || sig.length === 0) {
      throw new Error('endorsement signer returned an empty/invalid signature');
    }
    proofValue = sig;
  } else {
    proofValue = toHex(core.digest);
  }
  return buildQuadsFromCore(core, proofValue);
}
