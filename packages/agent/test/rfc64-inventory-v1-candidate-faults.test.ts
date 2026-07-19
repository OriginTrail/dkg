import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  INVENTORY_V1_DDL,
  INVENTORY_V1_ROWS_TABLE_SQL,
} from '../src/rfc64/inventory-v1/index.js';
import { CandidateInventoryV1 } from '../src/rfc64/inventory-v1/candidate.js';

const SESSION_HEX = '11'.repeat(32);
const SCOPE_HEX = '22'.repeat(32);
const AUTHOR_HEX = '33'.repeat(20);
const HEAD_HEX = '44'.repeat(32);

describe('RFC-64 SQL-1 candidate crash and static fault matrix', () => {
  it.skipIf(process.platform === 'win32')(
    'rolls back a real child SIGKILL after the header and every child insert boundary',
    async () => {
      const insertRows = [
        rowInsertSql('0000000000000000', `${AUTHOR_HEX}${'00'.repeat(11)}01`, '51', 'one'),
        rowInsertSql('0000000000000000', `${AUTHOR_HEX}${'00'.repeat(11)}02`, '52', 'two'),
        rowInsertSql('0000000000000000', `${AUTHOR_HEX}${'00'.repeat(11)}03`, '53', 'three'),
      ];
      for (let boundary = 1; boundary <= insertRows.length + 1; boundary += 1) {
        const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dkg-rfc64-sigkill-')));
        const path = join(directory, 'inventory.sqlite3');
        initializeDatabase(path);
        try {
          const result = await runInsertChild(path, boundary, insertRows);
          expect(result).toEqual({ code: null, signal: 'SIGKILL' });
          expect(expectStoredCounts(path)).toEqual({ headers: 0, rows: 0 });
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }

      const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dkg-rfc64-commit-')));
      const path = join(directory, 'inventory.sqlite3');
      initializeDatabase(path);
      try {
        const result = await runInsertChild(path, 0, insertRows);
        expect(result).toEqual({ code: 0, signal: null });
        expect(expectStoredCounts(path)).toEqual({ headers: 1, rows: 3 });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it('enforces head-wide duplicate KA and catalog-key rejection across buckets', () => {
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec(INVENTORY_V1_DDL);
    database.exec(headerInsertSql('0000000000000000', 1));
    database.exec(headerInsertSql('0000000000000001', 1));
    const kaOne = `${AUTHOR_HEX}${'00'.repeat(11)}01`;
    database.exec(rowInsertSql('0000000000000000', kaOne, '61', 'first'));
    try {
      expect(() => database.exec(
        rowInsertSql('0000000000000001', kaOne, '62', 'duplicate-ka'),
      )).toThrowError(/UNIQUE constraint failed/i);
      expect(() => database.exec(
        rowInsertSql(
          '0000000000000001',
          `${AUTHOR_HEX}${'00'.repeat(11)}02`,
          '61',
          'duplicate-key',
        ),
      )).toThrowError(/UNIQUE constraint failed/i);
    } finally {
      database.close();
    }
  });

  it('keeps SQL-1 D26-neutral and free of seal admission or completion APIs', () => {
    const candidateSource = readFileSync(
      new URL('../src/rfc64/inventory-v1/candidate.ts', import.meta.url),
      'utf8',
    );
    const statementSource = readFileSync(
      new URL('../src/rfc64/inventory-v1/statements.ts', import.meta.url),
      'utf8',
    );
    const publicIndexSource = readFileSync(
      new URL('../src/rfc64/inventory-v1/index.ts', import.meta.url),
      'utf8',
    );
    expect(candidateSource).not.toMatch(/(?:PR\s*#?\s*1780|#1780)/i);
    expect(candidateSource).not.toMatch(/\b(?:isComplete|promoteToApplied|markApplied)\b/);
    expect(Object.getOwnPropertyNames(CandidateInventoryV1.prototype)).not.toEqual(
      expect.arrayContaining(['isComplete', 'promoteToApplied', 'markApplied']),
    );
    expect(`${INVENTORY_V1_ROWS_TABLE_SQL}\n${statementSource}`).not.toMatch(
      /\b(?:accessPolicy|publishPolicy|memberRoster|curator|provider|vmOrdinal|vmState|tier)\b/i,
    );
    expect(publicIndexSource).not.toContain("export * from './candidate.js'");
    expect(publicIndexSource).not.toMatch(/\bVerifiedCandidateBucketDescriptorV1\b/);
    expect(publicIndexSource).not.toMatch(/\bCandidateInventoryV1\s*,/);
  });
});

function initializeDatabase(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    database.exec(INVENTORY_V1_DDL);
  } finally {
    database.close();
  }
}

function expectStoredCounts(path: string): { headers: number; rows: number } {
  const database = new DatabaseSync(path);
  try {
    return {
      headers: Number(database.prepare(
        'SELECT count(*) AS count FROM rfc64_candidate_bucket_loads_v1',
      ).get()?.count),
      rows: Number(database.prepare(
        'SELECT count(*) AS count FROM rfc64_candidate_bucket_rows_v1',
      ).get()?.count),
    };
  } finally {
    database.close();
  }
}

function runInsertChild(
  path: string,
  pauseBoundary: number,
  insertRows: readonly string[],
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const childSource = String.raw`
    import { DatabaseSync } from 'node:sqlite';
    const database = new DatabaseSync(process.env.RFC64_DATABASE_PATH);
    const pauseBoundary = Number(process.env.RFC64_PAUSE_BOUNDARY);
    const rows = JSON.parse(process.env.RFC64_ROW_INSERTS);
    const pause = async (boundary) => {
      if (boundary !== pauseBoundary) return;
      await new Promise(() => process.stdout.write('BOUNDARY ' + boundary + '\n'));
    };
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;');
    database.exec(process.env.RFC64_HEADER_INSERT);
    await pause(1);
    for (let index = 0; index < rows.length; index += 1) {
      database.exec(rows[index]);
      await pause(index + 2);
    }
    database.exec('COMMIT');
    database.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      env: {
        ...process.env,
        RFC64_DATABASE_PATH: path,
        RFC64_PAUSE_BOUNDARY: String(pauseBoundary),
        RFC64_HEADER_INSERT: headerInsertSql('0000000000000000', insertRows.length),
        RFC64_ROW_INSERTS: JSON.stringify(insertRows),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child insert boundary timed out; stdout=${stdout}; stderr=${stderr}`));
    }, 5_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!killed && pauseBoundary > 0 && stdout.includes(`BOUNDARY ${pauseBoundary}\n`)) {
        killed = child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (pauseBoundary === 0 && code !== 0) {
        reject(new Error(`child commit failed; code=${code}; signal=${signal}; stderr=${stderr}`));
        return;
      }
      resolve({ code, signal });
    });
  });
}

