// SPDX-License-Identifier: Apache-2.0
import type { ContextGraphNamedGraphStats } from '@origintrail-official/dkg-agent';
import type { QueryOptions } from '@origintrail-official/dkg-storage';
export type { ContextGraphNamedGraphStats } from '@origintrail-official/dkg-agent';

export interface ContextGraphReader {
  statistics(options: QueryOptions): Promise<ContextGraphNamedGraphStats[]>;
}
export function readContextGraphNamedGraphStats(reader: ContextGraphReader, _contextGraphId: string,
  options: QueryOptions = {}): Promise<ContextGraphNamedGraphStats[]> {
  return reader.statistics({ ...options, priority: options.priority ?? 'background', source: options.source ?? 'node-ui.sub-graph-stats' });
}
