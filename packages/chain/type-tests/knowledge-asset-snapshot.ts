import type { ContextGraphForKaAnswer } from '../src/chain-index/knowledge-asset-read-model.js';
import type { ContextGraphKaList } from '../src/chain-index/knowledge-asset-reducer.js';
import type { KnowledgeAssetSnapshotOperationTable } from '../src/chain-index/knowledge-asset-read-model-snapshot.js';
import {
  planKnowledgeAssetSnapshotRead, createKnowledgeAssetReadSnapshot, evaluateKnowledgeAssetSnapshot,
  type ChainEventDecoderRegistry, type ChainEventLogState, type KnowledgeAssetSnapshotRead,
} from '../src/internal/chain-index-worker.js';

declare const state: ChainEventLogState;
declare const registry: ChainEventDecoderRegistry;
const bindingPlan = planKnowledgeAssetSnapshotRead({ state,
  contextGraphStorageAddress: `0x${'11'.repeat(20)}`, read: { kind: 'binding', args: { kaId: 1n } } });
if (bindingPlan !== undefined) {
  const snapshot = createKnowledgeAssetReadSnapshot(bindingPlan, []);
  const result: Promise<ContextGraphForKaAnswer | undefined> = evaluateKnowledgeAssetSnapshot(snapshot, registry);
  // @ts-expect-error A binding snapshot cannot evaluate to a graph list.
  const wrong: Promise<ContextGraphKaList | undefined> = evaluateKnowledgeAssetSnapshot(snapshot, registry);
  void result; void wrong;
}
// @ts-expect-error An ordinal snapshot requires its index.
const missingOrdinalIndex: KnowledgeAssetSnapshotRead = { kind: 'ordinal', args: { contextGraphId: 7n } };
void missingOrdinalIndex;

declare const incompleteOperations: Pick<KnowledgeAssetSnapshotOperationTable, 'binding' | 'list'>;
// @ts-expect-error Every read kind requires its own operation descriptor.
const missingOrdinalOperation: KnowledgeAssetSnapshotOperationTable = incompleteOperations;
declare const bindingOperation: KnowledgeAssetSnapshotOperationTable['binding'];
// @ts-expect-error An ordinal descriptor cannot inherit a binding selector/projector.
const wrongOperation: KnowledgeAssetSnapshotOperationTable['ordinal'] = bindingOperation;
void missingOrdinalOperation; void wrongOperation;

// The root SDK must not acquire the worker's decoder/planner/snapshot machinery.
type PublicRoot = typeof import('../src/index.js');
type WorkerPlumbing = 'ChainEventDecoderRegistry' | 'planKnowledgeAssetSnapshotRead'
  | 'createKnowledgeAssetReadSnapshot' | 'evaluateKnowledgeAssetSnapshot' | 'createKnowledgeAssetReadModel';
type AssertNever<T extends never> = T;
type NoWorkerPlumbingAtRoot = AssertNever<Extract<keyof PublicRoot, WorkerPlumbing>>;
declare const noWorkerPlumbing: NoWorkerPlumbingAtRoot;
void noWorkerPlumbing;
