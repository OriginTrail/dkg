import { controlStoreOptions, deleteByPatternWithoutCount, type TripleStore } from '@origintrail-official/dkg-storage';
import type { PersistedLiftJob } from './lift-job.js';
import { replaceSubjectAtomicallyOrFallback } from './subject-atomic-write.js';
import {
  CONTROL_CLAIM_TOKEN, CONTROL_LOCKED_JOB, CONTROL_LOCK_EXPIRES_AT, CONTROL_LOCK_STATUS,
  PAYLOAD_PREDICATE, expectBindings, parseIntegerLiteral, parseLiteral, serializeWalletLock, walletLockSubject,
} from './async-lift-publisher-utils.js';
import { decodedLiftJobOrThrow, decodeLiftJobPayload } from './lift-job-payload-codec.js';

export interface WalletLockSnapshot {
  readonly walletId: string;
  readonly jobId: string;
  readonly claimToken?: string;
  readonly status: string;
  readonly expiresAt?: number;
}

export interface WalletLockRecord {
  walletId: string;
  jobId: string;
  acquiredAt: number;
  expiresAt: number;
  status: 'active' | 'expired' | 'released';
  claimToken?: string;
  lastHeartbeatAt?: number;
}

interface WalletOwnershipSnapshot {
  readonly lock: WalletLockSnapshot;
  readonly job: PersistedLiftJob | null;
}

export function walletLockJobIdFromRef(jobRef: string): string | null {
  const prefix = 'urn:dkg:publisher:lift-job:';
  return jobRef.startsWith(prefix) ? jobRef.slice(prefix.length) : null;
}

/** Storage and decoding only. The coordinator owns lock ordering, fences, and lifecycle policy. */
export class AsyncLiftWalletPersistence {
  constructor(
    private readonly store: TripleStore,
    private readonly graphUri: string,
    private readonly walletLockGraphUri: string,
  ) {}

  async write(lock: WalletLockRecord): Promise<void> {
    await replaceSubjectAtomicallyOrFallback(
      this.store,
      this.walletLockGraphUri,
      walletLockSubject(lock.walletId),
      serializeWalletLock(lock, this.walletLockGraphUri),
      controlStoreOptions('publisher', 'publisher.asyncLift.walletLock.write'),
    );
  }

  async delete(walletId: string): Promise<void> {
    await deleteByPatternWithoutCount(this.store, {
      subject: walletLockSubject(walletId),
      graph: this.walletLockGraphUri,
    }, controlStoreOptions('publisher', 'publisher.asyncLift.walletLock.delete'));
  }

  async readMetadata(walletId: string): Promise<WalletLockSnapshot | null> {
    const result = await this.store.query(
      `SELECT ?job ?status ?expiresAt ?claimToken WHERE { GRAPH <${this.walletLockGraphUri}> { <${walletLockSubject(walletId)}> <${CONTROL_LOCKED_JOB}> ?job ; <${CONTROL_LOCK_STATUS}> ?status . OPTIONAL { <${walletLockSubject(walletId)}> <${CONTROL_LOCK_EXPIRES_AT}> ?expiresAt } OPTIONAL { <${walletLockSubject(walletId)}> <${CONTROL_CLAIM_TOKEN}> ?claimToken } } }`,
      controlStoreOptions('publisher', 'publisher.asyncLift.walletLock.read'),
    );
    return this.parse(walletId, expectBindings(result)[0]);
  }

  async readOwnership(walletId: string): Promise<WalletOwnershipSnapshot | null> {
    // Keep the OPTIONAL join unfiltered: Blazegraph can lose its payload with a correlated status filter.
    const result = await this.store.query(
      `SELECT ?job ?status ?expiresAt ?claimToken ?payload WHERE { GRAPH <${this.walletLockGraphUri}> { <${walletLockSubject(walletId)}> <${CONTROL_LOCKED_JOB}> ?job ; <${CONTROL_LOCK_STATUS}> ?status . OPTIONAL { <${walletLockSubject(walletId)}> <${CONTROL_LOCK_EXPIRES_AT}> ?expiresAt } OPTIONAL { <${walletLockSubject(walletId)}> <${CONTROL_CLAIM_TOKEN}> ?claimToken } } OPTIONAL { GRAPH <${this.graphUri}> { ?job <${PAYLOAD_PREDICATE}> ?payload } } }`,
      controlStoreOptions('publisher', 'publisher.asyncLift.walletLock.ownership'),
    );
    const row = expectBindings(result)[0];
    const lock = this.parse(walletId, row);
    if (!lock) return null;
    const job = lock.status === 'active' ? decodedLiftJobOrThrow(decodeLiftJobPayload(row?.['payload'])) : null;
    return { lock, job };
  }

  private parse(walletId: string, row: Record<string, string> | undefined): WalletLockSnapshot | null {
    if (!row) return null;
    const jobId = walletLockJobIdFromRef(row['job'] ?? '');
    const status = parseLiteral(row['status'] ?? '""');
    if (!jobId || typeof status !== 'string') return null;
    const claimToken = row['claimToken'] ? parseLiteral(row['claimToken']) : undefined;
    return {
      walletId,
      jobId,
      claimToken: typeof claimToken === 'string' ? claimToken : undefined,
      status,
      expiresAt: row['expiresAt'] ? parseIntegerLiteral(row['expiresAt']) : undefined,
    };
  }
}
