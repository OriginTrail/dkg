import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher, type AsyncLiftPublisherConfig } from '../src/index.js';
import { DEFAULT_CONTROL_GRAPH_URI, jobSubject, serializeJob } from '../src/async-lift-control-plane.js';
import {
  KA_VM_BROADCAST_TX,
  KA_VM_INCLUSION,
  KA_VM_VALIDATION,
  kaVmPublishRequest,
} from './_helpers/ka-vm-publish.js';

// #1837 — atomic by-exact-jobId TERMINAL clear for the async publisher (lift) queue.
describe('#1837 lift publisher clearTerminalJob', () => {
  let now = 1_000;
  let ids = 0;
  let store: OxigraphStore;

  beforeEach(() => {
    now = 1_000;
    ids = 0;
    store = new OxigraphStore();
  });

  function createPublisher(config: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator'> = {}): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++now,
      idGenerator: () => `job-${++ids}`,
      journalWrites: true,
      ...config,
    });
  }

  const bx = KA_VM_BROADCAST_TX;
  const inc = KA_VM_INCLUSION;

  async function driveToValidated(
    p: TripleStoreAsyncLiftPublisher,
    o: Partial<Parameters<typeof kaVmPublishRequest>[0]> = {},
    admission?: { admittedByAgentAddress?: string },
  ): Promise<string> {
    const jobId = await p.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest(o), admission);
    await p.claimNext('wallet-1');
    await p.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    return jobId;
  }
  async function driveToFinalized(
    p: TripleStoreAsyncLiftPublisher,
    o: Partial<Parameters<typeof kaVmPublishRequest>[0]> = {},
    admission?: { admittedByAgentAddress?: string },
  ): Promise<string> {
    const jobId = await driveToValidated(p, o, admission);
    await p.update(jobId, 'broadcast', { broadcast: bx });
    await p.update(jobId, 'included', { broadcast: bx, inclusion: inc });
    await p.update(jobId, 'finalized', { broadcast: bx, inclusion: inc, finalization: { mode: 'local' } });
    return jobId;
  }
  // Terminal, non-retryable (tx_reverted → fail_job): clearable, retry() won't touch it.
  async function driveToTerminalFailed(
    p: TripleStoreAsyncLiftPublisher,
    o: Partial<Parameters<typeof kaVmPublishRequest>[0]> = {},
    admission?: { admittedByAgentAddress?: string },
  ): Promise<string> {
    const jobId = await driveToValidated(p, o, admission);
    await p.update(jobId, 'broadcast', { broadcast: bx });
    await p.recordPublishFailure(jobId, { error: new Error('tx reverted on chain'), failedFromState: 'broadcast', errorPayloadRef: 'urn:err:1' });
    return jobId;
  }
  it('clears an exact finalized job (cleared); no other job changes', async () => {
    const p = createPublisher();
    const target = await driveToFinalized(p, { name: 'a' });
    const other = await driveToFinalized(p, { name: 'b' });
    expect(await p.clearTerminalJob(target)).toEqual({ outcome: 'cleared' });
    expect(await p.getStatus(target)).toBeNull();
    expect((await p.getStatus(other))?.status).toBe('finalized'); // untouched
  });

  it('clears an exact terminal (non-retryable) failed job', async () => {
    const p = createPublisher();
    const jobId = await driveToTerminalFailed(p);
    expect((await p.getStatus(jobId))?.status).toBe('failed');
    expect(await p.clearTerminalJob(jobId)).toEqual({ outcome: 'cleared' });
    expect(await p.getStatus(jobId)).toBeNull();
  });

  it('rejects an accepted (queued) job as nonterminal without mutation', async () => {
    const p = createPublisher();
    const accepted = await p.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    expect(await p.clearTerminalJob(accepted)).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await p.getStatus(accepted))?.status).toBe('accepted');
  });

  it('rejects a validated job as nonterminal without mutation', async () => {
    const p = createPublisher();
    const validated = await driveToValidated(p);
    expect(await p.clearTerminalJob(validated)).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await p.getStatus(validated))?.status).toBe('validated');
  });

  it('lets only the admission owner explicitly clear one pre-broadcast validated job', async () => {
    const OWNER = '0xCCcCCc00000000000000000000000000000000Cc';
    const OTHER = '0xBBbBBb00000000000000000000000000000000Bb';
    const p = createPublisher();
    const validated = await driveToValidated(p, {}, { admittedByAgentAddress: OWNER });

    expect(await p.clearTerminalJob(validated, {
      pendingTransactionOverride: { requestedBy: OTHER },
    })).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await p.getStatus(validated))?.status).toBe('validated');

    expect(await p.clearTerminalJob(validated, {
      pendingTransactionOverride: { requestedBy: OWNER },
    })).toEqual({ outcome: 'cleared' });
    expect(await p.getStatus(validated)).toBeNull();
  });

  it('rejects a broadcast job as nonterminal without mutation', async () => {
    const p = createPublisher();
    const broadcast = await driveToValidated(p);
    await p.update(broadcast, 'broadcast', { broadcast: bx });
    expect(await p.clearTerminalJob(broadcast)).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await p.getStatus(broadcast))?.status).toBe('broadcast');
  });

  it('lets only the admission owner explicitly clear one broadcast job', async () => {
    const OWNER = '0xCCcCCc00000000000000000000000000000000Cc';
    const OTHER = '0xBBbBBb00000000000000000000000000000000Bb';
    const p = createPublisher();
    const broadcast = await driveToValidated(p, {}, { admittedByAgentAddress: OWNER });
    await p.update(broadcast, 'broadcast', { broadcast: bx });

    expect(await p.clearTerminalJob(broadcast, {
      pendingTransactionOverride: { requestedBy: OTHER },
    })).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await p.getStatus(broadcast))?.status).toBe('broadcast');

    expect(await p.clearTerminalJob(broadcast, {
      pendingTransactionOverride: { requestedBy: OWNER },
    })).toEqual({ outcome: 'cleared' });
    expect(await p.getStatus(broadcast)).toBeNull();
  });

  it('CLEARS a retry_recovery failed job by id — the targeted override is the operator exit', async () => {
    // GH#2270 follow-up (🔴 3822987650) — this row previously asserted the opposite, because the
    // by-id clear shared the BULK predicate, which treats a retry_recovery failure as
    // nonterminal-for-cleanup (a pending tx may still land — right for bulk).
    //
    // The chain-proof work made that wrong for the targeted lane: a held UPDATE has no
    // absence-release path by design, so the by-id clear is its STATED exit, and sharing the bulk
    // rule meant neither lane could remove it — a permanent dead end, and the release notes named
    // a command that could not work. The operator names the exact job here and owns the
    // consequence; bulk keeps the stricter rule, pinned by the row below.
    // 🔴 3824353569 — the ENQUEUING CALLER owns the override, not the resolved author. Curated
    // publishing lets those differ (GH#1778), so the fixture makes them differ: the curator who
    // admitted the job may clear it; an authenticated token for the AUTHOR may not.
    // 🔴 3825861808 — THREE distinct identities. The previous fixture gave the payload caller
    // and the admission owner the same address, so a regression that authorized from
    // `callerAgentAddress` would have stayed green on a destructive cross-agent clear.
    const OWNER = '0xCCcCCc00000000000000000000000000000000Cc';   // the admission stamp
    const PAYLOAD_CALLER = '0xDDdDDd00000000000000000000000000000000Dd'; // GH#1778 hint only
    const AUTHOR = '0xAAaAAa00000000000000000000000000000000Aa';   // resolved author
    const p = createPublisher();
    // The curator's `callerAgentAddress` stays in the request (it is the GH#1778 author-resolution
    // hint), but the ENTITLEMENT comes only from the explicit admission stamp (3825162149) — the
    // payload hint grants nothing on its own, which is what stops an agent's own publish path
    // from handing the override to a third-party author.
    const jobId = await driveToTerminalFailed(p, {
      agentAddress: AUTHOR,
      callerAgentAddress: PAYLOAD_CALLER,
    }, { admittedByAgentAddress: OWNER });
    const job = await p.getStatus(jobId);
    if (!job || !('failure' in job)) throw new Error('expected a failed job');
    const mutated = { ...job, failure: { ...job.failure, resolution: 'retry_recovery' } };
    await store.deleteByPattern({ subject: jobSubject(jobId), graph: DEFAULT_CONTROL_GRAPH_URI });
    await store.insert(serializeJob(mutated as typeof job, DEFAULT_CONTROL_GRAPH_URI));
    // 🔴 3823952704 — and it is an EXPLICIT override, off by default. This route is open to
    // every registered agent token, so a default-on widening would have let one agent delete
    // another lifecycle's only chain-recovery record.
    expect(await p.clearTerminalJob(jobId)).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await p.getStatus(jobId))?.status).toBe('failed');

    // 🔴 3824098476 / 🟡 3824098494 — ownership is decided HERE, under the same lock and
    // after the same safe-id validation as the delete, on the same record. A caller that does not
    // own the job gets no override however explicitly it asks.
    // The AUTHOR is not the enqueuer, so the author's token gets nothing — this is the exact
    // confusion the previous version had backwards.
    expect(await p.clearTerminalJob(jobId, {
      pendingTransactionOverride: { requestedBy: AUTHOR },
    })).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await p.getStatus(jobId))?.status).toBe('failed');

    // The row that was missing: the PAYLOAD caller is not the owner either. Admission is the
    // sole entitlement, so the GH#1778 hint sitting in the request grants nothing — this is
    // what fails if ownership ever falls back to reading the payload.
    expect(await p.clearTerminalJob(jobId, {
      pendingTransactionOverride: { requestedBy: PAYLOAD_CALLER },
    })).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await p.getStatus(jobId))?.status).toBe('failed');

    expect(await p.clearTerminalJob(jobId, {
      pendingTransactionOverride: { requestedBy: OWNER },
    })).toEqual({ outcome: 'cleared' });
    expect(await p.getStatus(jobId)).toBeNull();
  });

  it('a NODE-TOKEN job can be force-cleared by that node token [followup]', async () => {
    // 🔴 3824484639 — a node-level API token is the ordinary client, and it resolves to no
    // `callerAgentAddress` at all: that field is an author RESOLUTION HINT and is deliberately
    // absent for node tokens. Authorizing on it therefore denied the force-clear to the most
    // common caller, reproducing the exact dead end this PR set out to remove — the daemon handed
    // back a command that could never work.
    //
    // Job-level admission metadata records the authenticated enqueuer instead, for every
    // admission, and carries no author-selection meaning.
    const NODE = '0xNNnNNn00000000000000000000000000000000Nn';
    const OTHER = '0xBBbBBb00000000000000000000000000000000Bb';
    const p = createPublisher();
    // No callerAgentAddress in the REQUEST: the node-token shape. The principal travels
    // beside it, as admission metadata.
    const jobId = await driveToTerminalFailed(p, {}, { admittedByAgentAddress: NODE });
    const job = await p.getStatus(jobId);
    if (!job || !('failure' in job)) throw new Error('expected a failed job');
    const mutated = { ...job, failure: { ...job.failure, resolution: 'retry_recovery' } };
    await store.deleteByPattern({ subject: jobSubject(jobId), graph: DEFAULT_CONTROL_GRAPH_URI });
    await store.insert(serializeJob(mutated as typeof job, DEFAULT_CONTROL_GRAPH_URI));

    // An unrelated token is still refused...
    expect(await p.clearTerminalJob(jobId, {
      pendingTransactionOverride: { requestedBy: OTHER },
    })).toEqual({ outcome: 'rejected', reason: 'nonterminal' });

    // ...and the token that admitted it can clear it, which is what the daemon advertises.
    expect(await p.clearTerminalJob(jobId, {
      pendingTransactionOverride: { requestedBy: NODE },
    })).toEqual({ outcome: 'cleared' });
  });

  it('an UNOWNED job grants the override to nobody, including its payload caller [3825861808]', async () => {
    // Fail-closed half. A record with no admission stamp (one admitted before ownership existed,
    // or by a path that never stamped) has nobody to match. If ownership ever fell back to the
    // payload's `callerAgentAddress`, this is the row that catches it: that identity is present,
    // and it must still be refused.
    const PAYLOAD_CALLER = '0xDDdDDd00000000000000000000000000000000Dd';
    const p = createPublisher();
    const jobId = await driveToTerminalFailed(p, { callerAgentAddress: PAYLOAD_CALLER });
    const job = await p.getStatus(jobId);
    if (!job || !('failure' in job)) throw new Error('expected a failed job');
    expect(job.admission).toBeUndefined();
    const mutated = { ...job, failure: { ...job.failure, resolution: 'retry_recovery' } };
    await store.deleteByPattern({ subject: jobSubject(jobId), graph: DEFAULT_CONTROL_GRAPH_URI });
    await store.insert(serializeJob(mutated as typeof job, DEFAULT_CONTROL_GRAPH_URI));

    expect(await p.clearTerminalJob(jobId, {
      pendingTransactionOverride: { requestedBy: PAYLOAD_CALLER },
    })).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
    expect((await p.getStatus(jobId))?.status).toBe('failed');
  });

  it('refuses to REASSIGN the admission owner through a transition [3825861806]', async () => {
    // 🔴 3825861806 — `LIFT_JOB_IMMUTABLE_FIELDS` declared admission immutable; nothing enforced it,
    // and the transition merge spread the caller's patch straight over the record. Moving the owner
    // moves the right to run the destructive clear, so this is an authorization boundary, not a
    // data-integrity nicety.
    const OWNER = '0xCCcCCc00000000000000000000000000000000Cc';
    const ATTACKER = '0xEEeEEe00000000000000000000000000000000Ee';
    const p = createPublisher();
    const jobId = await driveToValidated(p, {}, { admittedByAgentAddress: OWNER });

    await expect(p.update(jobId, 'broadcast', {
      broadcast: bx,
      admission: { byAgentAddress: ATTACKER },
    } as never)).rejects.toThrow(/admission is immutable/);

    // The owner is unchanged on the persisted record, so the entitlement did not move.
    expect((await p.getStatus(jobId))?.admission).toEqual({ byAgentAddress: OWNER });
    // Re-stating the SAME owner is not a change and must still be allowed.
    await p.update(jobId, 'broadcast', { broadcast: bx, admission: { byAgentAddress: OWNER } } as never);
    expect((await p.getStatus(jobId))?.admission).toEqual({ byAgentAddress: OWNER });
  });

  it('refuses an explicit `undefined` for an immutable field, which would ERASE it', async () => {
    // The merge spreads the patch, so an explicit `undefined` overwrites rather than being skipped.
    // Treating it as "nothing supplied" let a transition delete the owner outright — worse than
    // reassigning it, because the job is then held with nobody able to clear it at all.
    const OWNER = '0xCCcCCc00000000000000000000000000000000Cc';
    const p = createPublisher();
    const jobId = await driveToValidated(p, {}, { admittedByAgentAddress: OWNER });
    const before = await p.getStatus(jobId);

    await expect(p.update(jobId, 'broadcast', {
      broadcast: bx,
      admission: undefined,
    } as never)).rejects.toThrow(/admission is immutable/);

    await expect(p.update(jobId, 'broadcast', {
      broadcast: bx,
      timestamps: { acceptedAt: undefined },
    } as never)).rejects.toThrow(/timestamps.acceptedAt is immutable/);

    await expect(p.update(jobId, 'broadcast', {
      broadcast: bx,
      retries: { maxRetries: undefined },
    } as never)).rejects.toThrow(/retries.maxRetries is immutable/);

    // Nothing was persisted by any of the three refusals.
    const after = await p.getStatus(jobId);
    expect(after?.admission).toEqual({ byAgentAddress: OWNER });
    expect(after?.status).toBe(before?.status);
    expect(after?.timestamps.acceptedAt).toBe(before?.timestamps.acceptedAt);
    expect(after?.retries.maxRetries).toBe(before?.retries.maxRetries);

    // 3828732842 — a PARTIAL nested patch. `retries` is replaced wholesale by the merge (unlike
    // `timestamps`, which is deep-merged), so omitting `maxRetries` erased the budget while a
    // presence-based guard saw "key not mentioned, nothing changed".
    await expect(p.update(jobId, 'broadcast', {
      broadcast: bx,
      retries: { retryCount: 3 },
    } as never)).rejects.toThrow(/retries.maxRetries is immutable/);

    // 3828701108 — erasing the PARENT object takes the immutable child with it.
    await expect(p.update(jobId, 'broadcast', {
      broadcast: bx,
      retries: undefined,
    } as never)).rejects.toThrow(/retries.maxRetries is immutable/);
    // ...but NOT for `timestamps`, and the asymmetry is real rather than an oversight: the merge
    // coalesces `data.timestamps ?? {}`, so an undefined parent there preserves the children. The
    // guard reads the merge's output, so it agrees with whatever the merge actually does instead
    // of asserting a rule the merge does not follow.
    await p.update(jobId, 'broadcast', { broadcast: bx, timestamps: undefined } as never);
    expect((await p.getStatus(jobId))?.timestamps.acceptedAt).toBe(before?.timestamps.acceptedAt);

    // Nested VALUE changes, not just erasures — and the sibling in the same object must still
    // be writable, which is what separates "reject this key" from "reject this object".
    await expect(p.update(jobId, 'broadcast', {
      broadcast: bx,
      retries: { retryCount: 0, maxRetries: 999 },
    } as never)).rejects.toThrow(/retries.maxRetries is immutable/);
    await expect(p.update(jobId, 'broadcast', {
      broadcast: bx,
      timestamps: { acceptedAt: 1 },
    } as never)).rejects.toThrow(/timestamps.acceptedAt is immutable/);
    // The mutable sibling goes through, with the immutable one untouched.
    await p.update(jobId, 'broadcast', {
      broadcast: bx,
      retries: { retryCount: 3, maxRetries: before!.retries.maxRetries },
    } as never);
    expect((await p.getStatus(jobId))?.retries).toMatchObject({
      retryCount: 3,
      maxRetries: before?.retries.maxRetries,
    });

    // An ordinary timestamps patch that never mentions `acceptedAt` is still allowed.
    await p.update(jobId, 'broadcast', { broadcast: bx, timestamps: { updatedAt: 12_345 } } as never);
    expect((await p.getStatus(jobId))?.timestamps.acceptedAt).toBe(before?.timestamps.acceptedAt);
  });

  it('but BULK clear still leaves a retry_recovery failed job alone', async () => {
    // The discriminating half: the fix must move only the targeted lane. If both lanes had been
    // relaxed, routine cleanup could delete a job whose transaction may still land.
    const p = createPublisher();
    const jobId = await driveToTerminalFailed(p);
    const job = await p.getStatus(jobId);
    if (!job || !('failure' in job)) throw new Error('expected a failed job');
    const mutated = { ...job, failure: { ...job.failure, resolution: 'retry_recovery' } };
    await store.deleteByPattern({ subject: jobSubject(jobId), graph: DEFAULT_CONTROL_GRAPH_URI });
    await store.insert(serializeJob(mutated as typeof job, DEFAULT_CONTROL_GRAPH_URI));

    await p.clear('failed');

    expect((await p.getStatus(jobId))?.status).toBe('failed');
  });

  it('is idempotent: absent / already-cleared → already_absent', async () => {
    const p = createPublisher();
    expect(await p.clearTerminalJob('never-existed')).toEqual({ outcome: 'already_absent' });
    const jobId = await driveToFinalized(p);
    expect(await p.clearTerminalJob(jobId)).toEqual({ outcome: 'cleared' });
    expect(await p.clearTerminalJob(jobId)).toEqual({ outcome: 'already_absent' });
  });

  it('rejects an empty or SPARQL-unsafe jobId as malformed without querying/mutating', async () => {
    const p = createPublisher();
    expect(await p.clearTerminalJob('')).toEqual({ outcome: 'rejected', reason: 'malformed' });
    expect(await p.clearTerminalJob('  ')).toEqual({ outcome: 'rejected', reason: 'malformed' });
    // #1883 review (🔴): a jobId that would break out of the <…> SPARQL IRI must be a
    // bounded malformed reject, never a query error / injection.
    expect(await p.clearTerminalJob('bad id')).toEqual({ outcome: 'rejected', reason: 'malformed' });
    expect(await p.clearTerminalJob('bad>id')).toEqual({ outcome: 'rejected', reason: 'malformed' });
    expect(await p.clearTerminalJob('a{ b')).toEqual({ outcome: 'rejected', reason: 'malformed' });
  });

  it('preserves the #1829 journal: clearing a terminal job leaves its journal lineage readable', async () => {
    const p = createPublisher();
    const jobId = await driveToFinalized(p);
    expect((await p.readJournalByJob(jobId)).entries.length).toBeGreaterThan(0);
    expect(await p.clearTerminalJob(jobId)).toEqual({ outcome: 'cleared' });
    expect(await p.getStatus(jobId)).toBeNull(); // gone from control plane
    const journal = await p.readJournalByJob(jobId);
    expect(journal.entries.length).toBeGreaterThan(0); // lineage survives the clear
    expect(journal.entries.some((e) => e.kind === 'finalized')).toBe(true);
  });

  it('no-sweep: a clearable-failed job reaccepted by concurrent retry() is never deleted while active', async () => {
    // maxRetries:1 + a retryable failure (rpc_unavailable/reset_to_accepted) → the job is
    // BOTH clearable (terminal failed, not retry_recovery) AND reacceptable by retry().
    // clearTerminalJob and retry() both run under withClaimLock, so they serialize:
    // whichever wins, an ACTIVE job is never swept.
    //
    // GH#2270 — the job must carry NO transaction hash for the race to exist at all: with
    // broadcast metadata persisted, retry() refuses it pending chain proof, clear always wins,
    // and the second branch below silently stops being reachable. The failure is therefore
    // recorded from 'validated' (no `bx` write-ahead), which is exactly the rpc_unavailable
    // shape where the transaction was never signed.
    const p = createPublisher({ maxRetries: 1 });
    const jobId = await driveToValidated(p, { name: 'race' });
    await p.recordPublishFailure(jobId, { error: new Error('rpc temporarily down'), failedFromState: 'broadcast', errorPayloadRef: 'urn:err:2' });
    const failed = await p.getStatus(jobId);
    expect(failed?.status).toBe('failed');
    expect(failed && 'failure' in failed && failed.failure.retryable).toBe(true);

    const [clearOutcome, retried] = await Promise.all([p.clearTerminalJob(jobId), p.retry({ status: 'failed' })]);
    const after = await p.getStatus(jobId);
    if (clearOutcome.outcome === 'cleared') {
      // clear won: job gone, retry could not have reaccepted it.
      expect(after).toBeNull();
      expect(retried).toBe(0);
    } else {
      // retry won: job is active ('accepted'); clear must have rejected it, NOT deleted it.
      expect(clearOutcome).toEqual({ outcome: 'rejected', reason: 'nonterminal' });
      expect(after?.status).toBe('accepted');
      expect(retried).toBe(1);
    }
  });

  it('concurrent clears of one terminal job are deterministic: one cleared, rest already_absent', async () => {
    const p = createPublisher();
    const target = await driveToFinalized(p, { name: 'a' });
    const other = await driveToFinalized(p, { name: 'b' });
    const results = await Promise.all([p.clearTerminalJob(target), p.clearTerminalJob(target), p.clearTerminalJob(target)]);
    expect(results.filter((r) => r.outcome === 'cleared')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'already_absent')).toHaveLength(2);
    expect((await p.getStatus(other))?.status).toBe('finalized'); // never affected
  });
});
