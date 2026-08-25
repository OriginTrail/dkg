import { cpus, totalmem, freemem } from 'node:os';
import { memoryUsage } from 'node:process';
import { statfs } from 'node:fs';
import { promisify } from 'node:util';

const statfsAsync = promisify(statfs);
import type { DashboardDB, MetricSnapshotRow } from './db.js';

/**
 * Aggregate relay-server snapshot consumed by MetricsCollector. Always
 * has the same shape as `RelayStats` from `@origintrail-official/dkg-core`
 * minus the unbounded `reservations[]` array — that lives only on the
 * live `/api/relay/stats` route, not in the periodic SQLite snapshot
 * (per-reservee detail would blow up the snapshot row size and isn't
 * useful for time-series graphing). The source returns `null` when the
 * node is not running a relay server.
 */
export interface RelayStatsSnapshot {
  capacity: number;
  reservationCount: number;
  activeCircuits: number;
  bytesIn: bigint;
  bytesOut: bigint;
}

export interface MetricsSource {
  getPeerCount(): number;
  getDirectPeerCount(): number;
  getRelayedPeerCount(): number;
  getMeshPeerCount(): number;
  getContextGraphCount(): Promise<number>;
  getTotalTriples(): Promise<number>;
  getTotalKCs(): Promise<number>;
  getTotalKAs(): Promise<number>;
  getConfirmedKCs(): Promise<number>;
  getTentativeKCs(): Promise<number>;
  // External SPARQL backends (Blazegraph, sparql-http) own no local
  // file, so `null` is the correct signal: collector writes a NULL into
  // the `store_bytes` SQLite column (already nullable). Quad count for
  // external backends is exposed on demand via `/api/status` instead of
  // periodically snapshotted.
  getStoreBytes(): Promise<number | null>;
  getRpcLatencyMs(): Promise<number>;
  isRpcHealthy(): Promise<boolean>;
  /**
   * Optional. Returns a relay snapshot on Core Nodes (relay server enabled),
   * or null on edge nodes. Method is optional so existing tests / external
   * consumers of MetricsSource don't have to stub it.
   */
  getRelayStats?(): RelayStatsSnapshot | null;
}

const SNAPSHOT_INTERVAL_MS = 86_400_000; // 24 hours

/**
 * Clamp a bigint relay byte count to a safe JS Number for SQLite storage.
 * Returns Number.MAX_SAFE_INTEGER (9.007e15) if the value would overflow,
 * which is harmless for graphing — if you ever see that exact value in a
 * snapshot column, the relay has forwarded ≥9 PB in this retention window
 * and we should switch the column representation to per-snapshot deltas.
 */
function bigintToSafeNumber(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  if (v < 0n) return 0;
  return Number(v);
}

/**
 * Periodically collects system, network, knowledge, and chain metrics
 * and stores them as snapshots in SQLite.
 */
export class MetricsCollector {
  private timer: ReturnType<typeof setInterval> | null = null;
  private prevCpuTimes: { idle: number; total: number } | null = null;
  private readonly startTime = Date.now();

  constructor(
    private readonly db: DashboardDB,
    private readonly source: MetricsSource,
    private readonly dataDir?: string,
    /**
     * Gate for the expensive store-scan getters (#1066 Item 1). When it returns
     * false the tick skips the full-store COUNT scans and leaves those columns
     * null. Defaults to always-collect so existing callers/tests are unchanged.
     */
    private readonly shouldCollectStoreMetrics: () => boolean = () => true,
  ) {}

  start(): void {
    if (this.timer) return;
    this.collectAndStore().then(snap => {
      this.backfillNulls(snap);
    }).catch(() => {});
    this.timer = setInterval(() => {
      this.collectAndStore().catch(() => {});
    }, SNAPSHOT_INTERVAL_MS);
  }

