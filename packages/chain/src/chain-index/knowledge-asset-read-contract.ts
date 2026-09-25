import type { ContextGraphForKaAnswer } from './knowledge-asset-read-model.js';
import type { ContextGraphKaList } from './knowledge-asset-reducer.js';

/** One operation/result relationship, shared by inline snapshots and worker IPC. */
export interface KnowledgeAssetResultByKind {
  binding: ContextGraphForKaAnswer;
  list: ContextGraphKaList;
  ordinal: Readonly<{ kaId: bigint; asOfBlockNumber: number }>;
}

export type KnowledgeAssetReadKind = keyof KnowledgeAssetResultByKind;

interface KnowledgeAssetReadFieldsByKind {
  binding: { kaId: bigint };
  list: { contextGraphId: bigint };
  ordinal: { contextGraphId: bigint; index: bigint };
}

export type KnowledgeAssetSnapshotRead<K extends KnowledgeAssetReadKind = KnowledgeAssetReadKind> = {
  [P in K]: { readonly kind: P; readonly args: Readonly<KnowledgeAssetReadFieldsByKind[P]> };
}[K];

export type KnowledgeAssetSnapshotResult<K extends KnowledgeAssetReadKind = KnowledgeAssetReadKind> =
  KnowledgeAssetResultByKind[K];
