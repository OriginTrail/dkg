import type { Rfc64CatalogReplayRecoveryStatusV1 } from './catalog-replay-recovery-runtime-v1.js';
export type Rfc64CatalogConnectionReplayResultV1 = Readonly<{ requested?: number; failed: number }>;
export class Rfc64CatalogReplayRunReporterV1 {
  readonly #reportedRuns = new WeakSet<Rfc64CatalogConnectionReplayResultV1>();
  constructor(private readonly ports: {
    replayStatus(contextGraphId: string): Pick<Rfc64CatalogReplayRecoveryStatusV1, 'failed' | 'unresolvedPeerCount'> | null;
    log(level: 'warn' | 'debug', message: string): void;
  }) {}
  /**
   * Say once per run what a replay that could not finish means. A warning is
   * kept for evidence that this node's catalog may lack heads its peers hold:
   * the graph's replay status then holds a full-replay witness (a promised
   * head this node has not applied, or a run that could not cover its peers).
   * Peers that could not be replayed from, because they were busy or did not
   * answer, or because this node's catalog service was not available, are
   * asked again by later replays and say nothing about this node's rows.
   */
  report(
    contextGraphId: string,
    peerId: string,
    result: Rfc64CatalogConnectionReplayResultV1,
  ): void {
    if (this.#reportedRuns.has(result)) return;
    this.#reportedRuns.add(result);
    const status = this.ports.replayStatus(contextGraphId);
    const counts = `${result.requested ?? 0} peer(s) answered, ${result.failed} failed, ${
      status?.unresolvedPeerCount ?? 'unknown'
    } retried later`;
    if (status !== null && !status.failed) {
      this.ports.log(
        'debug',
        `RFC-64 catalog replay for "${contextGraphId}" after ${peerId.slice(-8)} connected could not `
          + `replay from every peer (busy, no answer, or no local catalog service); later replays ask `
          + `again (${counts})`,
      );
      return;
    }
    this.ports.log(
      'warn',
      `RFC-64 catalog replay incomplete for "${contextGraphId}" after ${peerId.slice(-8)} connected: ${
        status === null
          ? 'its replay status is not available'
          : 'this node may lack catalog heads its peers hold until a full replay passes'
      } (${counts})`,
    );
  }
}
