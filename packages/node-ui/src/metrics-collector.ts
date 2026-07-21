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

/** Default cadence for cheap system/network snapshots (30 seconds). */
export const DEFAULT_METRICS_COLLECTION_INTERVAL_MS = 30_000;
/**
 * Default cadence for full-store cardinality scans (12 hours). These queries
 * can saturate large remote SPARQL stores, so they deliberately do not inherit
 * the cheap snapshot cadence.
 */
export const DEFAULT_STORE_METRICS_COLLECTION_INTERVAL_MS = 43_200_000;
/** Prevent an accidentally configured tight loop from pegging the daemon. */
export const MIN_METRICS_COLLECTION_INTERVAL_MS = 1_000;
/** Largest delay Node timers represent without overflowing to a ~1 ms delay. */
export const MAX_METRICS_COLLECTION_INTERVAL_MS = 2_147_483_647;

export interface MetricsCollectorOptions {
  /** Cheap system/network snapshot cadence. Default: 30 seconds. */
  collectionIntervalMs?: number;
  /** Expensive full-store cardinality cadence. Default: 12 hours. */
  storeCollectionIntervalMs?: number;
}

interface StoreMetricsSnapshot {
  totalTriples: number | null;
  totalKCs: number | null;
  totalKAs: number | null;
  confirmedKCs: number | null;
  tentativeKCs: number | null;
  contextGraphCount: number | null;
}

