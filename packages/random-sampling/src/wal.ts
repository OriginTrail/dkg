/**
 * Random Sampling Write-Ahead Log.
 *
 * One append-only sequence of state transitions per `(epoch,
 * periodStartBlock)` tuple. The prover writes transitions around the
 * chain reads, proof build, and tx submit path so diagnostics and future
 * crash-recovery startup code have enough history to decide:
 *
 *   - "I already submitted; the chain says solved=true → mark
 *     confirmed and skip"
 *   - "I built a proof but never submitted; resubmit if window open,
 *     otherwise drop the period and log loudly"
 *   - "I started extracting but never finished; restart the period
 *     from extraction"
 *
 * The WAL is intentionally NOT a queue — it does not buffer pending
 * work. It records what HAS happened so diagnostics and future crash
 * recovery code can deduce what to do next.
 *
 * Format: JSONL, one transition per line, append-only, fsync after
 * each write. Backends: in-memory (tests) and file (prod).
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

export type ProverPeriodStatus =
  | 'started'      // tick began for this period
  | 'challenge'    // chain returned a challenge for kcId/cgId
  | 'extracted'    // local extraction succeeded
  | 'built'        // proof material built (leaf + proof in hand)
  | 'submitted'    // submitProof tx broadcast (txHash recorded)
  | 'confirmed'    // tx confirmed on-chain (solved=true observed)
  | 'failed';      // terminal failure for this period (recoverable code in `error`)

/**
 * One state transition recorded by the prover. Identity is
 * `(epoch, periodStartBlock)` — at most one challenge per node per
 * period, so this is unique per node.
 *
 * `txHash` is set from `submitted` onwards. `error` is set on
 * `failed`. All other fields are set as they become available.
 */
export interface ProverWalEntry {
  /** Wall-clock ISO-8601 timestamp; debug aid only, never relied on for ordering. */
  ts: string;
  /** On-chain epoch number at the time of this transition. */
  epoch: string; // bigint serialized as decimal string for JSONL safety
  /** Active proof period start block. */
  periodStartBlock: string;
  /** Identity of the node performing the proof. */
  identityId: string;
  status: ProverPeriodStatus;
  /** Set from `challenge` onwards. */
  kcId?: string;
  /** Set from `challenge` onwards. */
  cgId?: string;
  /** Set from `challenge` onwards. */
  chunkId?: string;
  /** Set from `submitted` onwards. */
  txHash?: string;
  /** Set on `failed` only. Short message + code, NOT a full stack. */
  error?: { code: string; message: string };
}

/**
 * Identity of one prover period — the WAL groups entries by this.
 * Stable across crash recovery because both fields are on-chain
 * invariants.
 */
export interface PeriodKey {
  epoch: bigint;
  periodStartBlock: bigint;
  identityId: bigint;
}

export function periodKeyEquals(a: PeriodKey, b: PeriodKey): boolean {
  return (
    a.epoch === b.epoch &&
    a.periodStartBlock === b.periodStartBlock &&
    a.identityId === b.identityId
  );
}

function periodKeyMatches(entry: ProverWalEntry, key: PeriodKey): boolean {
  return (
    entry.epoch === key.epoch.toString() &&
    entry.periodStartBlock === key.periodStartBlock.toString() &&
    entry.identityId === key.identityId.toString()
  );
}

/** Read-then-append interface; both backends implement this. */
export interface ProverWal {
  /**
   * Append a transition. Caller is responsible for ensuring the
   * `status` makes sense (the WAL does not enforce a state machine —
   * that lives in `prover.ts`'s recovery logic, where it can react
   * differently per code path).
   */
  append(entry: ProverWalEntry): Promise<void>;
  /** Return all entries, oldest-first. Used by diagnostics and future startup recovery. */
  readAll(): Promise<ProverWalEntry[]>;
  /** Latest transition for a specific period, or undefined. */
  latestFor(key: PeriodKey): Promise<ProverWalEntry | undefined>;
  /** Close any underlying handles. */
  close(): Promise<void>;
}

/**
 * In-memory WAL — vanishes on process exit. Use for tests + when the
 * prover is run in a `--in-memory-only` debug mode.
 */
export class InMemoryProverWal implements ProverWal {
  private entries: ProverWalEntry[] = [];

  async append(entry: ProverWalEntry): Promise<void> {
    this.entries.push(entry);
  }

  async readAll(): Promise<ProverWalEntry[]> {
    return [...this.entries];
  }

  async latestFor(key: PeriodKey): Promise<ProverWalEntry | undefined> {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (periodKeyMatches(this.entries[i], key)) return this.entries[i];
    }
    return undefined;
  }

  async close(): Promise<void> {
    // no-op
  }
}

/**
 * File-backed JSONL WAL with `O_APPEND | O_SYNC`-shaped semantics
 * (we open with `'a'` and call `fsync` after each write). Loads
 * existing entries on construction.
 *
 * The file is **never** truncated — for v1, retention is unbounded
 * and is the operator's problem (rotate via systemd / log shipping).
 * A future rotate-by-epoch-window pass is on the plan but not v1.
 */
export class FileProverWal implements ProverWal {
  private cache: ProverWalEntry[] = [];
  private handle: fs.FileHandle | null = null;

  private constructor(private readonly path: string) {}

  static async open(path: string): Promise<FileProverWal> {
    const wal = new FileProverWal(path);
    await mkdirP(path);
    // Read existing entries, then open for append.
    try {
      const existing = await fs.readFile(path, 'utf8');
      for (const line of existing.split('\n')) {
        if (!line.trim()) continue;
        try {
          wal.cache.push(JSON.parse(line) as ProverWalEntry);
        } catch {
          // Skip corrupted line; the WAL is self-healing because
          // each entry is a complete state record. Crash mid-write
          // can produce a partial last line — we discard it.
        }
      }
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code !== 'ENOENT') throw err;
    }
    wal.handle = await fs.open(path, 'a');
    return wal;
  }

  async append(entry: ProverWalEntry): Promise<void> {
    if (!this.handle) throw new Error('WAL closed');
    const line = JSON.stringify(entry) + '\n';
    await this.handle.write(line);
    await this.handle.sync();
    this.cache.push(entry);
  }

  async readAll(): Promise<ProverWalEntry[]> {
    return [...this.cache];
  }

  async latestFor(key: PeriodKey): Promise<ProverWalEntry | undefined> {
    for (let i = this.cache.length - 1; i >= 0; i--) {
      if (periodKeyMatches(this.cache[i], key)) return this.cache[i];
    }
    return undefined;
  }

  async close(): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }
}

async function mkdirP(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  if (!dir || dir === '.') return;
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Convenience: build a `ProverWalEntry` with the timestamp filled in
 * so call sites stay terse.
 */
export function makeWalEntry(
  key: PeriodKey,
  status: ProverPeriodStatus,
  fields: Omit<ProverWalEntry, 'ts' | 'epoch' | 'periodStartBlock' | 'identityId' | 'status'> = {},
): ProverWalEntry {
  return {
    ts: new Date().toISOString(),
    epoch: key.epoch.toString(),
    periodStartBlock: key.periodStartBlock.toString(),
    identityId: key.identityId.toString(),
    status,
    ...fields,
  };
}
