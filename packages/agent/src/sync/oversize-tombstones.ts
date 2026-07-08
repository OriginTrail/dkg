/**
 * Oversize tombstone log (OT-RFC-56 §4.2) — the operator-facing record of
 * sync-ingested quads deliberately refused for exceeding the RDF-literal
 * size invariant.
 *
 * Tombstones are OBSERVABILITY, not correctness: the sync cursor advances
 * because the oversize filter runs BEFORE the store insert (see
 * oversize-filter.ts), so a re-offered page is simply re-filtered — nothing
 * here is consulted on the ingest hot path. Poison should be visible, not
 * silent: every drop is structured-logged (rate-limited per graph), counted
 * on `dkg.sync.oversize_tombstones.total`, kept in a bounded in-memory ring
 * for the operator API, and best-effort appended to
 * `<dataDir>/oversize-tombstones.jsonl` when a data dir exists.
 *
 * The ring and file are capped: an attacker paying ≥60 KB of bandwidth per
 * ~200-byte entry cannot grow either unboundedly (RFC-56 §5), and eviction
 * is harmless — a re-offered drop just re-records.
 */

import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { getMetrics } from '@origintrail-official/dkg-core';
import type { OversizeDrop } from './oversize-filter.js';

export interface OversizeTombstone {
  ts: string;
  seam: string;
  kind: OversizeDrop['kind'];
  graph?: string;
  subject: string;
  predicate: string;
  bytes: number;
  /** SHA-256 over `subject|predicate|graph|objectBytes` — stable identity without retaining the payload. */
  quadKeySha256: string;
}

const MAX_RING_ENTRIES = 10_000;
const LOG_RATE_LIMIT_MS = 60_000;

export interface OversizeTombstoneLogOptions {
  /** When set, entries are best-effort appended to `<dataDir>/oversize-tombstones.jsonl`. */
  dataDir?: string;
  logWarn: (message: string) => void;
}

export class OversizeTombstoneLog {
  private readonly ring: OversizeTombstone[] = [];
  private readonly dataDir?: string;
  private readonly logWarn: (message: string) => void;
  private readonly lastLoggedPerGraph = new Map<string, number>();
  private fileChain: Promise<void> = Promise.resolve();

  constructor(options: OversizeTombstoneLogOptions) {
    this.dataDir = options.dataDir;
    this.logWarn = options.logWarn;
  }

  /** Never throws — a tombstone-recording failure must not fail the sync. */
  record(drops: readonly OversizeDrop[], seam: string): void {
    if (drops.length === 0) return;
    const now = new Date().toISOString();
    const entries: OversizeTombstone[] = drops.map((d) => ({
      ts: now,
      seam,
      kind: d.kind,
      graph: d.quad.graph,
      subject: d.quad.subject,
      predicate: d.quad.predicate,
      bytes: d.bytes,
      quadKeySha256: createHash('sha256')
        .update(`${d.quad.subject}|${d.quad.predicate}|${d.quad.graph ?? ''}|${d.bytes}`)
        .digest('hex'),
    }));

    for (const e of entries) {
      this.ring.push(e);
      try {
        getMetrics().oversizeTombstonesTotal.add(1, { kind: e.kind });
      } catch { /* metrics unavailable in some harnesses — never fail the sync */ }
    }
    if (this.ring.length > MAX_RING_ENTRIES) {
      this.ring.splice(0, this.ring.length - MAX_RING_ENTRIES);
    }

    // Rate-limited structured warn: one line per graph per minute is enough
    // to make a poison source visible without letting a hostile peer turn the
    // log into its own flood.
    const byGraph = new Map<string, { count: number; sample: OversizeTombstone }>();
    for (const e of entries) {
      const g = e.graph ?? '(default)';
      const cur = byGraph.get(g);
      if (cur) cur.count += 1;
      else byGraph.set(g, { count: 1, sample: e });
    }
    const nowMs = Date.now();
    for (const [g, { count, sample }] of byGraph) {
      const last = this.lastLoggedPerGraph.get(g) ?? 0;
      if (nowMs - last < LOG_RATE_LIMIT_MS) continue;
      this.lastLoggedPerGraph.set(g, nowMs);
      this.logWarn(
        `oversize tombstone: refused ${count} synced quad(s) in graph ${g} ` +
        `(kind=${sample.kind} seam=${seam} sample subject=${sample.subject} ` +
        `predicate=${sample.predicate} bytes=${sample.bytes}). ` +
        `The graph converges without them; see docs/use-dkg/large-content.md.`,
      );
    }

    if (this.dataDir) {
      const path = join(this.dataDir, 'oversize-tombstones.jsonl');
      const payload = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
      // Serialize appends so concurrent seams can't interleave lines; swallow
      // failures (disk-full etc. must not fail the sync — the ring still has it).
      this.fileChain = this.fileChain
        .then(() => appendFile(path, payload, 'utf8'))
        .catch(() => undefined);
    }
  }

  /** Newest-first snapshot for the operator API. */
  list(limit = 100): OversizeTombstone[] {
    return this.ring.slice(-limit).reverse();
  }

  get size(): number {
    return this.ring.length;
  }
}