function headerInsertSql(bucketHex: string, rowCount: number): string {
  return `
    INSERT INTO rfc64_candidate_bucket_loads_v1 (
      session_id, catalog_scope_digest, author_address,
      target_catalog_head_digest, subgraph_name, catalog_era_u64be,
      bucket_count_u64be, bucket_id_u64be, bucket_object_digest,
      row_count_u64be, payload_byte_length_u64be
    ) VALUES (
      x'${SESSION_HEX}', x'${SCOPE_HEX}', x'${AUTHOR_HEX}', x'${HEAD_HEX}',
      NULL, zeroblob(8), x'0000000000000002', x'${bucketHex}',
      x'${'55'.repeat(32)}', unhex(printf('%016x', ${rowCount})),
      x'0000000000000001'
    );
  `;
}

function rowInsertSql(
  bucketHex: string,
  kaHex: string,
  keyByte: string,
  coordinate: string,
): string {
  return `
    INSERT INTO rfc64_candidate_bucket_rows_v1 (
      session_id, catalog_scope_digest, author_address,
      target_catalog_head_digest, bucket_id_u64be, ka_id_u256be,
      catalog_key_digest, assertion_coordinate, assertion_version_u64be,
      projection_id, projection_digest, seal_digest, transfer_codec,
      transfer_byte_length_u64be, transfer_chunk_size_u64be,
      transfer_chunk_count_u64be, transfer_blob_digest,
      transfer_chunk_tree_root, expected_catalog_row_digest
    ) VALUES (
      x'${SESSION_HEX}', x'${SCOPE_HEX}', x'${AUTHOR_HEX}', x'${HEAD_HEX}',
      x'${bucketHex}', x'${kaHex}', x'${keyByte.repeat(32)}', '${coordinate}',
      x'0000000000000001', 'cg-shared-v1', x'${'66'.repeat(32)}',
      x'${'77'.repeat(32)}', 'dkg-ka-bundle-v1', x'0000000000000010',
      x'0000000000040000', x'0000000000000001', x'${'88'.repeat(32)}',
      x'${'99'.repeat(32)}', x'${'aa'.repeat(32)}'
    );
  `;
}
