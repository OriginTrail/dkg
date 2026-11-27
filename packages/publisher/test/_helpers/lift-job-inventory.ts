/**
 * OT-RFC-73 P9a: persisted publisher inventories for the paging tests.
 *
 * A job is stamped from a template that the real publisher produced in that state (so the payload is one the
 * production decoder reads), re-keyed (`jobId`, `acceptedAt`, graph) and serialized straight into the control graph by
 * the production serializer. That makes it cheap to build inventories of hundreds of jobs with the shapes the listing
 * must tell apart:
 *
 *   - `vm`            a knowledge-asset publish job with its lifecycle-key index, as every writer produces it;
 *   - `vm-unindexed`  the same without the index triple (the legacy rows `ensureVmPublishIntentIndex` repairs);
 *   - `raw`           a raw-lift job (operator-only) in the current payload schema;
 *   - `raw-v0`        a raw-lift job in the legacy v0 payload schema.
 *
 * Raw lifts carry a `contextGraphId` on their request exactly like publish jobs do, which is what a naive graph filter
 * trips over. `expectedMembership` is the independent oracle: it answers from the spec alone, never from a query.
 */
import { OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { QuorumUnmetError, TripleStoreAsyncLiftPublisher } from '../../src/index.js';
import type { LiftJob, LiftJobState, PersistedLiftJob } from '../../src/lift-job.js';
import {
  CONTROL_LIFECYCLE_KEY,
  DEFAULT_CONTROL_GRAPH_URI,
  jobSubject,
  serializeJob,
} from '../../src/async-lift-control-plane.js';
import { createRawLiftJobRequest } from '../../src/async-lift-publisher-utils.js';
import type { LiftJobPage, LiftJobPageRequest } from '../../src/lift-job-page.js';
import { KA_VM_BROADCAST_TX, KA_VM_VALIDATION, kaVmPublishRequest } from '../../../../scripts/testing/ka-vm-publish.js';

export const GRAPH = DEFAULT_CONTROL_GRAPH_URI;

export type InventoryKind = 'vm' | 'vm-unindexed' | 'raw' | 'raw-v0';
/** `retryable` and `held` are both `failed`; they differ in whether a transaction may be unaccounted for. */
export type InventoryState = 'accepted' | 'claimed' | 'finalized' | 'retryable' | 'held';

export const INVENTORY_KINDS: readonly InventoryKind[] = ['vm', 'vm-unindexed', 'raw', 'raw-v0'];
export const INVENTORY_STATES: readonly InventoryState[] = ['accepted', 'claimed', 'finalized', 'retryable', 'held'];

const STATUS_OF: Readonly<Record<InventoryState, LiftJobState>> = {
  accepted: 'accepted', claimed: 'claimed', finalized: 'finalized', retryable: 'failed', held: 'failed',
};

export interface JobSpec {
  readonly id: string;
  readonly kind: InventoryKind;
  readonly state: InventoryState;
  readonly contextGraphId: string;
  readonly acceptedAt: number;
}

export type JobTemplates = Readonly<Record<InventoryState, PersistedLiftJob>>;

/** One job per state, made by driving a real publisher; the shape the production decoder and serializer agree on. */
export async function createJobTemplates(): Promise<JobTemplates> {
  const scratch = async (drive: (publisher: TripleStoreAsyncLiftPublisher, jobId: string) => Promise<void>): Promise<PersistedLiftJob> => {
    const publisher = new TripleStoreAsyncLiftPublisher(new OxigraphStore(), { now: () => 500, idGenerator: () => 'template' });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await drive(publisher, jobId);
    return (await publisher.getStatus(jobId))!;
  };
  const claim = async (publisher: TripleStoreAsyncLiftPublisher): Promise<void> => {
    await publisher.claimNext('wallet-1');
  };
  return {
    accepted: await scratch(async () => undefined),
    claimed: await scratch(claim),
    finalized: await scratch(async (publisher, jobId) => {
      await claim(publisher);
      await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      await publisher.update(jobId, 'finalized', { finalization: { mode: 'local' } });
    }),
    retryable: await scratch(async (publisher, jobId) => {
      await claim(publisher);
      await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      await publisher.recordPublishFailure(jobId, {
        error: new QuorumUnmetError({ collected: 2, required: 3, dialled: 2 }),
        failedFromState: 'broadcast',
        errorPayloadRef: `urn:dkg:test:error:${jobId}`,
      });
    }),
    held: await scratch(async (publisher, jobId) => {
      await claim(publisher);
      await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      await publisher.update(jobId, 'broadcast', { broadcast: KA_VM_BROADCAST_TX });
      await publisher.recordPublishFailure(jobId, {
        error: new Error('on-chain confirmation mismatch'),
        failedFromState: 'broadcast',
        errorPayloadRef: `urn:dkg:test:error:${jobId}`,
      });
    }),
  };
}

/** The job a spec stands for: the state's template, re-keyed, with the kind's request. */
export function stampJob(templates: JobTemplates, spec: JobSpec): LiftJob {
  const template = templates[spec.state];
  if (template.request.jobType !== 'knowledge-asset-vm-publish') throw new Error('template is not a publish job');
  const { subGraphName: _dropped, ...publish } = template.request.knowledgeAssetVmPublish;
  const request = spec.kind === 'vm' || spec.kind === 'vm-unindexed'
    ? { ...template.request, knowledgeAssetVmPublish: { ...publish, contextGraphId: spec.contextGraphId, name: `name-${spec.id}`, shareOperationId: `op-${spec.id}` } }
    : createRawLiftJobRequest({
      contextGraphId: spec.contextGraphId,
      swmId: `swm-${spec.id}`,
      shareOperationId: `op-${spec.id}`,
      roots: [`urn:test:root:${spec.id}`],
      namespace: 'ns',
      scope: 'root',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: `proof-${spec.id}` },
    });
  return {
    ...template,
    jobId: spec.id,
    jobSlug: spec.id,
    request,
    timestamps: { ...template.timestamps, acceptedAt: spec.acceptedAt, updatedAt: spec.acceptedAt },
    controlPlane: { jobRef: jobSubject(spec.id) },
  } as LiftJob;
}

