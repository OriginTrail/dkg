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
   * The CG's access class. A catalog entry is a *private*-CG concept; this
   * builder refuses any other value (a public CG IS its own public face).
   */
  accessPolicy: string;
  /**
   * Optional. The on-chain VM merkleRoot, `0x`+64 hex. Used only by the
   * separate-KA model, where the catalog entry has its own root and needs an
   * explicit `dkg:committedRoot` back-reference. The combined model commits
   * the entry inside the CG's own root, so verifiability is intrinsic and this
   * is omitted.
   */
  committedRoot?: string;
  /** Target graph URI: the public `_catalog` subgraph this entry is written into (floor). */
  graph: string;

  // ---- Recommended (§5.9.2). Omit for the bare floor. ----
  /** Controlling identity IRI for `dct:publisher`. MAY be a per-CG pseudonymous key (§9 Q5). */
  publisher?: string;
  /** Grant endpoint IRI for `dcat:accessService` — how a consumer requests scoped access. */
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
 * Build the public catalog-entry quads for a private CG — a DCAT dataset
 * record (§5.9), the CG's standards-compliant public face.
 *
 * Returns the mandatory floor — `a dcat:Dataset, dkg:PrivateContextGraph`
 * (dual-typed: DCAT for interop, dkg: for native consumers), `dct:identifier`
 * (UAL), `dct:accessRights …/RESTRICTED` — plus any recommended/opt-in fields
 * the caller explicitly supplied (including `dkg:committedRoot` iff a
 * `committedRoot` is passed, for the separate-KA model), and nothing else.
 *
 * @throws if `accessPolicy` is not `'private'`, the UAL / graph are missing,
 *         or a supplied `committedRoot` is malformed. The throw is the
 *         disclosure-invariant guard: a malformed entry must never be
 *         published as if authoritative.
 */
