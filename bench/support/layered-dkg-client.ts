import type {
  BenchmarkClient,
  BenchmarkPayload,
} from '../../packages/cli/src/benchmark/publish-get/types.ts';

type Quad = BenchmarkPayload['quads'][number];
type MemoryView = 'working-memory' | 'shared-working-memory' | 'verified-memory';

interface MemoryRecord {
  contextGraphId: string;
  rootEntity: string;
  marker: string;
  quads: Quad[];
  workspaceOperationId?: string;
  shareOperationId?: string;
  kcId?: string;
}

interface PublisherJob {
  contextGraphId: string;
  jobId: string;
  roots: string[];
  status: 'queued' | 'finalized' | 'failed';
  error?: string;
}

export class LayeredDkgBenchmarkClient implements BenchmarkClient {
  readonly workingMemory = new Map<string, MemoryRecord>();
  readonly sharedWorkingMemory = new Map<string, MemoryRecord>();
  readonly verifiedMemory = new Map<string, MemoryRecord>();
  readonly publisherJobs = new Map<string, PublisherJob>();

  private shareSequence = 0;
  private workspaceSequence = 0;
  private kcSequence = 0;
  private jobSequence = 0;

  async status(): Promise<unknown> {
    return {
      ok: true,
      memoryLayers: {
        workingMemory: this.workingMemory.size,
        sharedWorkingMemory: this.sharedWorkingMemory.size,
        verifiedMemory: this.verifiedMemory.size,
      },
      publisherJobs: this.publisherJobs.size,
    };
  }

  async sharedMemoryWrite(contextGraphId: string, quads: Quad[]) {
    const working = await this.writeWorkingMemory(contextGraphId, quads);
    const shared = await this.liftWorkingMemoryToSharedMemory(contextGraphId, uniqueSubjects(quads));
    return {
      workspaceOperationId: working.workspaceOperationId,
      shareOperationId: shared.shareOperationId,
    };
  }

  async writeWorkingMemory(contextGraphId: string, quads: Quad[]) {
    const workspaceOperationId = `workspace-${++this.workspaceSequence}`;
    for (const rootEntity of uniqueSubjects(quads)) {
      const record = createMemoryRecord(contextGraphId, rootEntity, quads, { workspaceOperationId });
      this.workingMemory.set(rootEntity, record);
    }
    return { workspaceOperationId };
  }

  async liftWorkingMemoryToSharedMemory(contextGraphId: string, rootEntities: string[]) {
    const shareOperationId = `share-${++this.shareSequence}`;
    for (const rootEntity of rootEntities) {
      const record = this.workingMemory.get(rootEntity);
      if (!record) throw new Error(`Root ${rootEntity} is missing from working memory`);
      if (record.contextGraphId !== contextGraphId) {
        throw new Error(`Root ${rootEntity} belongs to ${record.contextGraphId}, not ${contextGraphId}`);
      }
      this.sharedWorkingMemory.set(rootEntity, { ...record, shareOperationId });
    }
    return { shareOperationId };
  }

  async publishFromSharedMemory(
    contextGraphId: string,
    selection: 'all' | { rootEntities: string[] },
    clearAfter = false,
  ) {
    const roots = selection === 'all' ? [...this.sharedWorkingMemory.keys()] : selection.rootEntities;
    const kcId = `kc-${++this.kcSequence}`;
    for (const rootEntity of roots) {
      this.promoteSharedRoot(contextGraphId, rootEntity, kcId);
      if (clearAfter) this.sharedWorkingMemory.delete(rootEntity);
    }
    return {
      kcId,
      status: 'finalized',
      kas: roots.map((rootEntity, index) => ({ tokenId: String(index + 1), rootEntity })),
    };
  }

  async publisherEnqueue(request: Parameters<BenchmarkClient['publisherEnqueue']>[0]) {
    for (const rootEntity of request.roots) {
      if (!this.sharedWorkingMemory.has(rootEntity)) {
        throw new Error(`Root ${rootEntity} is missing from shared working memory`);
      }
    }

    const jobId = `job-${++this.jobSequence}`;
    this.publisherJobs.set(jobId, {
      contextGraphId: request.contextGraphId,
      jobId,
      roots: [...request.roots],
      status: 'queued',
    });
    return { jobId };
  }

  async publisherJob(jobId: string) {
    const job = this.publisherJobs.get(jobId);
    if (!job) return { job: null };

    if (job.status === 'queued') {
      try {
        const kcId = `kc-${++this.kcSequence}`;
        for (const rootEntity of job.roots) {
          this.promoteSharedRoot(job.contextGraphId, rootEntity, kcId);
        }
        job.status = 'finalized';
      } catch (error) {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : String(error);
      }
    }

    return { job: { status: job.status, error: job.error } };
  }

  async query(
    sparql: string,
    _contextGraphId?: string,
    opts?: { view?: MemoryView },
  ) {
    const rootEntity = rootFromSparql(sparql);
    const view = opts?.view ?? 'verified-memory';
    const record = this.layer(view).get(rootEntity);

    return {
      result: {
        type: 'bindings' as const,
        bindings: record ? [{ value: record.marker }] : [],
      },
    };
  }

  private promoteSharedRoot(contextGraphId: string, rootEntity: string, kcId: string): void {
    const staged = this.sharedWorkingMemory.get(rootEntity);
    if (!staged) throw new Error(`Root ${rootEntity} is missing from shared working memory`);
    if (staged.contextGraphId !== contextGraphId) {
      throw new Error(`Root ${rootEntity} belongs to ${staged.contextGraphId}, not ${contextGraphId}`);
    }
    this.verifiedMemory.set(rootEntity, { ...staged, kcId });
  }

  private layer(view: MemoryView): Map<string, MemoryRecord> {
    if (view === 'working-memory') return this.workingMemory;
    if (view === 'shared-working-memory') return this.sharedWorkingMemory;
    return this.verifiedMemory;
  }
}

function createMemoryRecord(
  contextGraphId: string,
  rootEntity: string,
  quads: Quad[],
  ids: Pick<MemoryRecord, 'workspaceOperationId' | 'shareOperationId'>,
): MemoryRecord {
  const rootQuads = quads.filter((quad) => quad.subject === rootEntity);
  return {
    contextGraphId,
    rootEntity,
    marker: markerFromQuads(rootQuads),
    quads: rootQuads,
    ...ids,
  };
}

function uniqueSubjects(quads: Quad[]): string[] {
  return [...new Set(quads.map((quad) => quad.subject))];
}

function markerFromQuads(quads: Quad[]): string {
  const markerQuad = quads.find((quad) => quad.predicate === 'http://schema.org/identifier');
  if (!markerQuad) throw new Error('Benchmark payload is missing a marker quad');
  return String(markerQuad.object).replace(/^"|"$/g, '');
}

function rootFromSparql(sparql: string): string {
  const rootEntity = sparql.match(/<([^>]+)>/)?.[1];
  if (!rootEntity) throw new Error(`Unable to find root entity in SPARQL: ${sparql}`);
  return rootEntity;
}
