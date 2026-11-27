// SPDX-License-Identifier: Apache-2.0

/**
 * The author's seal of a Knowledge Asset, carried with its share (GH#3294).
 *
 * A node that did not author an asset, such as the curator of a graph with a
 * curated publish policy, can publish it only under its author's seal: the
 * chain checks the author's AuthorAttestation signature over the asset's Merkle
 * root and reserved KA id. The seal is written on the author's node at
 * finalize, so the author's node sends it with every share, as the canonical
 * graph-scoped seal bytes next to the asset's lifecycle name.
 *
 * A receiver keeps the seal only when the seal's signature recovers the
 * asset's author, the seal commits to exactly the content the share delivered,
 * and the share's gossip envelope is signed by that same author. The seal
 * itself binds neither a graph nor a name; the envelope signature covers both
 * (the graph id and the whole share message), so no other peer can carry an
 * author's seal into a graph or bind it to one of the author's names. The
 * receiver then records the seal and the share-complete marker under the
 * author's coordinate in the graph's `_meta`, which is where VM publish looks
 * for them. A coordinate keeps the asset it was first bound to: its seal is
 * replaced only by a seal of the same asset at the same or a newer version.
 */

import {
  ASSERTION_SEAL_PREDICATES,
  AUTHOR_SCHEME_VERSION_V1,
  GOSSIP_ENVELOPE_VERSION,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  assertSafeIri,
  assertionLifecycleUri,
  buildAssertionSealQuads,
  buildAuthorAttestationTypedData,
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  computeGossipSigningPayload,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetAgentAddressesEqual,
  parseCanonicalGraphScopedAuthorSealV1,
  unwrapIri,
  validateAssertionName,
  type AssertionSeal,
  type AssertionSealBuildArgs,
  type GossipEnvelopeMsg,
  type GraphKnowledgeAssetScope,
  type Logger,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';
import { withKeyedLocks } from './keyed-lock.js';
import { computeFlatKCRootV10 } from './merkle.js';
import { KA_ID_PRED, VM_CURRENT_ASSERTION_PRED } from './metadata.js';

/**
 * #1116 (review A1) — marker predicate stamped on the lifecycle URN when a KA
 * has been FULLY shared to SWM (entities:"all", all roots landed). It gates
 * finalize(layer:"swm") and VM publish, so a subset share — which also stamps
 * dkg:rootEntity member rows — cannot be sealed-in-SWM and published as a
 * partial asset. A node that keeps a received seal stamps it as well: the seal
 * was verified against the complete content the share stored.
 */
export const SWM_SHARE_COMPLETE_PRED = 'http://dkg.io/ontology/swmShareComplete';

/** The lifecycle's name, which identifier reads (`resolveByKaId`) match with its `dkg:kaId`. */
const ASSERTION_NAME_PRED = 'http://dkg.io/ontology/assertionName';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

/** The two share-message fields that carry the author's seal. */
export interface SharedMemoryAuthorSealFields {
  readonly assertionName: string;
  readonly authorSeal: Uint8Array;
}

/**
 * The share-message fields for `seal`, or none when it has no canonical form
 * (a scheme other than v1, or a seal without a reserved KA id). The share then
 * goes out without it, as before.
 */
export function sharedMemoryAuthorSealFields(
  assertionName: string,
  seal: AssertionSeal,
): SharedMemoryAuthorSealFields | Record<string, never> {
  try {
    return {
      assertionName,
      authorSeal: canonicalizeCanonicalGraphScopedAuthorSealBytesV1(
        canonicalGraphScopedAuthorSealFromAssertionSealV1(seal),
      ),
    };
  } catch {
    return {};
  }
}

/** What a share says about its asset, as the receiver validated and stored it. */
export interface SharedMemoryAuthorSealShare {
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  /** Canonical graph-scoped UAL. */
  readonly kaUal: string;
  /** Canonical assertion version. */
  readonly assertionVersion: string;
  readonly publicTripleCount: number;
  readonly privateTripleCount: number;
  readonly privateMerkleRoot?: Uint8Array;
  /** Flat KC root of the public quads as stored, with the private root as a leaf. */
  readonly merkleRoot: Uint8Array;
}

/** A complete graph-scoped seal, without the subject and graph it is written to. */
export type GraphScopedAuthorSeal = Omit<
  Extract<AssertionSealBuildArgs, { contentScopeVersion: typeof GRAPH_KA_CONTENT_SCOPE_VERSION }>,
  'assertionUri' | 'metaGraph'
>;

/** A seal that recovers its author and commits to the share's content. */
export interface VerifiedSharedMemoryAuthorSeal {
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly assertionName: string;
  /** Its addresses in EIP-55 form, its UAL and version canonical. */
  readonly seal: GraphScopedAuthorSeal;
}

export type SharedMemoryAuthorSealVerdict =
  | { readonly kind: 'absent' }
  | { readonly kind: 'verified'; readonly verified: VerifiedSharedMemoryAuthorSeal }
  | { readonly kind: 'rejected'; readonly reason: string };

function hexOrNull(bytes: Uint8Array | undefined): string | null {
  return bytes && bytes.length > 0 ? ethers.hexlify(bytes).toLowerCase() : null;
}

/**
 * Judge the seal a share carries against the content the share delivered.
 * Never throws: a seal that cannot be verified is `rejected` with the reason,
 * and the share itself is unaffected.
 */
export function verifySharedMemoryAuthorSeal(
  fields: { readonly assertionName?: string; readonly authorSeal?: Uint8Array },
  share: SharedMemoryAuthorSealShare,
): SharedMemoryAuthorSealVerdict {
  // Protobuf decodes an absent string as '' and absent bytes as empty.
  const assertionName = fields.assertionName ?? '';
  const sealBytes = fields.authorSeal ?? new Uint8Array();
  if (sealBytes.length === 0 && assertionName === '') return { kind: 'absent' };
  try {
    if (sealBytes.length === 0) throw new Error('an assertion name came without an author seal');
    const nameCheck = validateAssertionName(assertionName);
    if (!nameCheck.valid) throw new Error(`invalid assertion name: ${nameCheck.reason}`);
    const payload = parseCanonicalGraphScopedAuthorSealV1(sealBytes);

    const sealScope = createGraphKnowledgeAssetScope(payload.kaUal, payload.assertionVersion);
    if (sealScope.ual !== share.kaUal || sealScope.assertionVersion !== share.assertionVersion) {
      throw new Error(
        `the seal is for ${sealScope.ual} version ${sealScope.assertionVersion}, ` +
          `the share for ${share.kaUal} version ${share.assertionVersion}`,
      );
    }
    if (
      BigInt(payload.publicTripleCount) !== BigInt(share.publicTripleCount)
      || BigInt(payload.privateTripleCount) !== BigInt(share.privateTripleCount)
    ) {
      throw new Error('the seal and the share count different triples');
    }
    if (payload.privateMerkleRoot !== hexOrNull(share.privateMerkleRoot)) {
      throw new Error('the seal and the share name different private roots');
    }
    if (payload.assertionMerkleRoot !== hexOrNull(share.merkleRoot)) {
      throw new Error('the seal does not commit to the content the share delivered');
    }

    const typedData = buildAuthorAttestationTypedData({
      chainId: BigInt(payload.assertedAtChainId),
      kav10Address: payload.assertedAtKav10Address,
      merkleRoot: ethers.getBytes(payload.assertionMerkleRoot),
      authorAddress: payload.authorAddress,
      reservedKaId: BigInt(payload.reservedKaId),
      schemeVersion: AUTHOR_SCHEME_VERSION_V1,
    });
    const digest = ethers.TypedDataEncoder.hash(typedData.domain, typedData.types, typedData.message);
    // ECDSA recovery proves an EOA author. A contract-wallet author's
    // signature can only be checked on chain, so such a seal is not kept here.
    const recovered = ethers.recoverAddress(
      digest,
      ethers.Signature.from({ r: payload.authorAttestationR, yParityAndS: payload.authorAttestationVS }),
    );
    if (recovered.toLowerCase() !== payload.authorAddress) {
      throw new Error(`the signature recovers ${recovered}, not the author ${payload.authorAddress}`);
    }

    return {
      kind: 'verified',
      verified: {
        contextGraphId: share.contextGraphId,
        ...(share.subGraphName ? { subGraphName: share.subGraphName } : {}),
        assertionName,
        seal: {
          merkleRoot: ethers.getBytes(payload.assertionMerkleRoot),
          authorAddress: ethers.getAddress(payload.authorAddress),
          authorAttestationR: ethers.getBytes(payload.authorAttestationR),
          authorAttestationVS: ethers.getBytes(payload.authorAttestationVS),
          authorSchemeVersion: AUTHOR_SCHEME_VERSION_V1,
          chainId: BigInt(payload.assertedAtChainId),
          kav10Address: ethers.getAddress(payload.assertedAtKav10Address),
          reservedKaId: BigInt(payload.reservedKaId),
          finalizedAtIso: payload.assertionFinalizedAt,
          contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
          kaUal: sealScope.ual,
          assertionVersion: sealScope.assertionVersion,
          publicTripleCount: Number(payload.publicTripleCount),
          ...(payload.privateMerkleRoot === null
            ? {}
            : { privateMerkleRoot: ethers.getBytes(payload.privateMerkleRoot) }),
          privateTripleCount: Number(payload.privateTripleCount),
        },
      },
    };
  } catch (error) {
    return { kind: 'rejected', reason: error instanceof Error ? error.message : String(error) };
  }
}

const SEAL_PREDICATES: ReadonlySet<string> = new Set(Object.values(ASSERTION_SEAL_PREDICATES));

/** Whether a verified seal was recorded at its coordinate, and if not, why. */
export type SharedMemoryAuthorSealKeepOutcome =
  | { readonly kind: 'kept' }
  | { readonly kind: 'refused'; readonly reason: string };

/** The value of an `xsd:integer` literal as the store returns it. */
function integerLiteralValue(term: string): bigint | undefined {
  const match = /^"(\d+)"/.exec(term);
  return match ? BigInt(match[1]!) : undefined;
}

/**
 * Record a verified seal and the share-complete marker under the author's
 * coordinate in `<cg>/_meta`, with the lifecycle's KA number and name, which
 * identifier reads match once this node has published the asset.
 *
 * A coordinate keeps the asset it was first bound to, as its seal and its
 * lifecycle's KA number name it. A stored seal is replaced only by a seal of
 * the same asset (the same UAL) at the same or a newer version: a seal of
 * another asset under the same name is refused, and so is an older version. A
 * coordinate this node published, but which names no asset to compare with,
 * is not bound again, so its VM pointer and its seal stay one asset. A
 * replacement clears both address spellings, so one coordinate never holds
 * two seals; other rows on these subjects, such as this node's own publish
 * receipt and VM pointer, are left alone. Callers serialize calls per
 * coordinate.
 */
export async function keepSharedMemoryAuthorSeal(
  store: TripleStore,
  kept: VerifiedSharedMemoryAuthorSeal,
): Promise<SharedMemoryAuthorSealKeepOutcome> {
  const { contextGraphId, subGraphName, assertionName, seal } = kept;
  const metaGraph = contextGraphMetaUri(contextGraphId);
  const author = seal.authorAddress;
  const spellings = [...new Set([author, author.toLowerCase()])];
  const sealSubjects = spellings.map((address) =>
    contextGraphAssertionUri(contextGraphId, address, assertionName, subGraphName));
  const lifecycleSubjects = spellings.map((address) =>
    assertionLifecycleUri(contextGraphId, address, assertionName, subGraphName));
  const subjects = [...sealSubjects, ...lifecycleSubjects]
    .map((subject) => `<${assertSafeIri(subject)}>`)
    .join(' ');
  // sparql-scan-allow: R4 -- exact CG meta graph and at most four exact subject IRIs (the seal and lifecycle subjects, two address spellings each) are bound by VALUES
  const current = await store.query(
    `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertSafeIri(metaGraph)}> { VALUES ?s { ${subjects} } ?s ?p ?o } }`,
    { source: 'publisher.swm.authorSeal.current' },
  );
  const rows = current.type === 'quads' ? current.quads : [];
  const sealRows = rows.filter((quad) => sealSubjects.includes(quad.subject));
  const lifecycleRows = rows.filter((quad) => lifecycleSubjects.includes(quad.subject));
  const incoming = createGraphKnowledgeAssetScope(seal.kaUal, seal.assertionVersion);
  const boundAssets = [
    ...sealRows
      .filter((quad) => quad.predicate === ASSERTION_SEAL_PREDICATES.KA_UAL)
      .map((quad) => ({ bound: unwrapIri(quad.object) === incoming.ual, name: unwrapIri(quad.object) })),
    ...lifecycleRows
      .filter((quad) => quad.predicate === KA_ID_PRED)
      .map((quad) => integerLiteralValue(quad.object))
      .map((number) => ({ bound: number === BigInt(incoming.kaNumber), name: `KA number ${number ?? '(unreadable)'}` })),
  ];
  const otherAsset = boundAssets.find((asset) => !asset.bound);
  if (otherAsset !== undefined) {
    return { kind: 'refused', reason: `"${assertionName}" is bound here to another asset, ${otherAsset.name}` };
  }
  const publishedHere = lifecycleRows.some((quad) => quad.predicate === VM_CURRENT_ASSERTION_PRED);
  if (publishedHere && boundAssets.length === 0) {
    return { kind: 'refused', reason: `"${assertionName}" was published here and names no asset to compare with` };
  }
  const incomingVersion = BigInt(seal.assertionVersion);
  const newerVersion = sealRows
    .filter((quad) => quad.predicate === ASSERTION_SEAL_PREDICATES.ASSERTION_VERSION)
    .map((quad) => integerLiteralValue(quad.object))
    .find((version) => version !== undefined && version > incomingVersion);
  if (newerVersion !== undefined) {
    return { kind: 'refused', reason: `version ${incomingVersion} is older than the kept version ${newerVersion}` };
  }
  const stale: Quad[] = rows
    .filter((quad) => (sealSubjects.includes(quad.subject)
      ? SEAL_PREDICATES.has(quad.predicate)
      : quad.predicate === SWM_SHARE_COMPLETE_PRED))
    .map((quad) => ({ ...quad, graph: metaGraph }));
  if (stale.length > 0) await store.delete(stale);
  const lifecycle = lifecycleSubjects[0]!;
  await store.insert([
    ...buildAssertionSealQuads({ ...seal, assertionUri: sealSubjects[0]!, metaGraph }),
    { subject: lifecycle, predicate: SWM_SHARE_COMPLETE_PRED, object: '"true"', graph: metaGraph },
    { subject: lifecycle, predicate: KA_ID_PRED, object: `"${incoming.kaNumber}"^^<${XSD_INTEGER}>`, graph: metaGraph },
    { subject: lifecycle, predicate: ASSERTION_NAME_PRED, object: `"${assertionName}"`, graph: metaGraph },
  ]);
  return { kind: 'kept' };
}

/** How a share reached this node: its gossip envelope, if any, and the bytes the envelope signs. */
export interface SharedMemoryShareDelivery {
  readonly envelope?: GossipEnvelopeMsg;
  readonly signedPayload: Uint8Array;
}

/**
 * Whether `author` signed this delivery of a share into `contextGraphId`. The
 * envelope signature covers the graph id and the whole share message, the
 * assertion name included. No freshness window applies: an aged envelope (a
 * retried or replayed share) proves the same authorship, and the share's own
 * version checks ran before.
 */
export function sharedMemoryShareSignedBy(
  delivery: SharedMemoryShareDelivery,
  contextGraphId: string,
  author: string,
): boolean {
  const { envelope } = delivery;
  if (
    !envelope?.signature?.length
    || envelope.version !== GOSSIP_ENVELOPE_VERSION
    || envelope.type !== GOSSIP_TYPE_WORKSPACE_PUBLISH
    || envelope.contextGraphId !== contextGraphId
  ) {
    return false;
  }
  try {
    const recovered = ethers.verifyMessage(
      computeGossipSigningPayload(envelope.type, envelope.contextGraphId, envelope.timestamp, delivery.signedPayload),
      ethers.hexlify(envelope.signature),
    );
    return knowledgeAssetAgentAddressesEqual(recovered, author)
      && knowledgeAssetAgentAddressesEqual(envelope.agentAddress, author);
  } catch {
    return false;
  }
}

/** The fields of a stored share that its author seal is judged against. */
export interface StoredSharedMemoryShare {
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly assertionName?: string;
  readonly authorSeal?: Uint8Array;
  readonly publicTripleCount?: number;
  readonly privateTripleCount?: number;
  readonly privateMerkleRoot?: Uint8Array;
}

/**
 * The receive side for `SharedMemoryHandler`: after a share's content is
 * stored, keep the author seal it carries. The author's own node keeps the
 * seal its finalize wrote, since its lifecycle owns that seal and the marker;
 * a node that does not keep a graph's seals (`keepsAuthorSeals`, the graph's
 * curator does) skips them. A seal is kept only from a share its author
 * signed; one that does not verify is logged and dropped. The share stands
 * either way.
 */
export class SharedMemoryAuthorSealKeeper {
  private readonly coordinateLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly store: TripleStore,
    private readonly log: Logger,
    private readonly options: {
      readonly localAgentAddresses?: () => readonly string[] | Promise<readonly string[]>;
      /** Whether this node keeps the seals of a graph's shares. Unset keeps them. */
      readonly keepsAuthorSeals?: (contextGraphId: string) => boolean | Promise<boolean>;
    } = {},
  ) {}

  /** Keep the seal `share` carries, judged against `storedQuads`, the public content stored for it. */
  async keep(
    ctx: OperationContext,
    share: StoredSharedMemoryShare,
    scope: Pick<GraphKnowledgeAssetScope, 'ual' | 'assertionVersion' | 'agentAddress'>,
    storedQuads: readonly Quad[],
    delivery: SharedMemoryShareDelivery,
  ): Promise<void> {
    if (!share.authorSeal?.length && !share.assertionName) return;
    const localAgents = this.options.localAgentAddresses ? await this.options.localAgentAddresses() : [];
    if (localAgents.some((agent) => knowledgeAssetAgentAddressesEqual(agent, scope.agentAddress))) return;
    if (this.options.keepsAuthorSeals && !(await this.options.keepsAuthorSeals(share.contextGraphId))) return;
    if (!sharedMemoryShareSignedBy(delivery, share.contextGraphId, scope.agentAddress)) {
      this.log.warn(ctx, `SWM author seal for ${scope.ual} not kept: the share is not signed by its author`);
      return;
    }
    const privateMerkleRoot = share.privateMerkleRoot?.length ? share.privateMerkleRoot : undefined;
    const verdict = verifySharedMemoryAuthorSeal(share, {
      contextGraphId: share.contextGraphId,
      ...(share.subGraphName ? { subGraphName: share.subGraphName } : {}),
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
      publicTripleCount: share.publicTripleCount ?? 0,
      privateTripleCount: share.privateTripleCount ?? 0,
      ...(privateMerkleRoot ? { privateMerkleRoot } : {}),
      merkleRoot: computeFlatKCRootV10(
        storedQuads.map((quad) => ({ ...quad, graph: '' })),
        privateMerkleRoot ? [privateMerkleRoot] : [],
      ),
    });
    if (verdict.kind !== 'verified') {
      if (verdict.kind === 'rejected') {
        this.log.warn(ctx, `SWM author seal for ${scope.ual} not kept: ${verdict.reason}`);
      }
      return;
    }
    const { verified } = verdict;
    const coordinate = [
      verified.contextGraphId,
      verified.subGraphName ?? '',
      verified.seal.authorAddress.toLowerCase(),
      verified.assertionName,
    ].join('\u0000');
    const outcome = await withKeyedLocks(
      this.coordinateLocks,
      [coordinate],
      () => keepSharedMemoryAuthorSeal(this.store, verified),
    );
    if (outcome.kind === 'refused') {
      this.log.warn(ctx, `SWM author seal for ${scope.ual} not kept: ${outcome.reason}`);
      return;
    }
    this.log.info(
      ctx,
      `Kept the author seal of "${verified.assertionName}" (${scope.ual} version ${scope.assertionVersion})`,
    );
  }
}
