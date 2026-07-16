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
  if (quads.length > options.maxBatchQuads) {
    if (!options.splitOversizedEntities) {
      throw new Error(
        `Single entity batch exceeds maxBatchQuads (${quads.length} > ${options.maxBatchQuads}) for subject ${quads[0]?.subject}`,
      );
    }
    return;
  }
  if (options.maxBatchBytes && options.estimateBatchBytes) {
    const bytes = options.estimateBatchBytes(quads);
    if (bytes > options.maxBatchBytes) {
      if (!options.splitOversizedEntities) {
        throw new Error(
          `Single entity batch exceeds maxBatchBytes (${bytes} > ${options.maxBatchBytes}) for subject ${quads[0]?.subject}`,
        );
      }
    }
  }
}

function splitEntityBatch(
  quads: PublishQuad[],
  options: Required<Pick<BatchEntityQuadsOptions, 'maxBatchQuads' | 'splitOversizedEntities'>> & Pick<BatchEntityQuadsOptions, 'maxBatchBytes' | 'estimateBatchBytes'>,
): PublishQuad[][] {
  const needsQuadSplit = quads.length > options.maxBatchQuads;
  const needsByteSplit = options.maxBatchBytes && options.estimateBatchBytes
    ? options.estimateBatchBytes(quads) > options.maxBatchBytes
    : false;

  if (!options.splitOversizedEntities || (!needsQuadSplit && !needsByteSplit)) {
    validateSingleBatch(quads, options);
    return [quads];
  }

  const batches: PublishQuad[][] = [];
  let batch: PublishQuad[] = [];

  for (const q of quads) {
    const next = [...batch, q];
    const overQuads = next.length > options.maxBatchQuads;
    const overBytes = options.maxBatchBytes && options.estimateBatchBytes
      ? options.estimateBatchBytes(next) > options.maxBatchBytes
      : false;

    if ((overQuads || overBytes) && batch.length > 0) {
      batches.push(batch);
      batch = [q];
    } else {
      batch = next;
    }
  }

  if (batch.length > 0) batches.push(batch);

  for (const b of batches) {
    if (b.length > options.maxBatchQuads) {
      throw new Error(
        `Single quad exceeds maxBatchQuads (1 > ${options.maxBatchQuads}) for subject ${b[0]?.subject}`,
      );
    }
    if (options.maxBatchBytes && options.estimateBatchBytes && options.estimateBatchBytes(b) > options.maxBatchBytes) {
      throw new Error(
        `Single quad exceeds maxBatchBytes for subject ${b[0]?.subject}`,
      );
    }
  }

  return batches;
}
