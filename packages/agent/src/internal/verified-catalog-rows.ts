// SPDX-License-Identifier: Apache-2.0

import {
  canonicalizeAuthorCatalogRowV1,
  canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1,
  computeAuthorCatalogScopeDigestV1,
  deriveAuthorCatalogScopeFromHeadV1,
  parseCanonicalSignedAuthorCatalogHeadEnvelopeV1,
  readVerifiedCatalogSealBindingV1,
  readVerifiedCgSharedProjectionMetadataV1,
  readVerifiedTransferredCatalogBundleMetadataV1,
  verifyCatalogSealBindingV1,
  verifyCgSharedProjectionV1,
  verifyTransferredCatalogBundleV1,
  type AuthorCatalogRowV1,
  type AuthorCatalogScopeV1,
  type CatalogSealDeploymentProfileV1,
  type Digest32V1,
  type EvmAddressV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type VerifiedCatalogSealBindingSnapshotV1,
  type VerifiedCgSharedProjectionMetadataV1,
  type VerifiedTransferredCatalogBundleMetadataV1,
} from '@origintrail-official/dkg-core';

import { assertRecoverableAuthorAttestationCapabilityV1 } from
  '../rfc64/recoverable-author-attestation-v1.js';

/**
 * GH#3081 / GH#3072 — rows of an author catalog that this process has already verified.
 *
 * A successor repeats every row of its predecessor but one, and exact verification of a row (its
 * seal binding, the recovery of its author attestation, its transferred bundle and its shared
 * projection) reads nothing but the catalog scope, the pinned deployment, the canonical row and
 * the bundle bytes that row's digests commit to. It is a pure function of those: no authority,
 * policy, delegation, clock or predecessor is consulted. So a row is verified once, and its
 * outcome is found again by exactly those inputs:
 *
 * - the scope by its digest and the deployment by its three pins;
 * - the row by its canonical string;
 * - the bytes by the row itself: a production builds each row from the digests it has just
 *   computed over the bytes it holds, and a row is looked up only when the signed row is that row.
 *
 * What a successor's own objects decide is not remembered and runs every time: the head, path and
 * bucket signatures, the directory path, the bucket closure with its delegation and interval, the
 * predecessor chain and the one-row delta. Only a production that completed remembers its rows, a
 * failed one forgets all of them, and a set holds the rows of one successor at most. Nothing here
 * is persisted.
 */

/** What exact verification of one row established, without the head it was read under. */
export interface VerifiedCatalogRowV1 {
  readonly transfer: Omit<VerifiedTransferredCatalogBundleMetadataV1, 'headObjectDigest' | 'headIssuer'>;
  readonly projection: Omit<VerifiedCgSharedProjectionMetadataV1, 'headObjectDigest'>;
}

/** The scope and deployment a row is verified under, or undefined when they cannot name one. */
function bindingKeyV1(
  scope: AuthorCatalogScopeV1,
  deployment: CatalogSealDeploymentProfileV1,
): string | undefined {
  const pins = [deployment.networkId, deployment.assertedAtChainId, deployment.assertedAtKav10Address];
  // A pin that is not a string is refused by the verifier; it must not read as one that is.
  if (pins.some((pin) => typeof pin !== 'string')) return undefined;
  return [computeAuthorCatalogScopeDigestV1(scope), ...pins].join('\n');
}

/**
 * What a production is given: where it looks up rows this process verified, and where it files
 * the rows of the successor it completed. Whoever owns the storage decides what is kept (the
 * catalog mutation memory keeps it within its byte budget); a production never changes by itself
 * how much is retained.
 */
export interface Rfc64VerifiedCatalogRowsV1 {
  /** Rows remembered now. */
  readonly size: number;
  /** The outcome for exactly this row under exactly this scope and deployment. */
  find(binding: string | undefined, canonicalRow: string): VerifiedCatalogRowV1 | undefined;
  /** A successor completed: its rows, and only they, are the remembered set. */
  replace(binding: string | undefined, rows: ReadonlyMap<string, VerifiedCatalogRowV1>): void;
  /**
   * A production failed: nothing remembered about this catalog is trusted again. For a set that
   * stands alone that is its rows; the catalog mutation memory forgets the scope's state as well.
   */
  invalidate(): void;
}

