import { contextGraphDataUri, DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

/** Ontology predicate: agent endorses a Knowledge Asset */
export const DKG_ENDORSES = 'https://dkg.network/ontology#endorses';

/** Ontology predicate: timestamp of endorsement */
export const DKG_ENDORSED_AT = 'https://dkg.network/ontology#endorsedAt';

/** Ontology predicate: cryptographic signature proving the endorser controls the wallet */
export const DKG_ENDORSEMENT_SIGNATURE = 'https://dkg.network/ontology#endorsementSignature';

/** Ontology predicate: digest the signature commits to (UAL + endorser + timestamp) */
export const DKG_ENDORSEMENT_DIGEST = 'https://dkg.network/ontology#endorsementDigest';

/**
 * V10 Axiom 4 evidence rule: every canonical transition records cryptographic
 * evidence. ENDORSE is a trust-upgrade transition, so its emitted triples must
 * commit the endorsing wallet to a deterministic digest of (UAL, endorser,
 * timestamp). Peers receiving the endorsement via gossip can recover the
 * signer address from the signature and compare against `did:dkg:agent:<addr>`
 * — without that, ENDORSE is a free-form social label and any node can stamp
 * arbitrary endorsements on behalf of any address.
 */
export function buildEndorsementDigest(
  endorserAddress: string,
  knowledgeAssetUal: string,
  endorsedAtIso: string,
): string {
  // Personal-message style digest so we can recover the signer with
  // `ethers.verifyMessage(...)` on the wire side (no EIP-712 typed-data
  // dependency yet — keep it simple and recover-only).
  return [
    'dkg/endorse/v1',
    endorserAddress.toLowerCase(),
    knowledgeAssetUal,
    endorsedAtIso,
  ].join('|');
}

export interface EndorsementOpts {
  agentAddress: string;
  knowledgeAssetUal: string;
  contextGraphId: string;
  /** Hex-encoded 0x-prefixed private key for the endorser wallet. */
  signerKey?: string;
  /** Timestamp override (test seam). */
  now?: Date;
}

/**
 * Build endorsement triples for a Knowledge Asset.
 *
 * Endorsements are regular RDF triples published to the Context Graph's
 * data graph. They ride the next regular PUBLISH batch — no separate
 * chain transaction needed.
 */
export function buildEndorsementQuads(opts: EndorsementOpts): Quad[];
export function buildEndorsementQuads(
  agentAddress: string,
  knowledgeAssetUal: string,
  contextGraphId: string,
): Quad[];
export function buildEndorsementQuads(
  arg1: string | EndorsementOpts,
  arg2?: string,
  arg3?: string,
): Quad[] {
  const opts: EndorsementOpts = typeof arg1 === 'string'
    ? { agentAddress: arg1, knowledgeAssetUal: arg2!, contextGraphId: arg3! }
    : arg1;

  const agentUri = `did:dkg:agent:${opts.agentAddress}`;
  const graph = contextGraphDataUri(opts.contextGraphId);
  const now = (opts.now ?? new Date()).toISOString();
  const digest = buildEndorsementDigest(opts.agentAddress, opts.knowledgeAssetUal, now);
  // V10 Axiom 3: ENDORSE is a typed transition — emit a prov:Activity in
  // the same data graph so the audit trail is uniform with SHARE / PUBLISH
  // / DISCARD / REVOKE. Use a deterministic event URI rooted in the
  // endorser DID + UAL + timestamp so re-endorsements of the same UAL by
  // the same agent collapse into the same activity URI.
  const eventUri = `${agentUri}/endorse/${encodeURIComponent(opts.knowledgeAssetUal)}/${encodeURIComponent(now)}`;
  const PROV = 'http://www.w3.org/ns/prov#';
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const DKG_NS = 'http://dkg.io/ontology/';
  const quads: Quad[] = [
    { subject: agentUri, predicate: DKG_ENDORSES, object: opts.knowledgeAssetUal, graph },
    {
      subject: agentUri,
      predicate: DKG_ENDORSED_AT,
      object: `"${now}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`,
      graph,
    },
    {
      subject: agentUri,
      predicate: DKG_ENDORSEMENT_DIGEST,
      object: `"${digest.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
      graph,
    },
    { subject: eventUri, predicate: RDF_TYPE, object: `${PROV}Activity`, graph },
    { subject: eventUri, predicate: RDF_TYPE, object: `${DKG_NS}Endorsement`, graph },
    {
      subject: eventUri,
      predicate: `${PROV}startedAtTime`,
      object: `"${now}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`,
      graph,
    },
    { subject: eventUri, predicate: `${PROV}wasAssociatedWith`, object: agentUri, graph },
    { subject: eventUri, predicate: `${PROV}used`, object: opts.knowledgeAssetUal, graph },
    { subject: eventUri, predicate: `${DKG_NS}transitionType`, object: `"ENDORSE"`, graph },
  ];
  if (opts.signerKey) {
    const signingKey = new ethers.SigningKey(opts.signerKey);
    const personalHash = ethers.hashMessage(digest);
    const sig = signingKey.sign(personalHash);
    quads.push({
      subject: agentUri,
      predicate: DKG_ENDORSEMENT_SIGNATURE,
      object: `"${sig.serialized}"`,
      graph,
    });
  }
  return quads;
}