export function assertMetricsCollectionIntervalMs(value: number, field: string): number {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < MIN_METRICS_COLLECTION_INTERVAL_MS ||
    value > MAX_METRICS_COLLECTION_INTERVAL_MS
  ) {
    throw new Error(
      `${field} must be a finite integer between ` +
      `${MIN_METRICS_COLLECTION_INTERVAL_MS} and ${MAX_METRICS_COLLECTION_INTERVAL_MS} ms ` +
      `(received ${String(value)})`,
    );
  }
  return value;
}

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
  private systemTimer: ReturnType<typeof setTimeout> | null = null;
  private storeTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private activeStoreCollection: Promise<StoreMetricsSnapshot> | null = null;
  private latestStoreMetrics: StoreMetricsSnapshot | null = null;
  private initialSnapshotHandled = false;
  private prevCpuTimes: { idle: number; total: number } | null = null;
  private readonly startTime = Date.now();
  readonly collectionIntervalMs: number;
  readonly storeCollectionIntervalMs: number;

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
    options: MetricsCollectorOptions = {},
  ) {
    this.collectionIntervalMs = assertMetricsCollectionIntervalMs(
      options.collectionIntervalMs ?? DEFAULT_METRICS_COLLECTION_INTERVAL_MS,
      'collectionIntervalMs',
    );
    this.storeCollectionIntervalMs = assertMetricsCollectionIntervalMs(
      options.storeCollectionIntervalMs ?? DEFAULT_STORE_METRICS_COLLECTION_INTERVAL_MS,
      'storeCollectionIntervalMs',
    );
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Start both lanes immediately. Each lane schedules its next run only
    // after its current work settles, so neither cheap snapshots nor expensive
    // scans can overlap with themselves. Keeping the lanes independent lets
    // 30-second CPU/memory snapshots continue during a slow store scan.
    void this.runSystemCollection();
    void this.runStoreCollection();
  }

  private shouldCollectStoreMetricsSafely(): boolean {
    try {
      return this.shouldCollectStoreMetrics();
    } catch {
      return false;
    }
  }

  private scheduleSystemCollection(): void {
    if (!this.running) return;
    this.systemTimer = setTimeout(() => {
      this.systemTimer = null;
      void this.runSystemCollection();
    }, this.collectionIntervalMs);
  }

  private async runSystemCollection(): Promise<void> {
    if (!this.running) return;
    try {
      const cachedStoreMetrics = this.shouldCollectStoreMetricsSafely()
        ? this.latestStoreMetrics
        : null;
      const snap = await this.collectAndStoreInternal(false, cachedStoreMetrics);
      if (cachedStoreMetrics && !this.initialSnapshotHandled) {
        this.initialSnapshotHandled = true;
        this.backfillNulls(snap);
      }
    } catch {
      // Metrics are best-effort and must never stop the daemon.
    } finally {
      this.scheduleSystemCollection();
    }
  }

  private scheduleStoreCollection(delayMs: number): void {
    if (!this.running) return;
    this.storeTimer = setTimeout(() => {
      this.storeTimer = null;
      void this.runStoreCollection();
    }, delayMs);
  }

  private async runStoreCollection(): Promise<void> {
    if (!this.running) return;
    if (!this.shouldCollectStoreMetricsSafely()) {
      // Keep re-evaluating the presence gate at the cheaper of the two
      // cadences. This does not query the store, and prevents a consumer that
      // appears just after startup from waiting 12 hours for its first scan.
      this.scheduleStoreCollection(
        Math.min(this.collectionIntervalMs, this.storeCollectionIntervalMs),
      );
      return;
    }

    try {
      this.latestStoreMetrics = await this.collectStoreMetricsSerialized();
    } catch {
      // Individual source errors are already converted to null below. This is
      // defence in depth for an unexpected collector-level failure.
    } finally {
      this.scheduleStoreCollection(this.storeCollectionIntervalMs);
    }
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
    this.running = false;
    if (this.systemTimer) {
      clearTimeout(this.systemTimer);
      this.systemTimer = null;
    }
    if (this.storeTimer) {
      clearTimeout(this.storeTimer);
      this.storeTimer = null;
    }
  }

  async collectAndStore(): Promise<MetricSnapshotRow> {
    return this.collectAndStoreInternal(this.shouldCollectStoreMetricsSafely());
  }

  private async collectAndStoreInternal(
    includeStoreMetrics: boolean,
    cachedStoreMetrics: StoreMetricsSnapshot | null = null,
  ): Promise<MetricSnapshotRow> {
    const snap = await this.collectInternal(includeStoreMetrics, cachedStoreMetrics);
    this.db.insertSnapshot(snap);
    return snap;
  }

  async collect(): Promise<MetricSnapshotRow> {
    return this.collectInternal(this.shouldCollectStoreMetricsSafely());
  }

  private async collectInternal(
    includeStoreMetrics: boolean,
    cachedStoreMetrics: StoreMetricsSnapshot | null = null,
  ): Promise<MetricSnapshotRow> {
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

    let storeMetrics = cachedStoreMetrics ?? {
      totalTriples: null,
      totalKCs: null,
      totalKAs: null,
      confirmedKCs: null,
      tentativeKCs: null,
      contextGraphCount: null,
    };

    // These six getters are full-store SPARQL scans (COUNT / COUNT(DISTINCT)
    // across every graph, plus the context-graph inventory) — the expensive
    // part of a tick. Skip them when nothing is consuming metrics, leaving the
    // columns null (already nullable; charts render the gap). The cheap
    // system/network metrics above always collect, so a CPU peg is still
    // recorded even while no dashboard is open. (#1066 Item 1)
    if (includeStoreMetrics) {
      storeMetrics = await this.collectStoreMetricsSerialized();
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
      contextGraph_count: storeMetrics.contextGraphCount,
      total_triples: storeMetrics.totalTriples,
      total_kcs: storeMetrics.totalKCs,
      total_kas: storeMetrics.totalKAs,
      store_bytes: storeBytes,
      confirmed_kcs: storeMetrics.confirmedKCs,
      tentative_kcs: storeMetrics.tentativeKCs,
      rpc_latency_ms: rpcLatency,
      rpc_healthy: rpcHealthy,
      relay_capacity: relayCapacity,
      relay_reservation_count: relayReservationCount,
      relay_active_circuits: relayActiveCircuits,
      relay_bytes_in: relayBytesIn,
      relay_bytes_out: relayBytesOut,
    };
  }

  private collectStoreMetricsSerialized(): Promise<StoreMetricsSnapshot> {
    if (this.activeStoreCollection) return this.activeStoreCollection;
    const collection = this.collectStoreMetrics();
    this.activeStoreCollection = collection;
    void collection.finally(() => {
      if (this.activeStoreCollection === collection) this.activeStoreCollection = null;
    });
    return collection;
  }

  private async collectStoreMetrics(): Promise<StoreMetricsSnapshot> {
    let totalTriples: number | null = null;
    let totalKCs: number | null = null;
    let totalKAs: number | null = null;
    let confirmedKCs: number | null = null;
    let tentativeKCs: number | null = null;
    let contextGraphCount: number | null = null;
    try { totalTriples = await this.source.getTotalTriples(); } catch { /* ignore */ }
    try { totalKCs = await this.source.getTotalKCs(); } catch { /* ignore */ }
    try { totalKAs = await this.source.getTotalKAs(); } catch { /* ignore */ }
    try { confirmedKCs = await this.source.getConfirmedKCs(); } catch { /* ignore */ }
    try { tentativeKCs = await this.source.getTentativeKCs(); } catch { /* ignore */ }
    try { contextGraphCount = await this.source.getContextGraphCount(); } catch { /* ignore */ }
    return {
      totalTriples,
      totalKCs,
      totalKAs,
      confirmedKCs,
      tentativeKCs,
      contextGraphCount,
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