/** The verified rows of one author catalog scope: those of its latest completed successor. */
export class Rfc64VerifiedCatalogRowSetV1 implements Rfc64VerifiedCatalogRowsV1 {
  #binding: string | undefined;
  #rows: ReadonlyMap<string, VerifiedCatalogRowV1> = new Map();

  get size(): number {
    return this.#rows.size;
  }

  find(binding: string | undefined, canonicalRow: string): VerifiedCatalogRowV1 | undefined {
    if (binding === undefined || binding !== this.#binding) return undefined;
    return this.#rows.get(canonicalRow);
  }

  replace(binding: string | undefined, rows: ReadonlyMap<string, VerifiedCatalogRowV1>): void {
    if (binding === undefined || rows.size === 0) {
      this.clear();
      return;
    }
    this.#binding = binding;
    this.#rows = new Map(rows);
  }

  invalidate(): void {
    this.clear();
  }

  /** Empty the set. */
  clear(): void {
    this.#binding = undefined;
    this.#rows = new Map();
  }
}

/** The fields of a prepared successor row that its verification reads. */
export interface PreparedSuccessorRowV1 {
  readonly deployment: CatalogSealDeploymentProfileV1;
  readonly scope: AuthorCatalogScopeV1;
  readonly row: Readonly<AuthorCatalogRowV1>;
  readonly sealBytes: Uint8Array;
  readonly bundleBytes: Uint8Array;
}

export interface VerifiedSuccessorRowV1<Prepared extends PreparedSuccessorRowV1> {
  readonly prepared: Prepared;
  readonly row: Readonly<AuthorCatalogRowV1>;
  readonly sealBinding: VerifiedCatalogSealBindingSnapshotV1;
  readonly transfer: VerifiedTransferredCatalogBundleMetadataV1;
  readonly projection: VerifiedCgSharedProjectionMetadataV1;
}

/** The scope and deployment of the rows being prepared, resolved once for the objects that carry them. */
interface PreparedBindingV1 {
  readonly scope: object;
  readonly deployment: object;
  readonly binding: string | undefined;
}

/** The produced head as the row verifier reads it, resolved once for the head object. */
interface ProducedBindingV1 {
  readonly head: object;
  readonly deployment: object;
  readonly objectDigest: Digest32V1;
  readonly issuer: EvmAddressV1;
  readonly binding: string | undefined;
}

/**
 * The row verification of one successor production. Without a remembered set every row is
 * verified in full and nothing else runs; that is also what a row not found in the set gets.
 */
export class Rfc64SuccessorRowVerificationV1 {
  readonly #remembered: Rfc64VerifiedCatalogRowsV1 | undefined;
  readonly #verified = new Map<string, VerifiedCatalogRowV1>();
  readonly #canonicalRows = new WeakMap<object, string>();
  #preparedBinding: PreparedBindingV1 | undefined;
  #producedBinding: ProducedBindingV1 | undefined;

  constructor(remembered?: Rfc64VerifiedCatalogRowsV1) {
    this.#remembered = remembered;
  }

