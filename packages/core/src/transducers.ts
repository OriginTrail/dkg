export interface SourceAdapterContext {
  dataset: string;
  sourceType: string;
  sourceRef?: string;
}

export interface SourceRecord {
  dataset: string;
  sourceTable: string;
  values: Record<string, unknown>;
  rowNumber?: number;
  sourceRef?: string;
}

export interface SourceAdapterResult<TRow = SourceRecord> {
  rows: TRow[];
  errors?: string[];
  warnings?: string[];
}

export interface SourceAdapter<TInput = unknown, TRow = SourceRecord> {
  read(
    input: TInput,
    context: SourceAdapterContext,
  ): Promise<SourceAdapterResult<TRow>> | SourceAdapterResult<TRow>;
}

export interface NormalizedRecord extends SourceRecord {
  keys: Record<string, string | number | boolean | null>;
}

export interface NormalizerContext {
  dataset: string;
}

export interface NormalizeResult<TRecord = NormalizedRecord> {
  records: TRecord[];
  errors?: string[];
  warnings?: string[];
}

export interface Normalizer<TRow = SourceRecord, TRecord = NormalizedRecord> {
  normalize(
    rows: TRow[],
    context: NormalizerContext,
  ): Promise<NormalizeResult<TRecord>> | NormalizeResult<TRecord>;
}

export interface TransformContext<TRecord = NormalizedRecord> {
  dataset: string;
  record: TRecord;
}

export type Transform<TRecord = NormalizedRecord> = (
  value: unknown,
  context: TransformContext<TRecord>,
) => unknown;

export type TransformRegistry<TRecord = NormalizedRecord> = Record<string, Transform<TRecord>>;

export interface FieldMapping {
  sourceField: string;
  targetPredicate: string;
  required?: boolean;
  transform?: string;
}

export interface IdentityContext<TRecord = NormalizedRecord> {
  dataset: string;
  classIri: string;
  record: TRecord;
}

export interface IdentityStrategy<TRecord = NormalizedRecord> {
  keyFields: string[];
  buildId(record: TRecord, context: IdentityContext<TRecord>): string;
}

export interface RelationRule {
  predicate: string;
  sourceDataset: string;
  targetDataset: string;
  sourceField: string;
  targetField: string;
  many?: boolean;
}

export interface DatasetMappingSpec<TRecord = NormalizedRecord> {
  dataset: string;
  classIri: string;
  description?: string;
  identity: IdentityStrategy<TRecord>;
  fieldMappings: FieldMapping[];
  relationRules?: RelationRule[];
}

export interface AssetPartitionQuad {
  subject: string;
  predicate: string;
  object: string;
  graph?: string;
}

export interface AssetPartitionAsset {
  rootEntity: string;
  quads: AssetPartitionQuad[];
}

export interface AssetPartitionContext<TNode = Record<string, unknown>> {
  dataset: string;
  contextGraphId: string;
  nodes: readonly TNode[];
  quads: readonly AssetPartitionQuad[];
}

export interface AssetPartitionStrategy<TNode = Record<string, unknown>> {
  partition(
    context: AssetPartitionContext<TNode>,
  ): Promise<AssetPartitionAsset[]> | AssetPartitionAsset[];
}

export interface DatasetTransducerContext<TRecord = NormalizedRecord> {
  dataset: string;
  mappingSpec: DatasetMappingSpec<TRecord>;
}

export interface TransduceResult<TRecord = NormalizedRecord, TNode = Record<string, unknown>> {
  records: TRecord[];
  nodes: TNode[];
  quads: AssetPartitionQuad[];
  assets: AssetPartitionAsset[];
  errors?: string[];
  warnings?: string[];
}

export interface DatasetTransducer<TInput = unknown, TRecord = NormalizedRecord, TNode = Record<string, unknown>> {
  transduce(
    input: TInput,
    context: DatasetTransducerContext<TRecord>,
  ): Promise<TransduceResult<TRecord, TNode>> | TransduceResult<TRecord, TNode>;
}

export function defineSourceAdapter<TInput, TRow>(adapter: SourceAdapter<TInput, TRow>): SourceAdapter<TInput, TRow> {
  return adapter;
}

export function readWithSourceAdapter<TInput, TRow>(
  adapter: SourceAdapter<TInput, TRow>,
  input: TInput,
  context: SourceAdapterContext,
): Promise<SourceAdapterResult<TRow>> | SourceAdapterResult<TRow> {
  return adapter.read(input, context);
}

export function defineNormalizer<TRow, TRecord>(normalizer: Normalizer<TRow, TRecord>): Normalizer<TRow, TRecord> {
  return normalizer;
}

export function normalizeWith<TRow, TRecord>(
  normalizer: Normalizer<TRow, TRecord>,
  rows: TRow[],
  context: NormalizerContext,
): Promise<NormalizeResult<TRecord>> | NormalizeResult<TRecord> {
  return normalizer.normalize(rows, context);
}

export function defineAssetPartitionStrategy<TNode>(
  strategy: AssetPartitionStrategy<TNode>,
): AssetPartitionStrategy<TNode> {
  return strategy;
}

export function partitionAssetsWith<TNode>(
  strategy: AssetPartitionStrategy<TNode>,
  context: AssetPartitionContext<TNode>,
) {
  return strategy.partition(context);
}

export function defineDatasetTransducer<TInput, TRecord, TNode>(
  transducer: DatasetTransducer<TInput, TRecord, TNode>,
): DatasetTransducer<TInput, TRecord, TNode> {
  return transducer;
}

export function transduceWith<TInput, TRecord, TNode>(
  transducer: DatasetTransducer<TInput, TRecord, TNode>,
  input: TInput,
  context: DatasetTransducerContext<TRecord>,
): Promise<TransduceResult<TRecord, TNode>> | TransduceResult<TRecord, TNode> {
  return transducer.transduce(input, context);
}
