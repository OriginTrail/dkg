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
 * A receiver keeps the seal only when the signature recovers the asset's
 * author and the seal commits to exactly the content the share delivered. It
 * then records the seal and the share-complete marker under the author's
 * coordinate in the graph's `_meta`, which is where VM publish looks for them.
 * The name is not signed; it is a local handle. Whatever name a seal is kept
 * under, publishing it publishes only what the author sealed.
 */

import {
  ASSERTION_SEAL_PREDICATES,
  AUTHOR_SCHEME_VERSION_V1,
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  assertSafeIri,
  assertionLifecycleUri,
  buildAssertionSealQuads,
  buildAuthorAttestationTypedData,
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  canonicalizeCanonicalGraphScopedAuthorSealBytesV1,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  createGraphKnowledgeAssetScope,
  parseCanonicalGraphScopedAuthorSealV1,
  validateAssertionName,
  type AssertionSeal,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

/**
 * #1116 (review A1) — marker predicate stamped on the lifecycle URN when a KA
 * has been FULLY shared to SWM (entities:"all", all roots landed). It gates
 * finalize(layer:"swm") and VM publish, so a subset share — which also stamps
 * dkg:rootEntity member rows — cannot be sealed-in-SWM and published as a
 * partial asset. A node that keeps a received seal stamps it as well: the seal
 * was verified against the complete content the share stored.
 */
export const SWM_SHARE_COMPLETE_PRED = 'http://dkg.io/ontology/swmShareComplete';

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

/** A seal that recovers its author and commits to the share's content. */
export interface VerifiedSharedMemoryAuthorSeal {
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly assertionName: string;
  /** Graph-scoped v2 seal, its addresses in EIP-55 form. */
  readonly seal: AssertionSeal;
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
          rootEntities: [],
        },
      },
    };
  } catch (error) {
    return { kind: 'rejected', reason: error instanceof Error ? error.message : String(error) };
  }
}

const SEAL_PREDICATES: ReadonlySet<string> = new Set(Object.values(ASSERTION_SEAL_PREDICATES));

/**
 * Record a verified seal and the share-complete marker under the author's
 * coordinate in `<cg>/_meta`, replacing an earlier seal of that coordinate.
 * Both address spellings are cleared, so one coordinate never holds two
 * seals. Other rows on these subjects, such as this node's own publish receipt
 * and VM pointer, are left alone.
 */
export async function keepSharedMemoryAuthorSeal(
  store: TripleStore,
  kept: VerifiedSharedMemoryAuthorSeal,
): Promise<void> {
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
  const current = await store.query(
    `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertSafeIri(metaGraph)}> { VALUES ?s { ${subjects} } ?s ?p ?o } }`,
    { source: 'publisher.swm.authorSeal.current' },
  );
  const stale: Quad[] = (current.type === 'quads' ? current.quads : [])
    .filter((quad) => (sealSubjects.includes(quad.subject)
      ? SEAL_PREDICATES.has(quad.predicate)
      : quad.predicate === SWM_SHARE_COMPLETE_PRED))
    .map((quad) => ({ ...quad, graph: metaGraph }));
  if (stale.length > 0) await store.delete(stale);
  await store.insert([
    ...buildAssertionSealQuads({
      assertionUri: sealSubjects[0]!,
      metaGraph,
      merkleRoot: seal.merkleRoot,
      authorAddress: author,
      authorAttestationR: seal.authorAttestationR,
      authorAttestationVS: seal.authorAttestationVS,
      authorSchemeVersion: seal.authorSchemeVersion,
      chainId: seal.chainId,
      kav10Address: seal.kav10Address,
      reservedKaId: seal.reservedKaId!,
      finalizedAtIso: seal.finalizedAtIso,
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: seal.kaUal!,
      assertionVersion: seal.assertionVersion!,
      publicTripleCount: seal.publicTripleCount!,
      ...(seal.privateMerkleRoot ? { privateMerkleRoot: seal.privateMerkleRoot } : {}),
      privateTripleCount: seal.privateTripleCount!,
    }),
    { subject: lifecycleSubjects[0]!, predicate: SWM_SHARE_COMPLETE_PRED, object: '"true"', graph: metaGraph },
  ]);
}
