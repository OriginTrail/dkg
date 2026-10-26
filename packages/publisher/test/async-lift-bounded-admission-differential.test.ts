import { expect, it } from 'vitest';
import fc from 'fast-check';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { QuorumUnmetError, TripleStoreAsyncLiftPublisher } from '../src/index.js';
import type { LiftJob, PersistedLiftJob } from '../src/lift-job.js';
import type { LiftJobStoreSelectors } from '../src/lift-job-store-selectors.js';
import { decodeLiftJobPayload, decodedLiftJobOrThrow } from '../src/lift-job-payload-codec.js';
import {
  CONTROL_LIFECYCLE_KEY,
  CONTROL_PAYLOAD,
  CONTROL_STATUS,
  DEFAULT_CONTROL_GRAPH_URI,
  jobSubject,
  literal,
  serializeJob,
  serializeVmPublishIntentIndex,
} from '../src/async-lift-control-plane.js';
import {
  expectBindings,
  isKnowledgeAssetVmPublishJobRequest,
  projectListedLiftJobs,
} from '../src/async-lift-publisher-utils.js';
import {
  KA_VM_BROADCAST_TX,
  KA_VM_INCLUSION,
  KA_VM_VALIDATION,
  kaVmPublishRequest,
} from '../../../scripts/testing/ka-vm-publish.js';
import { propertyOptions } from '../../../scripts/testing/property-options.js';

// OT-RFC-73 P7 (AC4) - decision-identity differential. The publisher's bounded admission lookup and unindexed-only boot backfill
// against the code they replace, on randomised queues, through the real publisher on in-memory Oxigraph. The reference side runs the
// SAME publisher with exactly two members swapped for frozen copies of the pre-P7 code (testnet-canary@bd6ca6109): the admission
// candidate read (always the UNION with the legacy branch) and the boot backfill (full list, then a diff against the indexed subjects).
// Per case: 0-8 retained jobs (accepted, finalized, retryable failed, failed with an unaccounted transaction) over a few names and
// sub-graphs, a share of them LEGACY (no lifecycle-key triple), optionally a malformed neighbour and a legacy job whose key cannot be
// built (U+001F); then 1-5 operations: an admission (new job, same intent, different intent), the boot backfill, or a new publisher
// instance over the same store (the daemon's admission and runtime publishers). Compared: the outcome of every operation and the final
// store (job ids, statuses, which jobs carry the lifecycle-key triple). Legacy rows exist only when the process starts: one appearing
// later is the documented narrowing, pinned by the CHARACTERISATION test in async-lift-bounded-admission.test.ts, not by this file.
const GRAPH = DEFAULT_CONTROL_GRAPH_URI;
const FIND_ACTIVE = 'publisher.asyncLift.findActiveVmPublish';
const SEPARATOR = String.fromCharCode(0x1f);

type Kind = 'accepted' | 'finalized' | 'retryable' | 'held';
type Sub = string | undefined;
type Operation =
  | { readonly kind: 'admit'; readonly name: string; readonly sub: Sub; readonly intent: string }
  | { readonly kind: 'backfill' }
  | { readonly kind: 'instance' };
interface Scenario {
  readonly jobs: ReadonlyArray<{ kind: Kind; name: string; sub: Sub; intent: string; legacy: boolean }>;
  readonly malformed: boolean;
  readonly keyless: boolean;
  readonly ops: readonly Operation[];
}

const intentKey = (intent: string): string => `sha256:${intent.repeat(64).slice(0, 64)}`;

