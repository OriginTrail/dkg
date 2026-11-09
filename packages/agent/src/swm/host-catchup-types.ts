// SPDX-License-Identifier: Apache-2.0
export interface SwmHostCatchupOptions {
  sinceSeqno?: number;
  maxRounds?: number;
  maxEntriesPerRound?: number;
  reportEntries?: boolean;
}
/** Every served envelope, independent of whether replay applied it. */
export interface SwmHostCatchupEntryReport { seqno: number; envelopeSha256: string }
export interface SwmHostCatchupResult {
  rounds: number;
  fetched: number;
  /** Envelopes whose apply path returned applied:true; this is not a triple count. */
  applied: number;
  /** Total triples inserted by successful replays. */
  appliedTriples: number;
  skipped: number;
  nextSeqno: number;
  denied?: string;
  entries?: SwmHostCatchupEntryReport[];
}
export interface SwmConnectedHostCatchupOptions extends SwmHostCatchupOptions { peers?: string[] }
export interface SwmConnectedHostCatchupResult extends SwmHostCatchupResult { peerId: string; error?: string }
