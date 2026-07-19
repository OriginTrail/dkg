import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  INVENTORY_V1_DDL,
  INVENTORY_V1_PLAN_STATEMENT_KEYS,
  INVENTORY_V1_STATEMENT_IDS,
  INVENTORY_V1_STATEMENT_SQL,
  type InventoryV1StatementKey,
} from '../src/rfc64/inventory-v1/index.js';

const NEW_SESSION_HEX = '11'.repeat(32);
const OLD_SESSION_HEX = '22'.repeat(32);
const SCOPE_HEX = '33'.repeat(32);
const AUTHOR_HEX = '44'.repeat(20);
const NEW_HEAD_HEX = '55'.repeat(32);
const OLD_HEAD_HEX = '66'.repeat(32);
const BUCKET_COUNT_HEX = '0000000000000200';
const SELECTED_BUCKET_HEX = '0000000000000001';

type PlanStatementKey = typeof INVENTORY_V1_PLAN_STATEMENT_KEYS[number];
type PlanClass = Readonly<Record<PlanStatementKey, readonly string[]>>;

describe('RFC-64 SQL-1 candidate fixed-statement plan gate', () => {
  it('assigns one unique stable ID to every production SQL template', () => {
    expect(Object.keys(INVENTORY_V1_STATEMENT_IDS).sort())
      .toEqual(Object.keys(INVENTORY_V1_STATEMENT_SQL).sort());
    expect(new Set(Object.values(INVENTORY_V1_STATEMENT_IDS)).size)
      .toBe(Object.keys(INVENTORY_V1_STATEMENT_IDS).length);
  });

  it('keeps every persistent statement indexed on a fresh empty schema without statistics', () => {
    const database = createFixtureDatabase(INVENTORY_V1_DDL, false);
    try {
      expect(() => database.prepare(
        'SELECT count(*) AS count FROM sqlite_stat1',
      ).get()).toThrowError();
      expectPlanGate(collectPlanClass(database));
    } finally {
      database.close();
    }
  });

  it('keeps every persistent statement indexed and plan-stable at 50k and 500k rows', () => {
    const database = createFixtureDatabase();
    try {
      seedRows(database, 1, 49_999, NEW_SESSION_HEX, NEW_HEAD_HEX);
      seedRows(database, 50_000, 50_000, OLD_SESSION_HEX, OLD_HEAD_HEX);
      const withoutStats = collectPlanClass(database);
      expectPlanGate(withoutStats);

      database.exec('ANALYZE; PRAGMA optimize;');
      const at50k = collectPlanClass(database);
      expectPlanGate(at50k);

      seedRows(database, 50_001, 500_000, NEW_SESSION_HEX, NEW_HEAD_HEX);
      database.exec('ANALYZE; PRAGMA optimize;');
      const at500k = collectPlanClass(database);
      expectPlanGate(at500k);

      // Estimated cardinalities may change, but the selected indexes and join
      // order must not change with one decimal order of magnitude more rows.
      expect(at500k).toEqual(at50k);
      expect(withoutStats).toEqual(at50k);
    } finally {
      database.close();
    }
  }, 60_000);

  it('fails the gate for the old head-wide-KA physical primary key', () => {
    const database = createFixtureDatabase(oldHeadWidePrimaryKeyDdl());
    try {
      seedRows(database, 1, 50_000, NEW_SESSION_HEX, NEW_HEAD_HEX);
      const oldPhysicalKey = collectPlanClass(database);
      expect(() => expectPlanGate(oldPhysicalKey)).toThrowError();
    } finally {
      database.close();
    }
  }, 60_000);

  it('fails the gate when the bucket-first primary key lacks head-wide KA uniqueness', () => {
    const database = createFixtureDatabase(withoutHeadWideKaUniqueDdl());
    try {
      seedRows(database, 1, 50_000, NEW_SESSION_HEX, NEW_HEAD_HEX);
      const missingHeadWideLookup = collectPlanClass(database);
      expect(() => expectPlanGate(missingHeadWideLookup)).toThrowError();
    } finally {
      database.close();
    }
  }, 60_000);
});

function createFixtureDatabase(
  ddl = INVENTORY_V1_DDL,
  withHeaders = true,
): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = MEMORY;');
  database.exec(ddl);
  if (withHeaders) {
    insertHeaders(database, NEW_SESSION_HEX, NEW_HEAD_HEX);
    insertHeaders(database, OLD_SESSION_HEX, OLD_HEAD_HEX);
  }
  return database;
}

