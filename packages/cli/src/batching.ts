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
    const key = q.subject;
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
    const entityChunks = splitOversizedEntities
      ? splitEntityQuads(entityQuads, { maxBatchQuads, maxBatchBytes, estimateBatchBytes })
      : [entityQuads];

    for (const chunk of entityChunks) {
      validateSingleBatch(chunk, { maxBatchQuads, maxBatchBytes, estimateBatchBytes });

      const nextBatch = [...batch, ...chunk];
      const exceedsQuadLimit = nextBatch.length > maxBatchQuads;
      const exceedsByteLimit = maxBatchBytes && estimateBatchBytes
        ? estimateBatchBytes(nextBatch) > maxBatchBytes
        : false;

      if ((exceedsQuadLimit || exceedsByteLimit) && batch.length > 0) {
        batches.push(batch);
        batch = [...chunk];
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

function splitEntityQuads(
  entityQuads: PublishQuad[],
  options: Required<Pick<BatchEntityQuadsOptions, 'maxBatchQuads'>> & Pick<BatchEntityQuadsOptions, 'maxBatchBytes' | 'estimateBatchBytes'>,
): PublishQuad[][] {
  const chunks: PublishQuad[][] = [];
  let current: PublishQuad[] = [];

  for (const quad of entityQuads) {
    const next = [...current, quad];
    const exceedsQuadLimit = next.length > options.maxBatchQuads;
    const exceedsByteLimit = options.maxBatchBytes && options.estimateBatchBytes
      ? options.estimateBatchBytes(next) > options.maxBatchBytes
      : false;

    if ((exceedsQuadLimit || exceedsByteLimit) && current.length > 0) {
      chunks.push(current);
      current = [quad];
    } else {
      current = next;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function validateSingleBatch(
  quads: PublishQuad[],
  options: Required<Pick<BatchEntityQuadsOptions, 'maxBatchQuads'>> & Pick<BatchEntityQuadsOptions, 'maxBatchBytes' | 'estimateBatchBytes'>,
): void {
  if (quads.length > options.maxBatchQuads) {
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
