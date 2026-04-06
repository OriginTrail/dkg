import { cpus, totalmem, freemem } from 'node:os';
import { memoryUsage } from 'node:process';
import { statfs } from 'node:fs';
import { promisify } from 'node:util';

const statfsAsync = promisify(statfs);
import type { DashboardDB, MetricSnapshotRow } from './db.js';

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
  getStoreBytes(): Promise<number>;
  getRpcLatencyMs(): Promise<number>;
  isRpcHealthy(): Promise<boolean>;
}

const SNAPSHOT_INTERVAL_MS = 120_000; // 2 minutes

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

    try { totalTriples = await this.source.getTotalTriples(); } catch { /* ignore */ }
    try { totalKCs = await this.source.getTotalKCs(); } catch { /* ignore */ }
    try { totalKAs = await this.source.getTotalKAs(); } catch { /* ignore */ }
    try { confirmedKCs = await this.source.getConfirmedKCs(); } catch { /* ignore */ }
    try { tentativeKCs = await this.source.getTentativeKCs(); } catch { /* ignore */ }
    try { contextGraphCount = await this.source.getContextGraphCount(); } catch { /* ignore */ }

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
      paranet_count: contextGraphCount,
      total_triples: totalTriples,
      total_kcs: totalKCs,
      total_kas: totalKAs,
      store_bytes: storeBytes,
      confirmed_kcs: confirmedKCs,
      tentative_kcs: tentativeKCs,
      rpc_latency_ms: rpcLatency,
      rpc_healthy: rpcHealthy,
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
