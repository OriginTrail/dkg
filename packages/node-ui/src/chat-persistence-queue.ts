import type { ChatPersistenceHealthRow, ChatPersistenceJobRow, ChatPersistenceStatus, DashboardDB } from './db.js';
import type { ChatMemoryManager } from './chat-memory.js';

export interface TurnToolCall {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface TurnPersistenceJobInput {
  turnId: string;
  sessionId: string;
  userMessage: string;
  assistantReply: string;
  toolCalls?: TurnToolCall[];
}

export interface TurnPersistenceStatusEvent {
  type: 'persist_status';
  turnId: string;
  sessionId: string;
  status: ChatPersistenceStatus;
  attempts: number;
  maxAttempts: number;
  queuedAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  storeMs?: number;
  error?: string;
}

export interface TurnPersistenceHealthSnapshot {
  pending: number;
  inProgress: number;
  stored: number;
  failed: number;
  overduePending: number;
  oldestPendingAgeMs: number | null;
}

interface QueueOptions {
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  batchSize?: number;
}

function parseToolCalls(value: string | null): TurnToolCall[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as TurnToolCall[] : undefined;
  } catch {
    return undefined;
  }
}

export class ChatPersistenceQueue {
  private readonly listeners = new Set<(event: TurnPersistenceStatusEvent) => void>();
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly batchSize: number;
  private processing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly db: DashboardDB,
    private readonly memoryManager: ChatMemoryManager,
    opts: QueueOptions = {},
  ) {
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
    this.retryBaseMs = Math.max(250, opts.retryBaseMs ?? 1_000);
    this.retryMaxMs = Math.max(this.retryBaseMs, opts.retryMaxMs ?? 30_000);
    this.batchSize = Math.max(1, opts.batchSize ?? 8);
    const now = Date.now();
    this.db.recoverInProgressChatPersistenceJobs(now);
    this.kick(0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  subscribe(listener: (event: TurnPersistenceStatusEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  enqueue(job: TurnPersistenceJobInput): TurnPersistenceStatusEvent {
    const existing = this.db.getChatPersistenceJob(job.turnId);
    if (existing) {
      if (existing.status === 'pending') this.kick(0);
      return this.rowToEvent(existing);
    }

    const now = Date.now();
    try {
      this.db.insertChatPersistenceJob({
        turn_id: job.turnId,
        session_id: job.sessionId,
        user_message: job.userMessage,
        assistant_reply: job.assistantReply,
        tool_calls_json: job.toolCalls?.length ? JSON.stringify(job.toolCalls) : null,
        status: 'pending',
        attempts: 0,
        max_attempts: this.maxAttempts,
        next_attempt_at: now,
        queued_at: now,
        updated_at: now,
      });
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? '').toLowerCase();
      const isConstraintViolation = msg.includes('unique') || msg.includes('constraint') || msg.includes('duplicate');
      if (isConstraintViolation) {
        const raced = this.db.getChatPersistenceJob(job.turnId);
        if (raced) {
          if (raced.status === 'pending') this.kick(0);
          return this.rowToEvent(raced);
        }
      }
      throw err;
    }

    const created = this.db.getChatPersistenceJob(job.turnId);
    if (!created) {
      throw new Error(`Failed to create persistence job for turn ${job.turnId}`);
    }
    const event = this.rowToEvent(created);
    this.emit(event);
    this.kick(0);
    return event;
  }

  getHealthSnapshot(now = Date.now()): TurnPersistenceHealthSnapshot {
    const row = this.db.getChatPersistenceHealth(now);
    return this.healthFromRow(row, now);
  }

  private healthFromRow(row: ChatPersistenceHealthRow, now: number): TurnPersistenceHealthSnapshot {
    return {
      pending: row.pending_count,
      inProgress: row.in_progress_count,
      stored: row.stored_count,
      failed: row.failed_count,
      overduePending: row.overdue_pending_count,
      oldestPendingAgeMs: row.oldest_pending_queued_at != null ? Math.max(0, now - row.oldest_pending_queued_at) : null,
    };
  }

  private rowToEvent(row: ChatPersistenceJobRow): TurnPersistenceStatusEvent {
    return {
      type: 'persist_status',
      turnId: row.turn_id,
      sessionId: row.session_id,
      status: row.status,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      queuedAt: row.queued_at,
      updatedAt: row.updated_at,
      nextAttemptAt: row.status === 'pending' ? row.next_attempt_at : undefined,
      storeMs: row.store_ms ?? undefined,
      error: row.error_message ?? undefined,
    };
  }

  private emit(event: TurnPersistenceStatusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener exceptions must not break queue processing.
      }
    }
  }

  private backoffMs(attempts: number): number {
    const exp = Math.max(0, attempts - 1);
    return Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** exp);
  }

  private scheduleFromNextPending(now: number): void {
    if (this.disposed) return;
    const nextAt = this.db.getNextPendingChatPersistenceAt();
    if (nextAt == null) return;
    const delay = Math.max(0, nextAt - now);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.kick(0);
    }, delay);
  }

  private kick(delayMs: number): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.process().catch(() => {});
    }, Math.max(0, delayMs));
  }

  private async process(): Promise<void> {
    if (this.disposed || this.processing) return;
    this.processing = true;
    try {
      while (!this.disposed) {
        const now = Date.now();
        const jobs = this.db.getRunnableChatPersistenceJobs(now, this.batchSize);
        if (!jobs.length) {
          this.scheduleFromNextPending(now);
          break;
        }

        for (const job of jobs) {
          if (this.disposed) break;

          const nextAttempts = job.attempts + 1;
          const startedAt = Date.now();
          this.db.markChatPersistenceInProgress(job.turn_id, nextAttempts, startedAt);
          this.emit({
            type: 'persist_status',
            turnId: job.turn_id,
            sessionId: job.session_id,
            status: 'in_progress',
            attempts: nextAttempts,
            maxAttempts: job.max_attempts,
            queuedAt: job.queued_at,
            updatedAt: startedAt,
          });

          try {
            await this.memoryManager.storeChatExchange(
              job.session_id,
              job.user_message,
              job.assistant_reply,
              parseToolCalls(job.tool_calls_json),
              { turnId: job.turn_id, persistenceState: 'stored' },
            );
            const finishedAt = Date.now();
            this.db.markChatPersistenceStored(job.turn_id, finishedAt - startedAt, finishedAt);
            this.emit({
              type: 'persist_status',
              turnId: job.turn_id,
              sessionId: job.session_id,
              status: 'stored',
              attempts: nextAttempts,
              maxAttempts: job.max_attempts,
              queuedAt: job.queued_at,
              updatedAt: finishedAt,
              storeMs: finishedAt - startedAt,
            });
          } catch (err: unknown) {
            const error = err instanceof Error ? err.message : String(err);
            const failedAt = Date.now();
            if (nextAttempts >= job.max_attempts) {
              this.db.markChatPersistenceFailed(job.turn_id, nextAttempts, failedAt, error);
              this.emit({
                type: 'persist_status',
                turnId: job.turn_id,
                sessionId: job.session_id,
                status: 'failed',
                attempts: nextAttempts,
                maxAttempts: job.max_attempts,
                queuedAt: job.queued_at,
                updatedAt: failedAt,
                error,
              });
              continue;
            }

            const nextAttemptAt = failedAt + this.backoffMs(nextAttempts);
            this.db.markChatPersistencePendingRetry(job.turn_id, nextAttempts, nextAttemptAt, failedAt, error);
            this.emit({
              type: 'persist_status',
              turnId: job.turn_id,
              sessionId: job.session_id,
              status: 'pending',
              attempts: nextAttempts,
              maxAttempts: job.max_attempts,
              queuedAt: job.queued_at,
              updatedAt: failedAt,
              nextAttemptAt,
              error,
            });
          }
        }
      }
    } catch (err: unknown) {
      console.error('[chat-persistence] queue-level error:', err instanceof Error ? err.message : String(err));
      setTimeout(() => this.process(), 5_000);
    } finally {
      this.processing = false;
    }
  }
}