/** Frozen pre-P7 `LiftJobStoreSelectors.vmPublishAdmissionCandidates`: the oracle of the differential. */
async function baseAdmissionCandidates(
  store: OxigraphStore,
  lifecycleKey: string,
  keyOfJob: (job: PersistedLiftJob) => string | null,
): Promise<PersistedLiftJob[]> {
  const result = await store.query(
    `SELECT ?payload ?status ?indexed WHERE { GRAPH <${GRAPH}> {
        {
          ?job <${CONTROL_LIFECYCLE_KEY}> ${literal(lifecycleKey)} ; <${CONTROL_PAYLOAD}> ?payload .
          OPTIONAL { ?job <${CONTROL_STATUS}> ?status }
          BIND(true AS ?indexed)
        } UNION {
          ?job <${CONTROL_STATUS}> ?status ; <${CONTROL_PAYLOAD}> ?payload .
          FILTER NOT EXISTS { ?job <${CONTROL_LIFECYCLE_KEY}> ?lifecycleKey }
        }
      } }`,
    { source: FIND_ACTIVE },
  );
  const rows = expectBindings(result);
  const jobs = new Map<string, PersistedLiftJob>();
  for (const row of rows) {
    if (row['indexed'] === undefined) continue;
    const job = decodedLiftJobOrThrow(decodeLiftJobPayload(row['payload']));
    if (job !== null && keyOfJob(job) !== lifecycleKey) {
      throw new Error(`Malformed persisted LiftJob payload: lifecycle index does not match ${lifecycleKey}`);
    }
    if (job !== null && row['status'] !== undefined) jobs.set(job.jobId, job);
  }
  for (const row of rows) {
    if (row['indexed'] !== undefined) continue;
    const decoded = decodeLiftJobPayload(row['payload']);
    const job = decoded.kind === 'canonical' || decoded.kind === 'compatibility' ? decoded.job : null;
    if (job !== null) jobs.set(job.jobId, job);
  }
  return projectListedLiftJobs([...jobs.values()], undefined, (job) => job);
}

/** Frozen pre-P7 `ensureVmPublishIntentIndex`: list everything, read the indexed subjects, diff in JS. */
async function baseEnsureIndex(publisher: TripleStoreAsyncLiftPublisher, store: OxigraphStore): Promise<number> {
  const vmPublishJobs = (await publisher.list()).filter((job) => isKnowledgeAssetVmPublishJobRequest(job.request));
  if (vmPublishJobs.length === 0) return 0;
  const indexed = await store.query(`SELECT ?job WHERE { GRAPH <${GRAPH}> { ?job <${CONTROL_LIFECYCLE_KEY}> ?lifecycleKey } }`);
  const alreadyIndexed = new Set(expectBindings(indexed).map((row) => row['job']).filter((subject): subject is string => typeof subject === 'string'));
  const missing = vmPublishJobs.filter((job) => !alreadyIndexed.has(jobSubject(job.jobId)));
  const quads = missing.flatMap((job) => serializeVmPublishIntentIndex(job, GRAPH));
  if (quads.length > 0) await store.insert(quads);
  return missing.length;
}

const outcome = async (operation: () => Promise<unknown>): Promise<string> => {
  try {
    return `ok:${String(await operation())}`;
  } catch (error) {
    const failure = error as { name?: string; code?: string; message?: string };
    return `err:${failure.name ?? 'Error'}:${failure.code ?? ''}:${String(failure.message ?? error).slice(0, 160)}`;
  }
};

const fingerprint = async (store: OxigraphStore): Promise<string> => {
  const result = await store.query(
    `SELECT ?job ?status (EXISTS { GRAPH <${GRAPH}> { ?job <${CONTROL_LIFECYCLE_KEY}> ?key } } AS ?indexed)
     WHERE { GRAPH <${GRAPH}> { ?job <${CONTROL_STATUS}> ?status } }`,
  );
  return (result.type === 'bindings' ? result.bindings : []).map((row) => `${row['job']}|${row['status']}|${row['indexed']}`).sort().join(';');
};

const stats = { cases: 0, withLegacyRows: 0, boundedAdmissions: 0, scanningAdmissions: 0, referenceBounded: 0, admittedNew: 0, deduplicated: 0, refused: 0, backfills: 0, repaired: 0 };

