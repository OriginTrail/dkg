import { defineSuite } from 'esbench';
import {
  createPayload,
  getSparql,
  validateQueryContainsMarker,
} from '../packages/cli/src/benchmark/publish-get/payload.ts';
import type {
  BenchmarkConfig,
  BenchmarkPayload,
} from '../packages/cli/src/benchmark/publish-get/types.ts';
import { benchAsyncWithHooks } from './support/esbench-case-hooks.ts';
import { LayeredDkgBenchmarkClient } from './support/layered-dkg-client.ts';

export const GENERATED_PAYLOAD_SIZES = [
  { label: '10kb', bytes: 10 * 1024 },
  { label: '100kb', bytes: 100 * 1024 },
  { label: '2mb', bytes: 2 * 1024 * 1024 },
  { label: '200mb', bytes: 200 * 1024 * 1024 },
] as const;

type PayloadSizeLabel = (typeof GENERATED_PAYLOAD_SIZES)[number]['label'];

export default defineSuite({
  params: {
    payloadSize: resolvePayloadSizeLabels(),
  },
  baseline: {
    type: 'Name',
    value: 'synchronous publish with finalization',
  },
  timing: {
    evaluateOverhead: false,
    iterations: 16,
    samples: 5,
    unrollFactor: 1,
    warmup: 1,
  },
  async setup(scene) {
    const config = createConfig(scene.params.payloadSize as PayloadSizeLabel);
    let sequence = 0;

    let readPayload: BenchmarkPayload | undefined;
    const readClient = new LayeredDkgBenchmarkClient();
    benchAsyncWithHooks(
      scene,
      'get/read retrieval',
      async () => {
        const payload = requirePayload(readPayload, 'get/read retrieval');
        const response = await readClient.query(
          getSparql(payload.rootEntity),
          config.contextGraphId,
          { view: 'verified-memory' },
        );
        validateQueryContainsMarker(response.result, payload.marker);
      },
      {
        beforeIteration: async () => {
          readPayload = createPayload(config, `esbench-get-${sequence++}`, 1, 'sync', false);
          await readClient.sharedMemoryWrite(config.contextGraphId, readPayload.quads);
          await readClient.publishFromSharedMemory(
            config.contextGraphId,
            { rootEntities: [readPayload.rootEntity] },
            false,
          );
        },
        afterIteration: () => {
          readPayload = undefined;
          readClient.clear();
        },
      },
    );

    let syncPayload: BenchmarkPayload | undefined;
    const syncClient = new LayeredDkgBenchmarkClient();
    benchAsyncWithHooks(
      scene,
      'synchronous publish with finalization',
      async () => {
        const payload = requirePayload(syncPayload, 'synchronous publish with finalization');
        const result = await syncClient.publishFromSharedMemory(
          config.contextGraphId,
          { rootEntities: [payload.rootEntity] },
          false,
        );
        if (!result.kcId) throw new Error('sync publish did not finalize a knowledge collection');
      },
      {
        beforeIteration: async () => {
          syncPayload = createPayload(config, `esbench-sync-${sequence++}`, 1, 'sync', false);
          await syncClient.sharedMemoryWrite(config.contextGraphId, syncPayload.quads);
        },
        afterIteration: () => {
          syncPayload = undefined;
          syncClient.clear();
        },
      },
    );

    let asyncPayload: BenchmarkPayload | undefined;
    let asyncShareOperationId: string | undefined;
    const asyncClient = new LayeredDkgBenchmarkClient();
    benchAsyncWithHooks(
      scene,
      'asynchronous publish enqueue and finalization',
      async () => {
        const payload = requirePayload(asyncPayload, 'asynchronous publish enqueue and finalization');
        if (!asyncShareOperationId) throw new Error('async setup did not produce a share operation id');

        const queued = await asyncClient.publisherEnqueue({
          contextGraphId: config.contextGraphId,
          shareOperationId: asyncShareOperationId,
          roots: [payload.rootEntity],
          namespace: config.namespace,
          scope: config.scope,
          authorityProofRef: config.authorityProofRef,
          swmId: 'swm-main',
          transitionType: 'CREATE',
          authorityType: 'owner',
        });
        if (!queued.jobId) throw new Error('async publisher did not return a job id');

        const completed = await asyncClient.publisherJob(queued.jobId);
        if (completed.job?.status !== 'finalized') {
          throw new Error(`async publisher did not finalize: ${completed.job?.status ?? 'missing job'}`);
        }
      },
      {
        beforeIteration: async () => {
          asyncPayload = createPayload(config, `esbench-async-${sequence++}`, 1, 'async', false);
          const prepared = await asyncClient.sharedMemoryWrite(config.contextGraphId, asyncPayload.quads);
          asyncShareOperationId = prepared.shareOperationId ?? prepared.workspaceOperationId;
        },
        afterIteration: () => {
          asyncPayload = undefined;
          asyncShareOperationId = undefined;
          asyncClient.clear();
        },
      },
    );

    let uploadPayload: BenchmarkPayload | undefined;
    const uploadClient = new LayeredDkgBenchmarkClient();
    benchAsyncWithHooks(
      scene,
      'upload payload to local working memory',
      async () => {
        const payload = requirePayload(uploadPayload, 'upload payload to local working memory');
        const prepared = await uploadClient.writeWorkingMemory(config.contextGraphId, payload.quads);
        if (!prepared.workspaceOperationId) {
          throw new Error('working-memory upload did not return a workspace operation id');
        }
      },
      {
        beforeIteration: () => {
          uploadPayload = createPayload(config, `esbench-upload-${sequence++}`, 1, 'sync', false);
        },
        afterIteration: () => {
          uploadPayload = undefined;
          uploadClient.clear();
        },
      },
    );

    let liftPayload: BenchmarkPayload | undefined;
    const liftClient = new LayeredDkgBenchmarkClient();
    benchAsyncWithHooks(
      scene,
      'lift local working memory to shared working memory',
      async () => {
        const payload = requirePayload(liftPayload, 'lift local working memory to shared working memory');
        const prepared = await liftClient.liftWorkingMemoryToSharedMemory(
          config.contextGraphId,
          [payload.rootEntity],
        );
        if (!prepared.shareOperationId) {
          throw new Error('working-memory lift did not return a share operation id');
        }
      },
      {
        beforeIteration: async () => {
          liftPayload = createPayload(config, `esbench-lift-${sequence++}`, 1, 'sync', false);
          await liftClient.writeWorkingMemory(config.contextGraphId, liftPayload.quads);
        },
        afterIteration: () => {
          liftPayload = undefined;
          liftClient.clear();
        },
      },
    );
  },
});