  private backfillNulls(snap: MetricSnapshotRow): void {
    try {
      if (snap.total_triples != null) {
        this.db.db.prepare(
          'UPDATE metric_snapshots SET total_triples = ? WHERE total_triples IS NULL',
        ).run(snap.total_triples);
      }
    } catch { /* best-effort */ }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async collectAndStore(): Promise<MetricSnapshotRow> {
    const snap = await this.collect();
    this.db.insertSnapshot(snap);
    return snap;
  }

  async collect(): Promise<MetricSnapshotRow> {
    const cpuPercent = this.measureCpu();
    const mem = memoryUsage();
    const heap = mem.heapUsed;
    const memTotal = totalmem();
    const memUsed = memTotal - freemem();
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);

    let diskUsed: number | null = null;
    let diskTotal: number | null = null;
    if (this.dataDir) {
      try {
        const s = await statfsAsync(this.dataDir);
        diskTotal = s.blocks * s.bsize;
        diskUsed = diskTotal - s.bavail * s.bsize;
      } catch { /* ignore */ }
    }

    let storeBytes: number | null = null;
    try { storeBytes = await this.source.getStoreBytes(); } catch { /* ignore */ }

    let rpcLatency: number | null = null;
    let rpcHealthy: number | null = null;
    try {
      rpcLatency = await this.source.getRpcLatencyMs();
      rpcHealthy = (await this.source.isRpcHealthy()) ? 1 : 0;
    } catch { /* ignore */ }

    let totalTriples: number | null = null;
    let totalKCs: number | null = null;
    let totalKAs: number | null = null;
    let confirmedKCs: number | null = null;
    let tentativeKCs: number | null = null;
    let contextGraphCount: number | null = null;

    // These six getters are full-store SPARQL scans (COUNT / COUNT(DISTINCT)
    // across every graph, plus the context-graph inventory) — the expensive
    // part of a tick. Skip them when nothing is consuming metrics, leaving the
    // columns null (already nullable; charts render the gap). The cheap
    // system/network metrics above always collect, so a CPU peg is still
    // recorded even while no dashboard is open. (#1066 Item 1)
    if (this.shouldCollectStoreMetrics()) {
      try { totalTriples = await this.source.getTotalTriples(); } catch { /* ignore */ }
      try { totalKCs = await this.source.getTotalKCs(); } catch { /* ignore */ }
      try { totalKAs = await this.source.getTotalKAs(); } catch { /* ignore */ }
      try { confirmedKCs = await this.source.getConfirmedKCs(); } catch { /* ignore */ }
      try { tentativeKCs = await this.source.getTentativeKCs(); } catch { /* ignore */ }
      try { contextGraphCount = await this.source.getContextGraphCount(); } catch { /* ignore */ }
    }

    let relayCapacity: number | null = null;
    let relayReservationCount: number | null = null;
    let relayActiveCircuits: number | null = null;
    let relayBytesIn: number | null = null;
    let relayBytesOut: number | null = null;
    try {
      const relay = this.source.getRelayStats?.();
      if (relay) {
        relayCapacity = relay.capacity;
        relayReservationCount = relay.reservationCount;
        relayActiveCircuits = relay.activeCircuits;
        // Clamp BigInt totals to Number for SQLite. Snapshot retention
        // pruning runs on a 90-day default cutoff, so the cumulative
        // total inside any retained row stays comfortably below
        // Number.MAX_SAFE_INTEGER (9.007e15) for any realistic relay
        // (would need ~9 PB of forwarded traffic in a single retention
        // window to overflow). If we ever hit that scale the right
        // answer is per-snapshot DELTA bytes, not raw cumulative; for
        // now Number is fine.
        relayBytesIn = bigintToSafeNumber(relay.bytesIn);
        relayBytesOut = bigintToSafeNumber(relay.bytesOut);
      }
    } catch { /* ignore — collector keeps shipping non-relay metrics */ }

    return {
      ts: Date.now(),
      cpu_percent: cpuPercent,
      mem_used_bytes: memUsed,
      mem_total_bytes: memTotal,
      disk_used_bytes: diskUsed,
      disk_total_bytes: diskTotal,
      heap_used_bytes: heap,
      uptime_seconds: uptime,
      peer_count: this.source.getPeerCount(),
      direct_peers: this.source.getDirectPeerCount(),
      relayed_peers: this.source.getRelayedPeerCount(),
      mesh_peers: this.source.getMeshPeerCount(),
      contextGraph_count: contextGraphCount,
      total_triples: totalTriples,
      total_kcs: totalKCs,
      total_kas: totalKAs,
      store_bytes: storeBytes,
      confirmed_kcs: confirmedKCs,
      tentative_kcs: tentativeKCs,
      rpc_latency_ms: rpcLatency,
      rpc_healthy: rpcHealthy,
      relay_capacity: relayCapacity,
      relay_reservation_count: relayReservationCount,
      relay_active_circuits: relayActiveCircuits,
      relay_bytes_in: relayBytesIn,
      relay_bytes_out: relayBytesOut,
    };
  }

  private measureCpu(): number {
    const cores = cpus();
    let idle = 0;
    let total = 0;
    for (const c of cores) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }

    if (!this.prevCpuTimes) {
      this.prevCpuTimes = { idle, total };
      return 0;
    }

    const dIdle = idle - this.prevCpuTimes.idle;
    const dTotal = total - this.prevCpuTimes.total;
    this.prevCpuTimes = { idle, total };

    if (dTotal === 0) return 0;
    return Math.round((1 - dIdle / dTotal) * 10000) / 100;
  }
}
