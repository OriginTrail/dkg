// SPDX-License-Identifier: Apache-2.0

import { MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 } from '@origintrail-official/dkg-core';

/** The typed code of {@link AuthorCatalogFullErrorV1}. */
export const AUTHOR_CATALOG_FULL_CODE_V1 = 'catalog-full';

/** A catalog row as far as capacity goes: the asset it places. */
type HeldCatalogRowV1 = Readonly<{ seal: Readonly<{ kaUal: string }> }>;

/**
 * GH#3134 — the most rows one author catalog holds on this node, over all its buckets. It is
 * above the 100,000 rows catalogs are validated at, and a catalog of typical rows that size stays
 * within 256 buckets, one directory node.
 */
export const MAX_AUTHOR_CATALOG_ROWS_V1 = 131_072;

/**
 * GH#3134 — a bucket of an author catalog holds at most {@link MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1}
 * rows, and a full bucket has no row for a NEW asset. Where the catalog moves to more buckets, a
 * full bucket moves it first, and only a catalog at {@link MAX_AUTHOR_CATALOG_ROWS_V1} refuses.
 * This is that refusal, raised from the row count before a successor is built, signed, committed
 * or announced. A newer version of an asset the catalog already holds replaces its row, and a
 * removal frees one, so neither is refused here.
 */
export class AuthorCatalogFullErrorV1 extends Error {
  readonly code = AUTHOR_CATALOG_FULL_CODE_V1;
  /** Rows the refusing catalog may hold: one bucket's, or the node's maximum for a catalog. */
  readonly rowCap: number;
  /** Rows the refusing catalog holds. */
  readonly rowCount: number;
  /** The assets the refusing bucket holds, by UAL: placing one of them again replaces its row. */
  readonly heldKaUals: ReadonlySet<string>;

  constructor(
    held: readonly HeldCatalogRowV1[],
    /** Rows for new assets the refused change asked for. */
    readonly newRows: number,
    /** A catalog refused at the node's maximum: its row count and that maximum. */
    limit?: Readonly<{ rowCount: number; rowCap: number }>,
  ) {
    const rowCount = limit?.rowCount ?? held.length;
    const rowCap = limit?.rowCap ?? MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1;
    super(`RFC-64 author catalog holds ${rowCount} of ${rowCap} rows and cannot take ${newRows} more`);
    this.name = 'AuthorCatalogFullErrorV1';
    this.rowCap = rowCap;
    this.rowCount = rowCount;
    this.heldKaUals = new Set(held.map(({ seal }) => seal.kaUal));
  }
}

/** Refuse `newRows` rows for new assets when the catalog that holds `held` has no room for them. */
export function assertAuthorCatalogTakesNewRowsV1(held: readonly HeldCatalogRowV1[], newRows: number): void {
  if (held.length + newRows > MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1) {
    throw new AuthorCatalogFullErrorV1(held, newRows);
  }
}

/**
 * GH#3134 — refuse a new row for a catalog of `totalRows` at the node's maximum; `held` are the
 * assets of the bucket the new row would go to.
 */
export function assertAuthorCatalogUnderMaximumV1(
  totalRows: number,
  held: readonly HeldCatalogRowV1[],
  newRows: number,
): void {
  if (totalRows + newRows > MAX_AUTHOR_CATALOG_ROWS_V1) {
    throw new AuthorCatalogFullErrorV1(held, newRows, { rowCount: totalRows, rowCap: MAX_AUTHOR_CATALOG_ROWS_V1 });
  }
}

/**
 * GH#3134 — whether a full bucket moves its catalog to more buckets. Off unless
 * `DKG_RFC64_CATALOG_BUCKET_MOVES=1`: until receivers apply a moved catalog, a full bucket refuses
 * new rows as before and the placement is parked.
 */
export function authorCatalogBucketMovesEnabledV1(): boolean {
  return process.env.DKG_RFC64_CATALOG_BUCKET_MOVES?.trim() === '1';
}

/** The typed refusal that `error` is or was caused by, if any. */
export function findAuthorCatalogFullErrorV1(error: unknown): AuthorCatalogFullErrorV1 | undefined {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth++) {
    if (current instanceof AuthorCatalogFullErrorV1) return current;
    if (seen.has(current)) return undefined;
    seen.add(current);
    try {
      current = Reflect.get(current, 'cause');
    } catch {
      return undefined;
    }
  }
  return undefined;
}
