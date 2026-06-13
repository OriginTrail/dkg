// SPDX-License-Identifier: Apache-2.0
//
// OT-RFC-49 §5.9 — the verifiable public projection of a private CG.
//
// A private CG holds its data off the network, but it is not invisible to
// it. Every private CG maintains a small, public, signed RDF *projection*
// that binds it into the public graph as a verifiable, addressable node —
// enough for an outsider to discover that it exists, verify claims bound to
// it, and learn how to ask for access — while disclosing nothing beyond what
// the chain already exposes.
//
// This module is the *write* direction (CG state -> floor quads). It is pure
// and side-effect-free: the caller publishes the returned quads as an
// ordinary PUBLIC knowledge asset (signed + anchored, hence tamper-evident).
// The *read* direction (triples -> ContextGraphMetaRecord) lives in
// context-graph-meta-projection.ts.
//
// The disclosure invariant (§5.9.1): the floor MUST contain only facts
// already derivable from the on-chain record. This builder enforces it
// structurally — it accepts only typed floor/recommended/opt-in fields, so
// it cannot emit a triple the caller did not explicitly supply.

import { createHmac } from 'node:crypto';
import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

/** A 32-byte hex string, `0x`-prefixed (an on-chain merkle root). */
const ROOT_RE = /^0x[0-9a-fA-F]{64}$/;

export interface PublicProjectionInput {
  /** The CG's UAL / DID — the subject of every projection triple (floor). */
  ual: string;
  /**
   * The CG's access class. A projection is a *private*-CG concept; this
   * builder refuses any other value (a public CG IS its own public face).
   */
  accessPolicy: string;
  /** Latest on-chain VM merkleRoot, `0x`+64 hex — the verifiability edge (floor). */
  committedRoot: string;
  /** Target graph URI: the public projection KA this node is published into (floor). */
  graph: string;

  // ---- Recommended (§5.9.2). Omit for the bare floor. ----
  /** Controlling identity IRI. MAY be a per-CG pseudonymous key (§9 Q5). */
  publisher?: string;
  /** Endpoint to request a scoped access grant. */
  accessService?: string;

  // ---- Opt-in, disclosure-priced (§5.9.4). Each is a deliberate curator choice. ----
  /** T1: ontology / domain IRIs the CG conforms to. Discloses the field. */
  conformsTo?: string[];
  /**
   * T2: blinded join keys, each `HMAC-SHA256(cgSecret, canonicalEntityId)`
   * (see {@link blindedAnchor}). Discloses *how many* shared entities, never
   * *which*. Matchable only by holders of the CG secret.
   */
  blindedAnchors?: string[];
}

function literal(value: string): string {
  // Mirror dkg-agent-context-graph.ts's literal convention: quoted object.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function quad(subject: string, predicate: string, object: string, graph: string): Quad {
  return { subject, predicate, object, graph };
}

/**
 * Build the public-projection quads for a private CG.
 *
 * Returns the mandatory floor — `a dkg:PrivateContextGraph`, `dct:identifier`
 * (UAL), `dct:accessRights dkg:Private`, `dkg:committedRoot` — plus any
 * recommended/opt-in fields the caller explicitly supplied, and nothing else.
 *
 * @throws if `accessPolicy` is not `'private'`, or the UAL / root / graph are
 *         missing or malformed. The throw is the disclosure-invariant guard:
 *         a malformed floor must never be published as if authoritative.
 */
export function buildPublicProjection(input: PublicProjectionInput): Quad[] {
  if (input.accessPolicy !== 'private') {
    throw new Error(
      `public projection is a private-CG concept; refusing accessPolicy='${input.accessPolicy}'`,
    );
  }
  const ual = input.ual?.trim();
  if (!ual) throw new Error('public projection requires a non-empty UAL');
  if (!ROOT_RE.test(input.committedRoot)) {
    throw new Error(`committedRoot must be 0x + 64 hex; got '${input.committedRoot}'`);
  }
  const graph = input.graph?.trim();
  if (!graph) throw new Error('public projection requires a target graph URI');

  // --- Mandatory floor (§5.9.3) ---
  const quads: Quad[] = [
    quad(ual, DKG_ONTOLOGY.RDF_TYPE, DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH, graph),
    quad(ual, DKG_ONTOLOGY.DCT_IDENTIFIER, literal(ual), graph),
    quad(ual, DKG_ONTOLOGY.DCT_ACCESS_RIGHTS, DKG_ONTOLOGY.DKG_PRIVATE_ACCESS_RIGHTS, graph),
    quad(ual, DKG_ONTOLOGY.DKG_COMMITTED_ROOT, literal(input.committedRoot), graph),
  ];

  // --- Recommended (§5.9.2) ---
  if (input.publisher?.trim()) {
    quads.push(quad(ual, DKG_ONTOLOGY.DCT_PUBLISHER, input.publisher.trim(), graph));
  }
  if (input.accessService?.trim()) {
    quads.push(quad(ual, DKG_ONTOLOGY.DKG_ACCESS_SERVICE, literal(input.accessService.trim()), graph));
  }

  // --- Opt-in, disclosure-priced (§5.9.4) ---
  for (const onto of input.conformsTo ?? []) {
    if (onto?.trim()) quads.push(quad(ual, DKG_ONTOLOGY.DCT_CONFORMS_TO, onto.trim(), graph));
  }
  for (const anchor of input.blindedAnchors ?? []) {
    if (anchor?.trim()) quads.push(quad(ual, DKG_ONTOLOGY.DKG_BLINDED_ANCHOR, literal(anchor.trim()), graph));
  }

  return quads;
}

/**
 * Compute a blinded entity anchor (§5.9.4 T2): `HMAC-SHA256(cgSecret, id)`,
 * hex, prefixed `hmac:`. Partners holding `cgSecret` recompute this over the
 * same canonical entity id to discover overlap; the public sees only opaque
 * hashes. `canonicalEntityId` MUST already be normalized by the caller (the
 * normalization scheme is §9 Q10).
 */
export function blindedAnchor(cgSecret: Buffer | string, canonicalEntityId: string): string {
  const key = typeof cgSecret === 'string' ? Buffer.from(cgSecret, 'utf8') : cgSecret;
  const mac = createHmac('sha256', key).update(canonicalEntityId, 'utf8').digest('hex');
  return `hmac:${mac}`;
}

/** Floor predicates, exported so tests / auditors can assert the disclosure invariant. */
export const PUBLIC_PROJECTION_FLOOR_PREDICATES: readonly string[] = [
  DKG_ONTOLOGY.RDF_TYPE,
  DKG_ONTOLOGY.DCT_IDENTIFIER,
  DKG_ONTOLOGY.DCT_ACCESS_RIGHTS,
  DKG_ONTOLOGY.DKG_COMMITTED_ROOT,
];
