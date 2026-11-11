// SPDX-License-Identifier: Apache-2.0
import { createMainThreadTimeSlice } from '../../main-thread-time-slice.js';
import type { StatementSync } from 'node:sqlite';
import {
  decodeStoredRfc64FinalizedPrivatePlacementRepairV1,
  digestRfc64FinalizedPrivatePlacementRepairV1,
  encodeRfc64FinalizedPrivatePlacementRepairV1,
  rfc64FinalizedPrivatePlacementRepairKeyV1,
  snapshotRfc64FinalizedPrivatePlacementRepairV1,
  type Rfc64FinalizedPrivatePlacementRepairV1,
  type Rfc64PrivatePlacementFailureWriteV1,
} from '../finalized-private-placement-repair-store-v1.js';
import { parsePrivatePlacementFailureStateV1, type PrivatePlacementFailureStateV1 } from '../private-placement-failure-state-v1.js';
import { INVENTORY_V1_STATEMENT_SQL } from './statements.js';
type SqlRowV1 = Record<string, unknown>;
type DecodedRowV1 = Readonly<{ json: string; repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1> }>;
interface Host {
  assertOpen(): void;
  prepare(sql: string): StatementSync;
  statement<T>(run: () => T): T;
  read<T>(run: () => T): T;
  write<T>(label: string, run: () => T, strategy?: {
    resolve(result: T): 'committed' | 'not-committed'; retry(result: T): T;
  }): T;
  corrupt(message: string): Error;
}

/** Same owned connection, transactions, latency bounds and exact commit recovery as inventory. */
export class FinalizedPrivateRepairPersistenceV1 {
  /**
   * GH#3134 — what the last listing decoded, by row digest. A stored row is never rewritten, so a
   * listing decodes and checks only bytes it has not seen under their digest: a changed row is
   * decoded and checked again, and a removed one leaves with the next listing.
   */
  #decoded = new Map<string, DecodedRowV1>();
  constructor(private readonly host: Host) {}
  listFinalizedPrivatePlacementRepairs(): readonly Readonly<Rfc64FinalizedPrivatePlacementRepairV1>[] {
    this.host.assertOpen();
    const decoded = new Map<string, DecodedRowV1>();
    const repairs = this.host.read(() => {
      const query = this.host.prepare(INVENTORY_V1_STATEMENT_SQL.listFinalizedPrivatePlacementRepairs);
      const rows = this.host.statement(() => query.all() as SqlRowV1[]);
      return Object.freeze(rows.map((row) => this.decodeFinalizedPrivatePlacementRepair(row, decoded)));
    });
    this.#decoded = decoded;
    return repairs;
  }

  async listFinalizedPrivatePlacementRepairsAsync(signal: AbortSignal): Promise<readonly Readonly<Rfc64FinalizedPrivatePlacementRepairV1>[]> {
    this.host.assertOpen();
    signal.throwIfAborted();
    // Copy rows in one synchronous read transaction. Never hold SQLite across a yield.
    const rows = this.host.read(() => this.host.statement(() =>
      this.host.prepare(INVENTORY_V1_STATEMENT_SQL.listFinalizedPrivatePlacementRepairs).all() as SqlRowV1[]));
    const repairs: Rfc64FinalizedPrivatePlacementRepairV1[] = [];
    const decoded = new Map<string, DecodedRowV1>();
    const checkpoint = createMainThreadTimeSlice({ sliceMs: 8, maxIterations: 32 });
    for (const row of rows) {
      signal.throwIfAborted();
      this.host.assertOpen();
      repairs.push(this.decodeFinalizedPrivatePlacementRepair(row, decoded));
      const pause = checkpoint();
      if (pause) await pause;
    }
    signal.throwIfAborted();
    this.host.assertOpen();
    this.#decoded = decoded;
    return Object.freeze(repairs);
  }

  putFinalizedPrivatePlacementRepair(
    input: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
  ): void {
    this.host.assertOpen();
    const repair = snapshotRfc64FinalizedPrivatePlacementRepairV1(input);
    const bytes = encodeRfc64FinalizedPrivatePlacementRepairV1(repair);
    const digest = digestRfc64FinalizedPrivatePlacementRepairV1(bytes);
    const repairJson = new TextDecoder().decode(bytes);
    this.host.write('put finalized-private placement repair', () => {
      const statement = this.host.prepare(
        INVENTORY_V1_STATEMENT_SQL.insertFinalizedPrivatePlacementRepair,
      );
      const result = this.host.statement(() => statement.run({ repairDigest: digest, repairJson }));
      if (Number(result.changes) === 0) {
        const existing = this.readFinalizedPrivatePlacementRepairRow(digest);
        if (existing?.repair_json !== repairJson) {
          throw this.host.corrupt(
            'finalized-private placement repair digest is not bound to its bytes',
          );
        }
      }
    }, {
      resolve: () => this.readFinalizedPrivatePlacementRepairRow(digest) === null
        ? 'not-committed' : 'committed',
      retry: () => {
        const statement = this.host.prepare(
          INVENTORY_V1_STATEMENT_SQL.insertFinalizedPrivatePlacementRepair,
        );
        this.host.statement(() => statement.run({ repairDigest: digest, repairJson }));
      },
    });
  }