function insertHeaders(database: DatabaseSync, sessionHex: string, headHex: string): void {
  database.exec(`
    WITH RECURSIVE buckets(bucket_id) AS (
      VALUES(0)
      UNION ALL
      SELECT bucket_id + 1 FROM buckets WHERE bucket_id < 511
    )
    INSERT INTO rfc64_candidate_bucket_loads_v1 (
      session_id,
      catalog_scope_digest,
      author_address,
      target_catalog_head_digest,
      subgraph_name,
      catalog_era_u64be,
      bucket_count_u64be,
      bucket_id_u64be,
      bucket_object_digest,
      row_count_u64be,
      payload_byte_length_u64be
    )
    SELECT
      x'${sessionHex}',
      x'${SCOPE_HEX}',
      x'${AUTHOR_HEX}',
      x'${headHex}',
      NULL,
      zeroblob(8),
      x'${BUCKET_COUNT_HEX}',
      unhex(printf('%016x', bucket_id)),
      x'${'77'.repeat(32)}',
      x'0000000000000001',
      x'0000000000000001'
    FROM buckets;
  `);
}

function seedRows(
  database: DatabaseSync,
  first: number,
  last: number,
  sessionHex: string,
  headHex: string,
): void {
  database.exec(`
    WITH RECURSIVE numbers(n) AS (
      VALUES(${first})
      UNION ALL
      SELECT n + 1 FROM numbers WHERE n < ${last}
    )
    INSERT INTO rfc64_candidate_bucket_rows_v1 (
      session_id,
      catalog_scope_digest,
      author_address,
      target_catalog_head_digest,
      bucket_id_u64be,
      ka_id_u256be,
      catalog_key_digest,
      assertion_coordinate,
      assertion_version_u64be,
      projection_id,
      projection_digest,
      seal_digest,
      transfer_codec,
      transfer_byte_length_u64be,
      transfer_chunk_size_u64be,
      transfer_chunk_count_u64be,
      transfer_blob_digest,
      transfer_chunk_tree_root,
      expected_catalog_row_digest
    )
    SELECT
      x'${sessionHex}',
      x'${SCOPE_HEX}',
      x'${AUTHOR_HEX}',
      x'${headHex}',
      unhex(printf('%016x', n % 512)),
      unhex('${AUTHOR_HEX}' || printf('%024x', n)),
      unhex(printf('%064x', n)),
      'fixture-row-' || n,
      x'0000000000000001',
      'cg-shared-v1',
      x'${'88'.repeat(32)}',
      x'${'99'.repeat(32)}',
      'dkg-ka-bundle-v1',
      x'0000000000000010',
      x'0000000000040000',
      x'0000000000000001',
      x'${'aa'.repeat(32)}',
      x'${'bb'.repeat(32)}',
      unhex(printf('%064x', n))
    FROM numbers;
  `);
}

function collectPlanClass(database: DatabaseSync): PlanClass {
  const plans = {} as Record<PlanStatementKey, readonly string[]>;
  for (const statementId of INVENTORY_V1_PLAN_STATEMENT_KEYS) {
    const sql = INVENTORY_V1_STATEMENT_SQL[statementId];
    const rows = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(parametersFor(sql));
    plans[statementId] = rows.map((row) => normalizePlanDetail(row.detail));
  }
  return Object.freeze(plans);
}

function parametersFor(sql: string): Record<string, Uint8Array | number> {
  const all: Readonly<Record<string, Uint8Array | number>> = {
    session: hexBytes(NEW_SESSION_HEX),
    oldSession: hexBytes(OLD_SESSION_HEX),
    newSession: hexBytes(NEW_SESSION_HEX),
    scope: hexBytes(SCOPE_HEX),
    author: hexBytes(AUTHOR_HEX),
    head: hexBytes(NEW_HEAD_HEX),
    oldHead: hexBytes(OLD_HEAD_HEX),
    newHead: hexBytes(NEW_HEAD_HEX),
    bucket: hexBytes(SELECTED_BUCKET_HEX),
    afterKaIdU256be: hexBytes(`${AUTHOR_HEX}${'00'.repeat(11)}01`),
    limit: 256,
  };
  const names = [...sql.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]!);
  return Object.fromEntries([...new Set(names)].map((name) => [name, all[name]!]));
}

