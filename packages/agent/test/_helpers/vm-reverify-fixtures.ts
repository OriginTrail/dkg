// SPDX-License-Identifier: Apache-2.0
/**
 * Shared fixtures for the W2 ingest and drain suites (split per review r2:
 * the two seams live in their own files; only genuinely shared pieces are
 * here). The in-memory store mirrors the SQLite contract — including the
 * shared advance predicate and the park-budget flag — so drain rows exercise
 * the same semantics the durable store enforces.
 */
import { createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';

import { packKnowledgeAssetIdFromIdentity } from '../../src/ka-identity.js';
import {
  eventRedefinesIntent,
  type VmReverifyIntentHealth,
  type VmReverifyIntentPosition,
  type VmReverifyIntentRecord,
  type VmReverifyIntentStore,
  type VmReverifyIntentUpsertInput,
  type VmReverifyIntentUpsertResult,
} from '../../src/vm-reverify-intent-store.js';

export class InMemoryVmReverifyIntentStore implements VmReverifyIntentStore {
  readonly rows = new Map<string, VmReverifyIntentRecord>();
  upsertFailure: Error | undefined;
  now = 1_000;

  async upsert(input: VmReverifyIntentUpsertInput): Promise<VmReverifyIntentUpsertResult> {
    if (this.upsertFailure) throw this.upsertFailure;
    const existing = this.rows.get(input.ual);
    if (!existing) {
      this.rows.set(input.ual, {
        ual: input.ual,
        localCgId: input.localCgId,
        kaId: input.kaId,
        kind: input.kind,
        observed: { ...input.position },
        state: 'PENDING',
        generation: 0,
        attemptCount: 0,
        createdAt: this.now,
        updatedAt: this.now,
      });
      return 'inserted';
    }
    if (!eventRedefinesIntent(input.position, existing.observed, existing.state)) return 'unchanged';
    this.rows.set(input.ual, {
      ...existing,
      kind: input.kind,
      localCgId: input.localCgId,
      kaId: input.kaId,
      observed: { ...input.position },
      state: 'PENDING',
      generation: existing.generation + 1,
      attemptCount: 0,
      updatedAt: this.now,
    });
    return 'advanced';
  }

  async listDue(now: number, limit: number): Promise<VmReverifyIntentRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.state === 'PENDING'
        && (row.nextAttemptAt === undefined || row.nextAttemptAt <= now))
      .sort((a, b) => a.observed.blockNumber - b.observed.blockNumber
        || a.ual.localeCompare(b.ual))
      .slice(0, Math.max(0, limit));
  }

  async resolve(ual: string, generation: number): Promise<boolean> {
    const row = this.rows.get(ual);
    if (!row || row.generation !== generation) return false;
    this.rows.delete(ual);
    return true;
  }

  async recordAttempt(
    ual: string,
    generation: number,
    lastOutcome: string,
    retryDelayMs: number,
    now: number,
    startsParkBudget: boolean,
  ): Promise<boolean> {
    const row = this.rows.get(ual);
    if (!row || row.generation !== generation || row.state !== 'PENDING') return false;
    this.rows.set(ual, {
      ...row,
      attemptCount: row.attemptCount + 1,
      ...(startsParkBudget
        ? { firstAttemptAt: row.firstAttemptAt ?? now }
        : row.firstAttemptAt === undefined ? {} : { firstAttemptAt: row.firstAttemptAt }),
      nextAttemptAt: now + retryDelayMs,
      lastOutcome,
      updatedAt: now,
    });
    return true;
  }

  async abandon(
    ual: string,
    generation: number,
    reason: VmReverifyIntentRecord['abandonReason'] & string,
  ): Promise<boolean> {
    const row = this.rows.get(ual);
    if (!row || row.generation !== generation || row.state !== 'PENDING') return false;
    this.rows.set(ual, { ...row, state: 'ABANDONED', abandonReason: reason });
    return true;
  }

  async reviveForContextGraph(localCgId: string): Promise<number> {
    let revived = 0;
    for (const [ual, row] of this.rows) {
      if (row.localCgId !== localCgId || row.state !== 'ABANDONED') continue;
      const next: VmReverifyIntentRecord = {
        ...row,
        state: 'PENDING',
        generation: row.generation + 1,
        attemptCount: 0,
      };
      delete next.abandonReason;
      delete next.firstAttemptAt;
      delete next.nextAttemptAt;
      this.rows.set(ual, next);
      revived += 1;
    }
    return revived;
  }

  async countPending(localCgId?: string): Promise<number> {
    return [...this.rows.values()].filter((row) => row.state === 'PENDING'
      && (localCgId === undefined || row.localCgId === localCgId)).length;
  }

  async health(): Promise<VmReverifyIntentHealth> {
    const rows = [...this.rows.values()];
    return {
      pending: rows.filter((row) => row.state === 'PENDING').length,
      abandoned: rows.filter((row) => row.state === 'ABANDONED').length,
    };
  }

  async gcAbandoned(olderThanMs: number): Promise<number> {
    let removed = 0;
    for (const [ual, row] of this.rows) {
      if (row.state === 'ABANDONED' && row.updatedAt <= this.now - Math.max(0, olderThanMs)) {
        this.rows.delete(ual);
        removed += 1;
      }
    }
    return removed;
  }

  async close(): Promise<void> {}
}


export const CG = 'w2r-ingest-cg';
export const AUTHOR = '0x1111111111111111111111111111111111111111';
export const ctx: OperationContext = createOperationContext('system');

export function position(
  blockNumber: number,
  transactionIndex = 0,
  logIndex = 0,
): VmReverifyIntentPosition & { blockHash: string; transactionHash: string } {
  return {
    blockNumber,
    transactionIndex,
    logIndex,
    blockHash: `0x${'a'.repeat(64)}`,
    transactionHash: `0x${'b'.repeat(64)}`,
  };
}

export function kaIdFor(kaNumber: bigint): bigint {
  return packKnowledgeAssetIdFromIdentity({ agentAddress: AUTHOR, kaNumber });
}