  deleteFinalizedPrivatePlacementRepair(
    input: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
  ): void {
    this.host.assertOpen();
    const repair = snapshotRfc64FinalizedPrivatePlacementRepairV1(input);
    const bytes = encodeRfc64FinalizedPrivatePlacementRepairV1(repair);
    const digest = digestRfc64FinalizedPrivatePlacementRepairV1(bytes);
    const repairJson = new TextDecoder().decode(bytes);
    this.host.write('delete finalized-private placement repair', () => {
      const current = this.readFinalizedPrivatePlacementRepairRow(digest);
      if (current === null) return;
      if (current.repair_json !== repairJson) {
        throw this.host.corrupt(
          'finalized-private placement repair changed before deletion',
        );
      }
      const statement = this.host.prepare(
        INVENTORY_V1_STATEMENT_SQL.deleteFinalizedPrivatePlacementRepair,
      );
      const result = this.host.statement(() => statement.run({ repairDigest: digest, repairJson }));
      if (Number(result.changes) !== 1) {
        throw this.host.corrupt(
          'finalized-private placement repair deletion did not remove exactly one row',
        );
      }
    }, {
      resolve: () => this.readFinalizedPrivatePlacementRepairRow(digest) === null
        ? 'committed' : 'not-committed',
      retry: () => {
        const statement = this.host.prepare(
          INVENTORY_V1_STATEMENT_SQL.deleteFinalizedPrivatePlacementRepair,
        );
        this.host.statement(() => statement.run({ repairDigest: digest, repairJson }));
      },
    });
  }

  private readFinalizedPrivatePlacementRepairRow(
    digest: Uint8Array,
  ): SqlRowV1 | null {
    const query = this.host.prepare(
      `SELECT repair_digest, repair_json
       FROM rfc64_finalized_private_placement_repairs_v1
       WHERE repair_digest = :repairDigest;`,
    );
    return (this.host.statement(() => query.get({ repairDigest: digest })) as SqlRowV1 | undefined) ?? null;
  }

  private decodeFinalizedPrivatePlacementRepair(
    row: SqlRowV1,
    decoded: Map<string, DecodedRowV1>,
  ): Readonly<Rfc64FinalizedPrivatePlacementRepairV1> {
    if (!(row.repair_digest instanceof Uint8Array)
      || row.repair_digest.byteLength !== 32
      || typeof row.repair_json !== 'string') {
      throw this.host.corrupt(
        'finalized-private placement repair row has invalid storage types',
      );
    }
    const json = row.repair_json;
    const id = Buffer.from(row.repair_digest.buffer, row.repair_digest.byteOffset, 32).toString('hex');
    const known = this.#decoded.get(id);
    const repair = known !== undefined && known.json === json ? known.repair
      : decodeStoredRfc64FinalizedPrivatePlacementRepairV1(new TextEncoder().encode(json), row.repair_digest);
    if (repair === undefined) {
      throw this.host.corrupt(
        'finalized-private placement repair row is not canonical or digest-bound',
      );
    }
    decoded.set(id, { json, repair });
    return repair;
  }

  readFinalizedPrivatePlacementFailure(repair: Rfc64FinalizedPrivatePlacementRepairV1): PrivatePlacementFailureStateV1 | null {
    const digest = repairDigestV1(repair);
    return this.host.read(() => this.readFailure(digest));
  }

  writeFinalizedPrivatePlacementFailures(entries: readonly Rfc64PrivatePlacementFailureWriteV1[]): void {
    this.host.assertOpen();
    // Validate the entire batch before opening one owned transaction.
    const rows = entries.map(({ repair, state }) => {
      const digest = repairDigestV1(repair);
      const validated = parsePrivatePlacementFailureStateV1(state);
      if (validated === null) throw new TypeError('Invalid private placement failure state');
      return { digest, validated, json: JSON.stringify(validated) };
    });
    if (rows.length === 0) return;
    const write = () => {
      for (const { digest, json } of rows) {
        // INSERT-SELECT cannot resurrect a completed marker. The FK cleans up successful deletion.
        const save = this.host.prepare(INVENTORY_V1_STATEMENT_SQL.upsertFinalizedPrivatePlacementFailure);
        this.host.statement(() => save.run({ digest, json }));
      }
    };
    this.host.write('record private placement failures', write, {
      resolve: () => rows.every(({ digest, validated }) => this.readFinalizedPrivatePlacementRepairRow(digest) === null
        || JSON.stringify(this.readFailure(digest)) === JSON.stringify(validated)) ? 'committed' : 'not-committed',
      retry: write,
    });
  }

  private readFailure(digest: Uint8Array): PrivatePlacementFailureStateV1 | null {
    const query = this.host.prepare(INVENTORY_V1_STATEMENT_SQL.getFinalizedPrivatePlacementFailure);
    const row = this.host.statement(() => query.get({ digest })) as SqlRowV1 | undefined;
    if (!row) return null;
    // A damaged diagnostic never authorizes a transition or parks an owed repair.
    try { return parsePrivatePlacementFailureStateV1(JSON.parse(String(row.state_json))); }
    catch { return null; }
  }
}

/** The row digest of `repair`, from the key a listed snapshot keeps (GH#3134). */
function repairDigestV1(repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>): Uint8Array {
  return Uint8Array.from(Buffer.from(rfc64FinalizedPrivatePlacementRepairKeyV1(repair), 'hex'));
}
