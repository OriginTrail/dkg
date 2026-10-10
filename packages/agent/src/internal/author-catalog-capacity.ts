// SPDX-License-Identifier: Apache-2.0

import { MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 } from '@origintrail-official/dkg-core';

/** The typed code of {@link AuthorCatalogFullErrorV1}. */
export const AUTHOR_CATALOG_FULL_CODE_V1 = 'catalog-full';

/** A catalog row as far as capacity goes: the asset it places. */
type HeldCatalogRowV1 = Readonly<{ seal: Readonly<{ kaUal: string }> }>;

/**
 * GH#3134 — an author catalog is one signed bucket of at most
 * {@link MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1} rows, and a catalog at that cap has no row for a NEW
 * asset. This is that refusal, raised from the row count before a successor is built, signed,
 * committed or announced. A newer version of an asset the catalog already holds replaces its row,
 * and a removal frees one, so neither is refused here.
 *
 * Local and descriptive only: the cap, the signed catalog format and the wire are unchanged. What
 * a full catalog should do instead (more buckets, an eviction rule) is not decided here.
 */
export class AuthorCatalogFullErrorV1 extends Error {
  readonly code = AUTHOR_CATALOG_FULL_CODE_V1;
  readonly rowCap = MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1;
  /** Rows the catalog holds. */
  readonly rowCount: number;
  /** The assets those rows place, by UAL: placing one of them again replaces its row. */
  readonly heldKaUals: ReadonlySet<string>;

  constructor(
    held: readonly HeldCatalogRowV1[],
    /** Rows for new assets the refused change asked for. */
    readonly newRows: number,
    /** The applied head the rows were read under, when the caller read one. */
    readonly appliedHeadDigest: string | null = null,
  ) {
    super(
      `RFC-64 author catalog holds ${held.length} of ${MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1} rows`
        + ` and cannot take ${newRows} more`,
    );
    this.name = 'AuthorCatalogFullErrorV1';
    this.rowCount = held.length;
    this.heldKaUals = new Set(held.map(({ seal }) => seal.kaUal));
  }
}

/** Refuse `newRows` rows for new assets when the catalog that holds `held` has no room for them. */
export function assertAuthorCatalogTakesNewRowsV1(
  held: readonly HeldCatalogRowV1[],
  newRows: number,
  appliedHeadDigest: string | null = null,
): void {
  if (held.length + newRows > MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1) {
    throw new AuthorCatalogFullErrorV1(held, newRows, appliedHeadDigest);
  }
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