export function jobQuads(templates: JobTemplates, spec: JobSpec, graph = GRAPH): Quad[] {
  const job = stampJob(templates, spec);
  const quads = serializeJob(job, graph, spec.kind === 'raw-v0' ? { payloadSchema: 'legacy-v0' } : {});
  return spec.kind === 'vm-unindexed' ? quads.filter((quad) => quad.predicate !== CONTROL_LIFECYCLE_KEY) : quads;
}

export async function seedJobs(store: TripleStore, templates: JobTemplates, specs: readonly JobSpec[], graph = GRAPH): Promise<void> {
  await store.createGraph(graph);
  const quads = specs.flatMap((spec) => jobQuads(templates, spec, graph));
  if (quads.length > 0) await store.insert(quads);
}

export interface JobFilter {
  readonly status?: LiftJobState;
  readonly contextGraphId?: string;
}

/**
 * Whether a job belongs to a listing, from its spec alone. A graph-scoped listing holds only publish jobs of that
 * graph, indexed or not; raw lifts are operator-only whatever graph their request names.
 */
export function expectedMembership(spec: JobSpec, filter: JobFilter): boolean {
  if (filter.status !== undefined && STATUS_OF[spec.state] !== filter.status) return false;
  if (filter.contextGraphId === undefined) return true;
  return (spec.kind === 'vm' || spec.kind === 'vm-unindexed') && spec.contextGraphId === filter.contextGraphId;
}

/** Page order: acceptedAt, then the id by code unit. */
export function expectedOrder(specs: readonly JobSpec[]): string[] {
  return [...specs]
    .sort((a, b) => a.acceptedAt - b.acceptedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((spec) => spec.id);
}

export const STATUSES: readonly (LiftJobState | undefined)[] = [undefined, 'accepted', 'claimed', 'finalized', 'failed'];

/** Walk a listing to its end, calling `between` after each page that has a successor. */
export async function walkPages(
  pager: { listPage(request?: LiftJobPageRequest): Promise<LiftJobPage> },
  request: Omit<LiftJobPageRequest, 'cursor'>,
  between: (pageIndex: number, page: LiftJobPage) => Promise<void> = async () => undefined,
): Promise<{ pages: LiftJobPage[]; ids: string[] }> {
  const pages: LiftJobPage[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await pager.listPage({ ...request, ...(cursor === undefined ? {} : { cursor }) });
    pages.push(page);
    if (page.nextCursor === null) break;
    if (pages.length > 10_000) throw new Error('the walk did not end');
    await between(pages.length - 1, page);
    cursor = page.nextCursor;
  }
  return { pages, ids: pages.flatMap((page) => page.jobs.map((job) => job.jobId)) };
}