export function buildPublicProjection(input: PublicProjectionInput): Quad[] {
  if (input.accessPolicy !== 'private') {
    throw new Error(
      `public catalog entry is a private-CG concept; refusing accessPolicy='${input.accessPolicy}'`,
    );
  }
  const ual = input.ual?.trim();
  if (!ual) throw new Error('public catalog entry requires a non-empty UAL');
  const graph = input.graph?.trim();
  if (!graph) throw new Error('public catalog entry requires a target graph URI');

  // --- Mandatory floor (§5.9.3) — a DCAT dataset record ---
  const quads: Quad[] = [
    quad(ual, DKG_ONTOLOGY.RDF_TYPE, DKG_ONTOLOGY.DCAT_DATASET, graph),            // interop
    quad(ual, DKG_ONTOLOGY.RDF_TYPE, DKG_ONTOLOGY.DKG_PRIVATE_CONTEXT_GRAPH, graph), // dkg-native
    quad(ual, DKG_ONTOLOGY.DCT_IDENTIFIER, literal(ual), graph),
    quad(ual, DKG_ONTOLOGY.DCT_ACCESS_RIGHTS, DKG_ONTOLOGY.ACCESS_RIGHT_RESTRICTED, graph),
  ];

  // --- Separate-KA back-reference (combined model omits it) ---
  if (input.committedRoot !== undefined) {
    if (!ROOT_RE.test(input.committedRoot)) {
      throw new Error(`committedRoot, when given, must be 0x + 64 hex; got '${input.committedRoot}'`);
    }
    quads.push(quad(ual, DKG_ONTOLOGY.DKG_COMMITTED_ROOT, literal(input.committedRoot), graph));
  }

  // --- Recommended (§5.9.2) ---
  if (input.publisher?.trim()) {
    quads.push(quad(ual, DKG_ONTOLOGY.DCT_PUBLISHER, input.publisher.trim(), graph));
  }
  if (input.accessService?.trim()) {
    quads.push(quad(ual, DKG_ONTOLOGY.DCAT_ACCESS_SERVICE, input.accessService.trim(), graph));
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
  DKG_ONTOLOGY.RDF_TYPE,        // dcat:Dataset + dkg:PrivateContextGraph (two quads, one predicate)
  DKG_ONTOLOGY.DCT_IDENTIFIER,
  DKG_ONTOLOGY.DCT_ACCESS_RIGHTS,
];

// ---------------------------------------------------------------------------
// Combined-model partition (§5.9 / §4): separate the public catalog entry from
// everything else at publish time. The catalog quads ride in the CG's own
// merkle root (verifiability) but are routed PLAINTEXT to the public sink and
// EXCLUDED from the ciphertext fed to the curated encryption emitter; the rest
// follows the existing (curated ⇒ encrypted) path. Pure + unit-testable; the
// publish-path wiring calls it at reload time in publishFromSharedMemory.
// ---------------------------------------------------------------------------

/**
 * Every predicate a catalog entry may carry (floor + recommended + opt-in
 * tiers). The partition treats a quad as catalog only if its predicate is in
 * this set AND its subject is the CG's own UAL — fail-safe: a stray quad on the
 * CG UAL with any other predicate stays on the encrypted path, never leaked.
 */
export const CATALOG_PREDICATES: ReadonlySet<string> = new Set<string>([
  DKG_ONTOLOGY.RDF_TYPE,            // → dcat:Dataset / dkg:PrivateContextGraph
  DKG_ONTOLOGY.DCT_IDENTIFIER,
  DKG_ONTOLOGY.DCT_ACCESS_RIGHTS,
  DKG_ONTOLOGY.DCT_PUBLISHER,
  DKG_ONTOLOGY.DCAT_ACCESS_SERVICE,
  DKG_ONTOLOGY.DCT_CONFORMS_TO,
  DKG_ONTOLOGY.DKG_BLINDED_ANCHOR,
  DKG_ONTOLOGY.DKG_COMMITTED_ROOT, // separate-KA variant only; harmless to recognize
]);

/**
 * A quad belongs to the CG's public catalog entry iff its subject is the CG's
 * own UAL and its predicate is a catalog predicate. Both conditions are
 * required (fail-safe toward privacy): an `rdf:type` quad on a *user* entity,
 * or a user-authored quad on the CG UAL with a non-catalog predicate, is NOT
 * catalog and stays on the (curated: encrypted) path.
 */
export function isCatalogQuad(quad: Quad, cgUal: string): boolean {
  return quad.subject === cgUal && CATALOG_PREDICATES.has(quad.predicate);
}

export interface CatalogPartition {
  /** Public, plaintext, core-servable — excluded from ciphertext, kept in the merkle root. */
  catalogQuads: Quad[];
  /** Everything else — the existing path (encrypted for a curated CG). */
  otherQuads: Quad[];
}

/**
 * Split reloaded publish quads into the public catalog entry and the rest.
 * Order-preserving and total (`catalogQuads.length + otherQuads.length ===
 * quads.length`), so nothing is dropped or duplicated.
 */
export function partitionCatalogQuads(quads: readonly Quad[], cgUal: string): CatalogPartition {
  const catalogQuads: Quad[] = [];
  const otherQuads: Quad[] = [];
  for (const q of quads) {
    (isCatalogQuad(q, cgUal) ? catalogQuads : otherQuads).push(q);
  }
  return { catalogQuads, otherQuads };
}

// ---------------------------------------------------------------------------
// Orchestration: emit a private CG's projection on VM publish (§5.9.3).
//
// The capabilities the agent supplies are injected, so the orchestration —
// the private-CG short-circuit, resolution order, build, publish, and (load-
// bearing) error isolation — is unit-testable without a running node.
// ---------------------------------------------------------------------------

export interface ProjectionEmitDeps {
  /** True iff the CG is private. Only private CGs get a projection (§5.9). */
  isPrivateContextGraph(contextGraphId: string): Promise<boolean>;
  /** Resolve the CG's UAL — the subject of the projection. */
  resolveUal(contextGraphId: string): Promise<string>;
  /** The public graph URI the projection KA is published into. */
  projectionGraph(contextGraphId: string): string;
  /** Publish the projection quads as a PUBLIC knowledge asset. */
  publishProjection(contextGraphId: string, quads: Quad[], graph: string): Promise<void>;
  /** Optional controlling identity for `dct:publisher` (MAY be a per-CG pseudonym). */
  publisherIdentity?(contextGraphId: string): string | undefined;
  /** Optional grant endpoint for `dkg:accessService`. */
  accessService?(contextGraphId: string): string | undefined;
  log?(level: 'info' | 'warn', message: string): void;
}

export interface ProjectionEmitResult {
  emitted: boolean;
  quads: Quad[];
  /** Set when emission was attempted but failed; never thrown (see below). */
  error?: string;
}

/**
 * Emit (or refresh) the public projection for a CG after a VM publish commits
 * `committedRoot` on chain. Public CGs are a no-op (they are their own public
 * face). For a private CG, builds the floor (plus any recommended fields the
 * deps surface) and publishes it.
 *
 * Error isolation is deliberate and load-bearing: a projection failure MUST
 * NOT break the VM publish that triggered it, so this never throws — it logs
 * and returns `{ emitted: false, error }`. The caller treats the projection as
 * best-effort and the next publish refreshes it.
 */
export async function emitPublicProjection(
  deps: ProjectionEmitDeps,
  contextGraphId: string,
  committedRoot: string,
): Promise<ProjectionEmitResult> {
  try {
    if (!(await deps.isPrivateContextGraph(contextGraphId))) {
      return { emitted: false, quads: [] };
    }
    const ual = await deps.resolveUal(contextGraphId);
    const graph = deps.projectionGraph(contextGraphId);
    const quads = buildPublicProjection({
      ual,
      accessPolicy: 'private',
      committedRoot,
      graph,
      publisher: deps.publisherIdentity?.(contextGraphId),
      accessService: deps.accessService?.(contextGraphId),
    });
    await deps.publishProjection(contextGraphId, quads, graph);
    deps.log?.('info', `public projection refreshed for ${contextGraphId} @ root ${committedRoot}`);
    return { emitted: true, quads };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log?.('warn', `public projection emit failed for ${contextGraphId}: ${message} (publish unaffected)`);
    return { emitted: false, quads: [], error: message };
  }
}
