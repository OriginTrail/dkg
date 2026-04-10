export interface PublishQuad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

export interface BatchEntityQuadsOptions {
  maxBatchQuads?: number;
  maxBatchBytes?: number;
  estimateBatchBytes?: (batch: PublishQuad[]) => number;
  splitOversizedEntities?: boolean;
}

export function batchEntityQuads(
  quads: PublishQuad[],
  options: BatchEntityQuadsOptions = {},
): PublishQuad[][] {
  const maxBatchQuads = options.maxBatchQuads ?? 500;
  const maxBatchBytes = options.maxBatchBytes;
  const estimateBatchBytes = options.estimateBatchBytes;
  const splitOversizedEntities = options.splitOversizedEntities ?? false;

  const byEntity = new Map<string, PublishQuad[]>();
  for (const q of quads) {
    const key = canonicalRootEntity(q.subject);
    let arr = byEntity.get(key);
    if (!arr) {
      arr = [];
      byEntity.set(key, arr);
    }
    arr.push(q);
  }

  const batches: PublishQuad[][] = [];
  let batch: PublishQuad[] = [];

  for (const entityQuads of byEntity.values()) {
    const entityBatches = splitEntityBatch(entityQuads, {
      maxBatchQuads,
      maxBatchBytes,
      estimateBatchBytes,
      splitOversizedEntities,
    });

    for (const entityBatch of entityBatches) {
      const nextBatch = [...batch, ...entityBatch];
      const exceedsQuadLimit = nextBatch.length > maxBatchQuads;
      const exceedsByteLimit = maxBatchBytes && estimateBatchBytes
        ? estimateBatchBytes(nextBatch) > maxBatchBytes
        : false;

      if ((exceedsQuadLimit || exceedsByteLimit) && batch.length > 0) {
        batches.push(batch);
        batch = [...entityBatch];
        continue;
      }

      batch = nextBatch;
    }
  }

  if (batch.length > 0) {
    batches.push(batch);
  }

  return batches;
}

function canonicalRootEntity(subject: string): string {
  const marker = '/.well-known/genid/';
  const index = subject.indexOf(marker);
  return index >= 0 ? subject.slice(0, index) : subject;
}

function validateSingleBatch(
  quads: PublishQuad[],
  options: Required<Pick<BatchEntityQuadsOptions, 'maxBatchQuads' | 'splitOversizedEntities'>> & Pick<BatchEntityQuadsOptions, 'maxBatchBytes' | 'estimateBatchBytes'>,
): void {
  if (!options.splitOversizedEntities && quads.length > options.maxBatchQuads) {
    throw new Error(
      `Single entity batch exceeds maxBatchQuads (${quads.length} > ${options.maxBatchQuads}) for subject ${quads[0]?.subject}`,
    );
  }
  if (options.maxBatchBytes && options.estimateBatchBytes) {
    const bytes = options.estimateBatchBytes(quads);
    if (bytes > options.maxBatchBytes) {
      throw new Error(
        `Single entity batch exceeds maxBatchBytes (${bytes} > ${options.maxBatchBytes}) for subject ${quads[0]?.subject}`,
      );
    }
  }
}

function splitEntityBatch(
  quads: PublishQuad[],
  options: Required<Pick<BatchEntityQuadsOptions, 'maxBatchQuads' | 'splitOversizedEntities'>> & Pick<BatchEntityQuadsOptions, 'maxBatchBytes' | 'estimateBatchBytes'>,
): PublishQuad[][] {
  if (!options.splitOversizedEntities || quads.length <= options.maxBatchQuads) {
    validateSingleBatch(quads, options);
    return [quads];
  }

  const batches: PublishQuad[][] = [];
  for (let i = 0; i < quads.length; i += options.maxBatchQuads) {
    const batch = quads.slice(i, i + options.maxBatchQuads);
    validateSingleBatch(batch, options);
    batches.push(batch);
  }

  return batches;
}