  /** Before anything is signed: the seal binds to the exact row and its author attestation recovers. */
  assertSealBinds(prepared: PreparedSuccessorRowV1): void {
    if (this.#remembered !== undefined) {
      const canonicalRow = canonicalizeAuthorCatalogRowV1(prepared.row);
      this.#canonicalRows.set(prepared, canonicalRow);
      if (this.#remembered.find(this.#bindingOfPrepared(prepared), canonicalRow) !== undefined) return;
    }
    const sealBinding = verifyCatalogSealBindingV1(
      prepared.scope,
      prepared.row,
      prepared.sealBytes,
      prepared.deployment,
    );
    assertRecoverableAuthorAttestationCapabilityV1(readVerifiedCatalogSealBindingV1(sealBinding));
  }

  /** After signing: exact verification of one produced row under the head that names it. */
  verifyProduced<Prepared extends PreparedSuccessorRowV1>(
    head: SignedAuthorCatalogHeadEnvelopeV1,
    producedRow: Readonly<AuthorCatalogRowV1>,
    prepared: Prepared,
  ): VerifiedSuccessorRowV1<Prepared> {
    const reuse = this.#remembered === undefined
      ? undefined
      : this.#reusable(this.#remembered, head, producedRow, prepared);
    if (reuse?.outcome !== undefined) {
      const { produced, outcome } = reuse;
      this.#verified.set(reuse.canonicalRow, outcome);
      return {
        prepared,
        row: producedRow,
        sealBinding: readVerifiedCatalogSealBindingV1(outcome.transfer.catalogSealBinding),
        transfer: Object.freeze({
          headObjectDigest: produced.objectDigest,
          headIssuer: produced.issuer,
          ...outcome.transfer,
        }),
        projection: Object.freeze({ headObjectDigest: produced.objectDigest, ...outcome.projection }),
      };
    }
    const transferred = verifyTransferredCatalogBundleV1(
      head,
      producedRow,
      prepared.bundleBytes,
      prepared.deployment,
    );
    const transfer = readVerifiedTransferredCatalogBundleMetadataV1(
      transferred,
      head,
      producedRow,
      prepared.deployment,
    );
    const sealBinding = readVerifiedCatalogSealBindingV1(transfer.catalogSealBinding);
    assertRecoverableAuthorAttestationCapabilityV1(sealBinding);
    const verifiedProjection = verifyCgSharedProjectionV1(
      transferred,
      head,
      producedRow,
      prepared.deployment,
    );
    const projection = readVerifiedCgSharedProjectionMetadataV1(
      verifiedProjection,
      transferred,
      head,
      producedRow,
      prepared.deployment,
    );
    if (reuse !== undefined) {
      const { headObjectDigest: _transferHead, headIssuer: _headIssuer, ...transferOutcome } = transfer;
      const { headObjectDigest: _projectionHead, ...projectionOutcome } = projection;
      this.#verified.set(reuse.canonicalRow, Object.freeze({
        transfer: Object.freeze(transferOutcome),
        projection: Object.freeze(projectionOutcome),
      }));
    }
    return { prepared, row: producedRow, sealBinding, transfer, projection };
  }

  /** The production completed: exactly its rows are remembered. */
  complete(): void {
    this.#remembered?.replace(this.#producedBinding?.binding, this.#verified);
  }

  /** The production failed: nothing verified for this catalog is trusted again. */
  abandon(): void {
    this.#remembered?.invalidate();
  }

  /** What a remembered set holds for one produced row, and where a fresh outcome is filed. */
  #reusable(
    remembered: Rfc64VerifiedCatalogRowsV1,
    head: SignedAuthorCatalogHeadEnvelopeV1,
    producedRow: Readonly<AuthorCatalogRowV1>,
    prepared: PreparedSuccessorRowV1,
  ): Readonly<{ produced: ProducedBindingV1; canonicalRow: string; outcome: VerifiedCatalogRowV1 | undefined }> {
    const produced = this.#bindingOfProduced(head, prepared.deployment);
    const canonicalRow = canonicalizeAuthorCatalogRowV1(producedRow);
    return {
      produced,
      canonicalRow,
      // The signed row must be the row this production built from the bytes it holds.
      outcome: canonicalRow === this.#canonicalRows.get(prepared)
        ? remembered.find(produced.binding, canonicalRow)
        : undefined,
    };
  }

  #bindingOfPrepared(prepared: PreparedSuccessorRowV1): string | undefined {
    const known = this.#preparedBinding;
    if (known?.scope === prepared.scope && known.deployment === prepared.deployment) return known.binding;
    this.#preparedBinding = {
      scope: prepared.scope,
      deployment: prepared.deployment,
      binding: bindingKeyV1(prepared.scope, prepared.deployment),
    };
    return this.#preparedBinding.binding;
  }

  /**
   * One canonical snapshot of the produced head, as the row verifier takes of it, and the scope
   * that snapshot names: a remembered row is found only under that scope.
   */
  #bindingOfProduced(
    head: SignedAuthorCatalogHeadEnvelopeV1,
    deployment: CatalogSealDeploymentProfileV1,
  ): ProducedBindingV1 {
    const known = this.#producedBinding;
    if (known?.head === head && known.deployment === deployment) return known;
    const snapshot = parseCanonicalSignedAuthorCatalogHeadEnvelopeV1(
      canonicalizeSignedAuthorCatalogHeadEnvelopeBytesV1(head),
    );
    this.#producedBinding = {
      head,
      deployment,
      objectDigest: snapshot.objectDigest as Digest32V1,
      issuer: snapshot.issuer as EvmAddressV1,
      binding: bindingKeyV1(deriveAuthorCatalogScopeFromHeadV1(snapshot.payload), deployment),
    };
    return this.#producedBinding;
  }
}
