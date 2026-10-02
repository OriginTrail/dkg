import type Database from 'better-sqlite3';
import type { KaNumberStore } from '@origintrail-official/dkg-core';
import type { NodeStoreDatabaseHandle } from './database-handle.js';

/**
 * SQLite-backed `KaNumberStore` against the V20 `ka_numbers` table.
 * Per-author durable KA-number allocator for OT-RFC-43 Option-1
 * deterministic KA identity (B2 allocator core, OFF-CHAIN only).
 *
 * Keyed by the attested author address (stored lowercase). Every
 * method is a single prepared statement; the read-and-increment in
 * `allocate` is atomic via `INSERT … ON CONFLICT DO UPDATE …
 * RETURNING`, so concurrent allocations under the same author never
 * collide on a number (the same atomic-single-statement contract the
 * other Sqlite*Store classes rely on — there is no `.transaction()`
 * in this module).
 *
 * **Counter width (codex PR #976 F6):** every value crossing the
 * `KaNumberStore` interface is a `bigint`. `better-sqlite3` returns
 * INTEGER columns as JS `number` by default — which silently truncates
 * once a counter passes `Number.MAX_SAFE_INTEGER (2^53 - 1)`. Each
 * statement here opts into `.safeIntegers(true)`, returning `bigint`
 * directly so `allocate()`, `peekNext()` and `observed + 1n` stay
 * exact across the full SQLite signed INTEGER range (`2^63 - 1`). The
 * RFC's worst-case load ("1000 alloc/s × 1M years ≈ 2^55") sits well
 * past the `2^53` precision cliff and far under the `2^63` hard
 * ceiling; if a single author ever does approach `2^63`, SQLite raises
 * an INTEGER overflow on the next increment — a fail-loud surface
 * that's strictly preferable to a silent kaId-collision risk.
 *
 * Like `protocol_outbox`, this state is durable: it is NEVER added to
 * `prune()`. Reclaiming a number could re-mint a kaId already used
 * on-chain under that author.
 */
export class SqliteKaNumberStore implements KaNumberStore {
  private readonly db: Database.Database;

  constructor(database: NodeStoreDatabaseHandle) {
    this.db = database.db;
  }

  allocate(authorAddress: string): bigint {
    const author = authorAddress.toLowerCase();
    // Atomic read-and-increment. `next_number` is the value to hand
    // out; we increment it and RETURN the value just consumed
    // (`next_number - 1` after the update), so the first call for an
    // author returns 0n. On first insert `next_number` starts at 1, so
    // `1 - 1 = 0` is returned there too — uniform either way.
    // `safeIntegers(true)` opts INTO bigint returns so the counter is
    // exact past `Number.MAX_SAFE_INTEGER` (codex PR #976 F6).
    const row = this.db
      .prepare(
        `INSERT INTO ka_numbers (author_address, next_number)
         VALUES (?, 1)
         ON CONFLICT(author_address) DO UPDATE SET next_number = next_number + 1
         RETURNING next_number - 1 AS number`,
      )
      .safeIntegers(true)
      .get(author) as { number: bigint };
    return row.number;
  }

  reconcileFloor(authorAddress: string, nextNumberFloor: bigint): void {
    const author = authorAddress.toLowerCase();
    // Raise `next_number` to at least the floor, never lowering it.
    // `excluded.next_number` is the proposed floor from the VALUES row.
    // `better-sqlite3` accepts bigint statement parameters natively.
    this.db
      .prepare(
        `INSERT INTO ka_numbers (author_address, next_number)
         VALUES (?, ?)
         ON CONFLICT(author_address) DO UPDATE SET
           next_number = MAX(next_number, excluded.next_number)`,
      )
      .run(author, nextNumberFloor);
  }

  peekNext(authorAddress: string): bigint {
    const author = authorAddress.toLowerCase();
    const row = this.db
      .prepare(`SELECT next_number FROM ka_numbers WHERE author_address = ?`)
      .safeIntegers(true)
      .get(author) as { next_number: bigint } | undefined;
    return row?.next_number ?? 0n;
  }
}