it('the bounded admission lookup and the unindexed-only backfill decide exactly like the code they replace', async () => {
  const templates = {} as Record<Kind, PersistedLiftJob>;
  const scratch = async (drive: (publisher: TripleStoreAsyncLiftPublisher, jobId: string) => Promise<void>): Promise<PersistedLiftJob> => {
    const publisher = new TripleStoreAsyncLiftPublisher(new OxigraphStore(), { now: () => 500, idGenerator: () => 'template' });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await drive(publisher, jobId);
    return (await publisher.getStatus(jobId))!;
  };
  const claimAndValidate = async (publisher: TripleStoreAsyncLiftPublisher, jobId: string): Promise<void> => {
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
  };
  templates.accepted = await scratch(async () => undefined);
  templates.finalized = await scratch(async (publisher, jobId) => {
    await claimAndValidate(publisher, jobId);
    await publisher.update(jobId, 'finalized', { finalization: { mode: 'local' } });
  });
  templates.retryable = await scratch(async (publisher, jobId) => {
    await claimAndValidate(publisher, jobId);
    await publisher.recordPublishFailure(jobId, {
      error: new QuorumUnmetError({ collected: 2, required: 3, dialled: 2 }),
      failedFromState: 'broadcast',
      errorPayloadRef: `urn:dkg:test:error:${jobId}`,
    });
  });
  templates.held = await scratch(async (publisher, jobId) => {
    await claimAndValidate(publisher, jobId);
    await publisher.update(jobId, 'broadcast', { broadcast: KA_VM_BROADCAST_TX });
    await publisher.update(jobId, 'included', { broadcast: KA_VM_BROADCAST_TX, inclusion: KA_VM_INCLUSION });
    await publisher.recordPublishFailure(jobId, {
      error: new Error('on-chain confirmation mismatch'),
      failedFromState: 'included',
      errorPayloadRef: `urn:dkg:test:error:${jobId}`,
    });
  });
  expect(Object.values(templates).map((job) => job.status)).toEqual(['accepted', 'finalized', 'failed', 'failed']);

  const cloneJob = (kind: Kind, index: number, name: string, sub: Sub, intent: string): LiftJob => {
    const template = templates[kind];
    if (template.request.jobType !== 'knowledge-asset-vm-publish') throw new Error('template is not a VM publish job');
    const { subGraphName: _dropped, ...publish } = template.request.knowledgeAssetVmPublish;
    const jobId = `seed-${index}`;
    return {
      ...template, jobId, jobSlug: jobId,
      request: { ...template.request, knowledgeAssetVmPublish: { ...publish, name, ...(sub ? { subGraphName: sub } : {}), intentKey: intentKey(intent) } },
      timestamps: { ...template.timestamps, acceptedAt: 2_000 + index, updatedAt: 2_000 + index },
      controlPlane: { jobRef: jobSubject(jobId) },
    } as LiftJob;
  };

  const buildStore = async (scenario: Scenario): Promise<{ store: OxigraphStore; legacy: number }> => {
    const store = new OxigraphStore();
    const quads = scenario.jobs.flatMap((spec, index) => {
      const job = cloneJob(spec.kind, index, spec.name, spec.sub, spec.intent);
      return serializeJob(job, GRAPH).filter((quad) => !(spec.legacy && quad.predicate === CONTROL_LIFECYCLE_KEY));
    });
    if (scenario.keyless) {
      const keyless = cloneJob('accepted', 90, `bad${SEPARATOR}name`, undefined, 'x');
      quads.push(...serializeJob(keyless, GRAPH));
    }
    if (scenario.malformed) {
      quads.push(
        { subject: jobSubject('garbage'), predicate: CONTROL_PAYLOAD, object: literal('{not-json'), graph: GRAPH },
        { subject: jobSubject('garbage'), predicate: CONTROL_STATUS, object: literal('accepted'), graph: GRAPH },
      );
    }
    if (quads.length > 0) await store.insert(quads);
    return { store, legacy: scenario.jobs.filter((spec) => spec.legacy).length + (scenario.keyless ? 1 : 0) };
  };

  const run = async (scenario: Scenario, reference: boolean) => {
    const { store, legacy } = await buildStore(scenario);
    const scans: boolean[] = [];
    const query = store.query.bind(store);
    store.query = (async (sparql: string, options?: { source?: string }) => {
      if (options?.source === FIND_ACTIVE) scans.push(/UNION/.test(sparql));
      return query(sparql, options as never);
    }) as typeof store.query;
    let tick = 0;
    let sequence = 0;
    const instance = (): TripleStoreAsyncLiftPublisher => {
      const publisher = new TripleStoreAsyncLiftPublisher(store, { now: () => 10_000 + ++tick, idGenerator: () => `det-${++sequence}` });
      if (reference) {
        const swapped = publisher as unknown as {
          jobSelectors: { vmPublishAdmissionCandidates: LiftJobStoreSelectors['vmPublishAdmissionCandidates'] };
          ensureVmPublishIntentIndex: () => Promise<number>;
        };
        swapped.jobSelectors.vmPublishAdmissionCandidates = (key, keyOfJob) => baseAdmissionCandidates(store, key, keyOfJob);
        swapped.ensureVmPublishIntentIndex = () => baseEnsureIndex(publisher, store);
      }
      return publisher;
    };
    let publisher = instance();
    const outcomes: string[] = [];
    for (const [step, op] of scenario.ops.entries()) {
      if (op.kind === 'instance') {
        publisher = instance();
        outcomes.push('instance');
      } else if (op.kind === 'backfill') {
        outcomes.push(await outcome(() => publisher.ensureVmPublishIntentIndex()));
      } else {
        const request = kaVmPublishRequest({
          name: op.name, ...(op.sub ? { subGraphName: op.sub } : {}), intentKey: intentKey(op.intent), shareOperationId: `share-${step}`,
        });
        outcomes.push(await outcome(() => publisher.enqueueKnowledgeAssetVmPublish(request)));
      }
    }
    return { outcomes, scans, legacy, state: await fingerprint(store) };
  };

  const options = propertyOptions();
  const kinds = fc.constantFrom<Kind>('accepted', 'finalized', 'finalized', 'retryable', 'held');
  const names = fc.constantFrom('a', 'b', 'c');
  const subs = fc.constantFrom<Sub>(undefined, undefined, 'sg');
  const operations = fc.oneof(
    { weight: 6, arbitrary: fc.record({ kind: fc.constant('admit' as const), name: names, sub: subs, intent: fc.constantFrom('x', 'y', 'z') }) },
    { weight: 1, arbitrary: fc.constant({ kind: 'backfill' as const }) },
    { weight: 1, arbitrary: fc.constant({ kind: 'instance' as const }) },
  );
  const scenarios = fc.record({
    jobs: fc.array(
      fc.record({ kind: kinds, name: names, sub: subs, intent: fc.constantFrom('x', 'y'), legacy: fc.integer({ min: 0, max: 99 }).map((n) => n < 35) }),
      { maxLength: 8 },
    ),
    malformed: fc.boolean(),
    keyless: fc.boolean(),
    ops: fc.array(operations, { minLength: 1, maxLength: 5 }),
  });

  await fc.assert(fc.asyncProperty(scenarios, async (scenario) => {
    const candidate = await run(scenario, false);
    const reference = await run(scenario, true);
    expect(candidate.outcomes).toEqual(reference.outcomes);
    expect(candidate.state).toEqual(reference.state);
    expect(reference.scans.every(Boolean)).toBe(true);                       // the oracle never took the bounded form
    // The memo only ever clears: the first admission of a process scans, and no admission scans after one that did not.
    if (candidate.scans.length > 0) expect(candidate.scans[0]).toBe(true);
    expect(candidate.scans.every((scan, index) => scan || candidate.scans.slice(index).every((later) => !later))).toBe(true);
    stats.cases += 1;
    if (candidate.legacy > 0) stats.withLegacyRows += 1;
    stats.boundedAdmissions += candidate.scans.filter((scan) => !scan).length;
    stats.scanningAdmissions += candidate.scans.filter(Boolean).length;
    stats.referenceBounded += reference.scans.filter((scan) => !scan).length;
    for (const [index, result] of candidate.outcomes.entries()) {
      const op = scenario.ops[index]!;
      if (op.kind === 'admit') {
        if (result.startsWith('err:')) stats.refused += 1;
        else if (result.startsWith('ok:det-')) stats.admittedNew += 1;
        else stats.deduplicated += 1;
      } else if (op.kind === 'backfill') {
        stats.backfills += 1;
        if (result !== 'ok:0') stats.repaired += 1;
      }
    }
  }), options);

  // Positive controls: the differential exercised what it claims to compare.
  expect(stats.cases).toBe(options.numRuns);
  expect(stats.withLegacyRows).toBeGreaterThan(0);        // queues holding legacy rows, where the scan must keep running
  expect(stats.boundedAdmissions).toBeGreaterThan(0);     // admissions that took the bounded form
  expect(stats.scanningAdmissions).toBeGreaterThan(0);    // admissions that still scanned
  expect(stats.referenceBounded).toBe(0);
  expect(stats.admittedNew).toBeGreaterThan(0);
  expect(stats.deduplicated).toBeGreaterThan(0);
  expect(stats.refused).toBeGreaterThan(0);               // conflicts and held-job refusals, compared by error text
  expect(stats.repaired).toBeGreaterThan(0);              // backfills that indexed something
}, 300_000);
