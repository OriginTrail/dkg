import type Database from 'better-sqlite3';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import type { EmbeddingProvider } from './embedding-provider.js';
import {
  PermanentEmbeddingError,
  TransientEmbeddingError,
} from './embedding-provider.js';
import { buildLabelMap, tripleToText } from './triple-text.js';
import type { VectorStore } from './vector-store.js';

type JobType = 'store' | 'remove';

interface StoreJobPayload {
  quads: Quad[];
  paranetId: string;
  graph: string;
}

interface RemoveJobPayload {
  rootEntities: string[];
  paranetId: string;
  graph: string;
}

interface JobRow {
  id: number;
  type: JobType;
  payload_json: string;
  attempts: number;
  max_attempts: number;
  next_process_at: number;
}

export interface VectorJobQueueOptions {
  minTextLength?: number;
  retryMaxAttempts?: number;
  retryIntervalMs?: number;
  indexWorkspace?: boolean;
}

const DEFAULT_MIN_TEXT_LENGTH = 5;
const DEFAULT_MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
const DEFAULT_RETRY_INTERVAL_MS = 30_000;

export class VectorJobQueue {
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private readonly minTextLength: number;
  private readonly retryMaxAttempts: number;
  private readonly retryIntervalMs: number;
  private readonly indexWorkspace: boolean;

  constructor(
    private readonly db: Database,
    private readonly embeddingProvider: EmbeddingProvider,
    private readonly vectorStore: VectorStore,
    private readonly tripleStore: TripleStore,
    opts: VectorJobQueueOptions = {},
  ) {
    this.minTextLength = opts.minTextLength ?? DEFAULT_MIN_TEXT_LENGTH;
    this.retryMaxAttempts = opts.retryMaxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryIntervalMs = opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    this.indexWorkspace = opts.indexWorkspace ?? true;
    this.migrate();
  }

  enqueueStore(quads: Quad[], paranetId: string, graph: string): void {
    this.db.prepare(`
      INSERT INTO embedding_jobs (
        type, payload_json, attempts, max_attempts, next_process_at, created_at
      ) VALUES (?, ?, 0, ?, 0, ?)
    `).run(
      'store',
      JSON.stringify({ quads, paranetId, graph } satisfies StoreJobPayload),
      this.retryMaxAttempts,
      Date.now(),
    );
  }

  enqueueRemove(rootEntities: string[], paranetId: string, graph: string): void {
    this.db.prepare(`
      INSERT INTO embedding_jobs (
        type, payload_json, attempts, max_attempts, next_process_at, created_at
      ) VALUES (?, ?, 0, ?, 0, ?)
    `).run(
      'remove',
      JSON.stringify({ rootEntities, paranetId, graph } satisfies RemoveJobPayload),
      this.retryMaxAttempts,
      Date.now(),
    );
  }

  async processNext(): Promise<'processed' | 'empty' | 'waiting'> {
    if (this.processing) return 'waiting';

    const now = Date.now();
    const nextJob = this.db.prepare(`
      SELECT id, type, payload_json, attempts, max_attempts, next_process_at
      FROM embedding_jobs
      WHERE attempts < max_attempts AND next_process_at <= ?
      ORDER BY id ASC
      LIMIT 1
    `).get(now) as JobRow | undefined;

    if (!nextJob) {
      const pending = this.db
        .prepare('SELECT COUNT(*) AS count FROM embedding_jobs WHERE attempts < max_attempts')
        .get() as { count: number };
      return pending.count > 0 ? 'waiting' : 'empty';
    }

    this.processing = true;
    try {
      if (nextJob.type === 'store') {
        await this.processStoreJob(nextJob, JSON.parse(nextJob.payload_json) as StoreJobPayload);
      } else {
        await this.processRemoveJob(JSON.parse(nextJob.payload_json) as RemoveJobPayload);
      }
      this.db.prepare('DELETE FROM embedding_jobs WHERE id = ?').run(nextJob.id);
      return 'processed';
    } catch (error) {
      if (error instanceof PermanentEmbeddingError) {
        console.warn(`[VectorJobQueue] Permanent embedding failure, dropping job ${nextJob.id}: ${error.message}`);
        this.db.prepare('DELETE FROM embedding_jobs WHERE id = ?').run(nextJob.id);
        return 'processed';
      }

      const nextAttempts = nextJob.attempts + 1;
      if (nextAttempts >= nextJob.max_attempts) {
        console.warn(`[VectorJobQueue] Max attempts exceeded for job ${nextJob.id}: ${error instanceof Error ? error.message : String(error)}`);
        this.db.prepare('DELETE FROM embedding_jobs WHERE id = ?').run(nextJob.id);
        return 'processed';
      }

      const delay = backoffMs(nextJob.attempts, this.retryIntervalMs);
      this.db.prepare(`
        UPDATE embedding_jobs
        SET attempts = ?, next_process_at = ?, last_error = ?
        WHERE id = ?
      `).run(
        nextAttempts,
        Date.now() + delay,
        error instanceof Error ? error.message : String(error),
        nextJob.id,
      );
      return 'processed';
    } finally {
      this.processing = false;
    }
  }

  start(intervalMs = 100): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.processNext();
    }, intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  stats(): { pending: number; processing: number; failed: number } {
    const pending = this.db
      .prepare('SELECT COUNT(*) AS count FROM embedding_jobs WHERE attempts < max_attempts')
      .get() as { count: number };
    const failed = this.db
      .prepare('SELECT COUNT(*) AS count FROM embedding_jobs WHERE attempts >= max_attempts')
      .get() as { count: number };
    return {
      pending: pending.count,
      processing: this.processing ? 1 : 0,
      failed: failed.count,
    };
  }

  private async processStoreJob(row: JobRow, payload: StoreJobPayload): Promise<void> {
    if (!this.indexWorkspace && isWorkspaceGraph(payload.graph)) return;

    const labelMap = buildLabelMap(payload.quads);
    const candidates = payload.quads
      .map((quad) => ({
        quad,
        text: tripleToText(quad, labelMap).trim(),
      }))
      .filter((item) => item.text.length >= this.minTextLength);

    if (candidates.length === 0) return;

    const embeddings = await this.embeddingProvider.embed(candidates.map((item) => item.text));
    await this.vectorStore.upsert(candidates.map((item, index) => ({
      subject: item.quad.subject,
      predicate: item.quad.predicate,
      object: item.quad.object,
      graph: payload.graph,
      paranetId: payload.paranetId,
      text: item.text,
      embedding: embeddings[index]?.embedding ?? [],
      createdAt: Date.now(),
    })));
  }

  private async processRemoveJob(payload: RemoveJobPayload): Promise<void> {
    for (const rootEntity of payload.rootEntities) {
      await this.vectorStore.deleteByRootEntity(rootEntity, {
        paranetId: payload.paranetId,
        graph: payload.graph,
      });
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 10,
        next_process_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_embedding_jobs_ready
        ON embedding_jobs(next_process_at, id);
    `);
  }
}

function backoffMs(attempts: number, baseDelayMs: number): number {
  return Math.min(baseDelayMs * (2 ** attempts), MAX_BACKOFF_MS);
}

function isWorkspaceGraph(graph: string): boolean {
  return graph.endsWith('/_workspace');
}