function createConfig(payloadSize: PayloadSizeLabel): BenchmarkConfig {
  return {
    contextGraphId: 'bench-cg',
    repeat: 30,
    warmups: 3,
    timeoutMs: 120_000,
    payloadSizeBytes: payloadSizeBytes(payloadSize),
    fixture: 'generated',
    outputFormat: 'json',
    namespace: 'benchmark',
    scope: 'publish-async-get',
    authorityProofRef: 'proof:benchmark-local',
    pollIntervalMs: 1000,
    asyncSuccessStatuses: ['finalized'],
    getView: 'verified-memory',
  };
}

function requirePayload(payload: BenchmarkPayload | undefined, caseName: string): BenchmarkPayload {
  if (!payload) throw new Error(`No payload was prepared for ${caseName}`);
  return payload;
}

function resolvePayloadSizeLabels(): PayloadSizeLabel[] {
  const raw = process.env.DKG_ESBENCH_PAYLOAD_SIZES;
  if (!raw?.trim()) return GENERATED_PAYLOAD_SIZES.map((size) => size.label);

  const requested = raw.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
  if (requested.length === 0) return GENERATED_PAYLOAD_SIZES.map((size) => size.label);

  const known = new Set(GENERATED_PAYLOAD_SIZES.map((size) => size.label));
  for (const label of requested) {
    if (!known.has(label as PayloadSizeLabel)) {
      throw new Error(`Unknown DKG_ESBENCH_PAYLOAD_SIZES entry "${label}". Expected one of: ${[...known].join(', ')}`);
    }
  }
  return requested as PayloadSizeLabel[];
}

function payloadSizeBytes(label: PayloadSizeLabel): number {
  const size = GENERATED_PAYLOAD_SIZES.find((entry) => entry.label === label);
  if (!size) throw new Error(`Unknown payload size label: ${label}`);
  return size.bytes;
}
