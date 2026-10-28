// SPDX-License-Identifier: Apache-2.0
import type { DKGQueryEngine, ContextGraphPartitionReadOptions } from '@origintrail-official/dkg-query';

export function partitionReadOptionsContract(engine: DKGQueryEngine): void {
  const options: ContextGraphPartitionReadOptions = { subGraphName: 'docs', graphSuffix: '_shared_memory',
    includeSharedMemory: true, includeSharedMemoryMeta: true, signal: new AbortController().signal,
    timeout: 1000, maxResponseBytes: 1024, priority: 'background', source: 'contract' };
  void engine.listContextGraphQueryPartitionReads('cg', options);
  void engine.readContextGraphNamedGraphStats('cg', options);
  // @ts-expect-error Declared views belong to SPARQL query execution, not partition inventory.
  void engine.listContextGraphQueryPartitionReads('cg', { view: 'working-memory' });
  // @ts-expect-error Private partitions are not supported by public statistics.
  void engine.readContextGraphNamedGraphStats('cg', { includePrivate: true });
  // @ts-expect-error Assertion targeting belongs to declared-view query execution.
  void engine.readContextGraphNamedGraphStats('cg', { assertionName: 'one' });
  // @ts-expect-error The context graph is owned by the explicit argument.
  void engine.readContextGraphNamedGraphStats('cg', { contextGraphId: 'other' });
}