function normalizePlanDetail(value: unknown): string {
  if (typeof value !== 'string') throw new Error('SQLite returned a non-text plan detail');
  return value.replace(/\s+/g, ' ').trim();
}

function expectPlanGate(plans: PlanClass): void {
  const allDetails = Object.entries(plans).flatMap(([statementId, details]) =>
    details.map((detail) =>
      `${INVENTORY_V1_STATEMENT_IDS[statementId as InventoryV1StatementKey]}: ${detail}`));
  expect(allDetails, 'persistent statements must never scan owned tables')
    .not.toEqual(expect.arrayContaining([
      expect.stringMatching(/\bSCAN rfc64_candidate_(?:bucket_loads|bucket_rows)_v1\b/i),
    ]));
  expect(allDetails, 'persistent statements must never materialize a sort')
    .not.toEqual(expect.arrayContaining([expect.stringMatching(/USE TEMP B-TREE/i)]));

  expect(
    plans.getHeader.some((detail) =>
      detail.includes('USING PRIMARY KEY') && detail.includes('bucket_id_u64be=?')),
    `${INVENTORY_V1_STATEMENT_IDS.getHeader} must use the exact load primary key`,
  ).toBe(true);

  for (const statementId of [
    'getRowsFirst',
    'getRowsNext',
    'getRowsExactRetry',
    'countBucketRows',
  ] as const) {
    expect(
      plans[statementId].some((detail) =>
        detail.includes('USING PRIMARY KEY') && detail.includes('bucket_id_u64be=?')),
      `${INVENTORY_V1_STATEMENT_IDS[statementId]} must use the bucket-first physical key`,
    ).toBe(true);
  }

  for (const statementId of [
    'diffAddedOrChangedFirst',
    'diffAddedOrChangedNext',
    'diffRemovedFirst',
    'diffRemovedNext',
  ] as const) {
    expect(
      plans[statementId].some((detail) =>
        detail.includes('USING PRIMARY KEY') && detail.includes('bucket_id_u64be=?')),
      `${INVENTORY_V1_STATEMENT_IDS[statementId]} must stream the selected bucket by physical key`,
    ).toBe(true);
    expect(
      plans[statementId].some((detail) =>
        detail.includes('sqlite_autoindex_rfc64_candidate_bucket_rows_v1_2')
        && detail.includes('ka_id_u256be=?')),
      `${INVENTORY_V1_STATEMENT_IDS[statementId]} must point-join through head-wide KA uniqueness`,
    ).toBe(true);
  }

  expect(
    plans.deleteHeader.some((detail) =>
      detail.includes('rfc64_candidate_bucket_rows_v1')
      && detail.includes('USING PRIMARY KEY')
      && detail.includes('bucket_id_u64be=?')),
    'candidate cascade must use the bucket-first child primary key',
  ).toBe(true);
}

function oldHeadWidePrimaryKeyDdl(): string {
  const bucketFirst = `PRIMARY KEY (
    session_id,
    catalog_scope_digest,
    author_address,
    target_catalog_head_digest,
    bucket_id_u64be,
    ka_id_u256be
  ),

  UNIQUE (
    session_id,
    catalog_scope_digest,
    author_address,
    target_catalog_head_digest,
    ka_id_u256be
  ),`;
  const oldShape = `PRIMARY KEY (
    session_id,
    catalog_scope_digest,
    author_address,
    target_catalog_head_digest,
    ka_id_u256be
  ),

  UNIQUE (
    session_id,
    catalog_scope_digest,
    author_address,
    target_catalog_head_digest,
    bucket_id_u64be,
    ka_id_u256be
  ),`;
  const mutated = INVENTORY_V1_DDL.replace(bucketFirst, oldShape);
  if (mutated === INVENTORY_V1_DDL) throw new Error('failed to mutate frozen candidate rows DDL');
  return mutated;
}

function withoutHeadWideKaUniqueDdl(): string {
  const headWideUnique = `UNIQUE (
    session_id,
    catalog_scope_digest,
    author_address,
    target_catalog_head_digest,
    ka_id_u256be
  ),

  `;
  const mutated = INVENTORY_V1_DDL.replace(headWideUnique, '');
  if (mutated === INVENTORY_V1_DDL) {
    throw new Error('failed to remove the frozen head-wide KA unique constraint');
  }
  return mutated;
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}
