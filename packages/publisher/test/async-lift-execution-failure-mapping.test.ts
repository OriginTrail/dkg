/**
 * GH#2945 / #2943 item 1 - characterization of the decision `recordExecutionFailure` makes.
 *
 * `recordExecutionFailure` chooses the failed-from state, the failure code, the message and the
 * timeout metadata of every job that fails while a publish is being executed, on the double-publish safety
 * lane (#2940 / #2942): a typed pre-send failure is recorded from 'validated' and retried as the SAME job; a
 * failure that may have left a transaction on the wire stays a held broadcast failure. This table pins the
 * current answer for each shape, driven through the real publisher at each persisted status, so the decision
 * can be extracted into a pure function without anyone having to re-derive what the old nested branches did.
 *
 * Quirks pinned as CURRENT behaviour, not endorsed: the legacy claimed/validated path reads
 * `String(error)` (a non-Error throw with a `.message` classifies as '[object Object]'); a hostile throw
 * rejects with nothing recorded; an invalid (code, origin) pair rejects with nothing recorded.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { RpcEndpointsExhaustedError, hostOnlyRpcText } from '@origintrail-official/dkg-chain';
import { StoreOperationTimeoutError } from '@origintrail-official/dkg-storage';
import { PUBLISH_AUTHOR_NOT_CUSTODIAL_CODE, formatPublishAuthorNotCustodialMessage } from '@origintrail-official/dkg-core';
import {
  RpcPreconditionError,
  getLiftJobFailurePolicy,
  type ActiveLiftJobClaim,
  type ExecutionFailureEvidence,
  type LiftJobFailureCode,
  type LiftJobState,
} from '../src/index.js';
import { isKnowledgeAssetPublishPreconditionFailure, mapExecutionFailure } from '../src/async-lift-execution-failure.js';
import {
  TX_HASH,
  corruptHeadError,
  createAsyncLift2270Harness,
  expectFailed,
} from './_helpers/async-lift-2270-harness.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { RETRY_LANE, adapterRewrap, createStoreRejectionFixtures, legacyAdapterRewrap, schedulerBusy } from './_helpers/store-rejection-2940.js';
import {
  KEYED_RPC_URL,
  boundedRequestTimeout,
  broadcastExhausted,
  exhaustedWithoutKeywords,
  governorQueueFull,
  keyedExhaustedWithoutKeywords,
  preparationExhausted,
  receiptLookupFailed,
  receiptWaitTimeout,
} from './_helpers/rpc-prep-failure-2942.js';

type PersistedStatus = 'claimed' | 'validated' | 'broadcast';

interface MappingRow {
  readonly name: string;
  /** The job's PERSISTED status when the failure is recorded (read under the transition lock). */
  readonly persisted: PersistedStatus;
  /** The origin the caller reports. */
  readonly requested: LiftJobState;
  readonly error: () => unknown;
  readonly evidence?: ExecutionFailureEvidence;
  readonly expected:
    | {
        readonly origin: LiftJobState;
        readonly code: LiftJobFailureCode;
        /** Timeout metadata is present (the `timeoutMs: 0` placeholder, stamped by the clock). */
        readonly timeout?: true;
        /** Exact persisted message; defaults to the thrown message, host-reduced. */
        readonly message?: string;
      }
    | { readonly rejects: RegExp };
}

const PROVEN = { neverDispatched: true } as const;
const MAYBE_SENT = { neverDispatched: false } as const;

const typedStoreNotStarted = () => new StoreOperationTimeoutError({
  backend: 'managed-oxigraph',
  operation: 'construct',
  outcome: 'not_started',
  message: 'Managed Oxigraph is recovering; construct was not started',
});
const indeterminateStoreTimeout = () => new StoreOperationTimeoutError({
  backend: 'managed-oxigraph', operation: 'query', outcome: 'indeterminate',
});
const plainTypedNotStarted = () => ({ code: 'STORE_OPERATION_TIMEOUT', outcome: 'not_started' });
const precondition = (cause: unknown) => new RpcPreconditionError({
  method: 'getEvmChainId', message: 'chain id read failed', url: KEYED_RPC_URL, cause,
});
const withCode = (message: string, fields: Record<string, unknown>) => Object.assign(new Error(message), fields);
const authorityUnavailable = (reason?: string) => withCode('registered-CG authority gate refused', {
  code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE', ...(reason === undefined ? {} : { reason }),
});
const txHashBearingKeywordless = () => new RpcEndpointsExhaustedError(
  'publish transaction preparation failed on all configured RPC endpoints: 429 Too Many Requests',
  { rpcUrls: [], txHash: TX_HASH },
);
const nullPrototypeThrow = () => Object.create(null);

const to = (origin: LiftJobState, code: LiftJobFailureCode, extra: { timeout?: true; message?: string } = {}) =>
  ({ origin, code, ...extra }) as const;
const preSend = to('validated', 'workspace_unavailable');
const row = (
  name: string,
  persisted: PersistedStatus,
  requested: LiftJobState,
  error: () => unknown,
  expected: MappingRow['expected'],
  evidence?: ExecutionFailureEvidence,
): MappingRow => ({ name, persisted, requested, error, expected, evidence });

const DRAFT_PRECONDITIONS = [
  ['ROOTLESS_UPDATE_TARGET_NOT_CONFIRMED', 'workspace_slice_not_found'],
  ['ROOTLESS_KA_NOT_MATERIALIZED', 'workspace_slice_not_found'],
  ['ROOTLESS_UPDATE_TARGET_CORRUPT', 'canonicalization_failed'],
  ['ROOTLESS_UPDATE_INVALID_KA_ID', 'canonicalization_failed'],
  ['KA_UPDATE_AUTHOR_NOT_OWNER', 'authority_forbidden'],
  ['LEGACY_KA_READ_ONLY', 'canonicalization_failed'],
  ['KA_UPDATE_VERSION_MISMATCH', 'publish_intent_stale'],
] as const;

const MAPPING_ROWS: readonly MappingRow[] = [
  ...DRAFT_PRECONDITIONS.map(([code, mapped]) => row(code, 'validated', 'validated',
    () => withCode('deterministic refusal', { code }), to('validated', mapped))),
  row('a deterministic code cannot discard persisted transaction evidence', 'broadcast', 'validated',
    () => withCode('deterministic refusal', { code: 'ROOTLESS_KA_NOT_MATERIALIZED' }), to('broadcast', 'rpc_unavailable')),
  // --- A. a failure while the job is still 'claimed' (the preflight / validation call sites) ---------
  row('A typed transient failure with no keyword is recorded retryable (the C conjunct)', 'claimed', 'claimed',
    keyedExhaustedWithoutKeywords, to('claimed', 'workspace_unavailable')),
  row('a transient failure naming a transaction is NOT typed-transient: keyword-less -> terminal', 'claimed', 'claimed',
    txHashBearingKeywordless, to('claimed', 'canonicalization_failed')),
  row('a transient failure naming a transaction still matches the keyword chain', 'claimed', 'claimed',
    () => broadcastExhausted(TX_HASH), to('claimed', 'workspace_unavailable')),
  row('the ACK-precondition wrapper is unwrapped exactly one level', 'claimed', 'claimed',
    () => precondition(exhaustedWithoutKeywords()), to('claimed', 'workspace_unavailable')),
  row('two wrappers are not unwrapped', 'claimed', 'claimed',
    () => precondition(precondition(exhaustedWithoutKeywords())), to('claimed', 'canonicalization_failed')),
  row('only the ACK-precondition wrapper is unwrapped, not an arbitrary cause', 'claimed', 'claimed',
    () => new Error('wrapped', { cause: exhaustedWithoutKeywords() }), to('claimed', 'canonicalization_failed')),
  row('a claimed origin on a validated record is not the C lane (persisted status decides)', 'validated', 'claimed',
    exhaustedWithoutKeywords, to('claimed', 'canonicalization_failed')),
  row('at claimed a typed store rejection is classified by its words (no proof exists yet)', 'claimed', 'claimed',
    () => schedulerBusy(), to('claimed', 'workspace_unavailable')),
  row('at claimed a typed not_started with no keyword is classified by its words only', 'claimed', 'claimed',
    typedStoreNotStarted, to('claimed', 'canonicalization_failed')),

  // --- B. the keyword chain (legacy claimed/validated path): one row per keyword, then precedence ------
  ...([
    ['timeout', 'request timeout while reading', 'workspace_unavailable'],
    ['timed out', 'the read timed out', 'workspace_unavailable'],
    ['unavailable', 'resolver unavailable', 'workspace_unavailable'],
    ['query', 'bad query', 'workspace_unavailable'],
    ['store', 'store is busy', 'workspace_unavailable'],
    ['authority', 'authority denied', 'authority_forbidden'],
    ['workspace', 'workspace missing', 'workspace_slice_not_found'],
    ['root', 'root differs', 'workspace_slice_not_found'],
    ['none', 'something else entirely', 'canonicalization_failed'],
    ['timeout before authority', 'authority check timeout', 'workspace_unavailable'],
    ['authority before workspace', 'workspace authority', 'authority_forbidden'],
    ['store before root', 'store root', 'workspace_unavailable'],
  ] as const).map(([label, message, code]) =>
    row(`keyword chain: ${label}`, 'claimed', 'claimed', () => new Error(message), to('claimed', code))),

  // --- C. structured preconditions decide the code, at either pre-send origin ------------------------
  row('structured: stale publish intent', 'validated', 'validated',
    () => withCode('intent is stale', { code: 'PUBLISH_INTENT_STALE' }), to('validated', 'publish_intent_stale')),
  row('structured: fee cap below base fee', 'validated', 'validated',
    () => withCode('fee cap too low', { code: 'FEE_CAP_BELOW_BASE_FEE' }), to('validated', 'fee_cap_below_base_fee')),
  row('structured: a fee-cap failure from claimed is an invalid (code, origin) pair - rejects, nothing recorded', 'claimed', 'claimed',
    () => withCode('fee cap too low', { code: 'FEE_CAP_BELOW_BASE_FEE' }), { rejects: /Invalid LiftJob failure state/ }),
  row('structured: corrupt workspace head', 'claimed', 'claimed', corruptHeadError, to('claimed', 'workspace_unavailable')),
  row('structured: not a full share', 'validated', 'validated',
    () => withCode('not a complete full share', { code: 'PUBLISH_NOT_FULL_SHARE' }), to('validated', 'canonicalization_failed')),
  row('structured: context graph not registered', 'validated', 'validated',
    () => withCode('is not registered on-chain', { code: 'CG_NOT_REGISTERED' }), to('validated', 'canonicalization_failed')),
  row('structured: author is not custodial', 'validated', 'validated',
    () => withCode('no custodial key', { code: PUBLISH_AUTHOR_NOT_CUSTODIAL_CODE }), to('validated', 'authority_forbidden')),
  row('structured: authority gate, transient reason', 'validated', 'validated',
    () => authorityUnavailable('authority-circuit-open'), to('validated', 'authority_unavailable')),
  row('structured: authority gate, terminal reason', 'validated', 'validated',
    () => authorityUnavailable('chain-access-policy-unknown'), to('validated', 'authority_forbidden')),
  row('structured: authority gate, unknown reason fails closed', 'validated', 'validated',
    () => authorityUnavailable('a-reason-nobody-registered'), to('validated', 'authority_forbidden')),
  row('structured: authority gate, no reason fails closed', 'validated', 'validated',
    () => authorityUnavailable(), to('validated', 'authority_forbidden')),
  row('a structured classification beats the pre-dispatch lane: the typed rejection is recorded from validated, with the structured code', 'validated', 'broadcast',
    () => Object.assign(schedulerBusy(), { message: formatPublishAuthorNotCustodialMessage('0xabc') }), to('validated', 'authority_forbidden'), PROVEN),

  // --- D. the pre-dispatch lane (P): proof + persisted 'validated' + a typed cause -------------------
  ...([
    ['scheduler busy', () => schedulerBusy()],
    ['a typed not_started with no keyword', typedStoreNotStarted],
    ['a plain-object typed not_started', plainTypedNotStarted],
    ["the adapter's write-ahead wrapper around a typed rejection", () => adapterRewrap(schedulerBusy())],
    ['a typed transient preparation exhaustion', preparationExhausted],
    ['a typed transient exhaustion with no keyword', keyedExhaustedWithoutKeywords],
    ['a full governor queue', governorQueueFull],
    ['a bounded request timeout', boundedRequestTimeout],
    ['the ACK-precondition wrapper around a typed transient failure', () => precondition(exhaustedWithoutKeywords())],
  ] as const).map(([label, make]) =>
    row(`P lane: ${label}`, 'validated', 'broadcast', make, preSend, PROVEN)),
  // A typed rejection whose words match no keyword: only the P lane can make this retryable, so the row
  // discriminates it (with the same origin reported as validated, scheduler-busy's "timeout" would not).
  row('P lane with the same origin reported as validated', 'validated', 'validated', typedStoreNotStarted, preSend, PROVEN),

  // --- E. each conjunct of P is independent --------------------------------------------------------------
  row('no proof supplied -> legacy broadcast classification', 'validated', 'broadcast',
    () => schedulerBusy(), to('broadcast', 'tx_submit_timeout', { timeout: true })),
  row('proof says it may have been sent -> legacy', 'validated', 'broadcast',
    () => schedulerBusy(), to('broadcast', 'tx_submit_timeout', { timeout: true }), MAYBE_SENT),
  row('an empty evidence object is no proof', 'validated', 'broadcast',
    () => schedulerBusy(), to('broadcast', 'tx_submit_timeout', { timeout: true }), {} as ExecutionFailureEvidence),
  row('proof + typed cause but the record is already at broadcast -> legacy (the rollback failed)', 'broadcast', 'broadcast',
    () => schedulerBusy(), to('broadcast', 'tx_submit_timeout', { timeout: true }), PROVEN),
  row('proof + typed transient but the record is already at broadcast -> legacy', 'broadcast', 'broadcast',
    preparationExhausted, to('broadcast', 'tx_submit_timeout', { timeout: true }), PROVEN),
  row('proof + a transient failure that names a transaction -> legacy', 'validated', 'broadcast',
    () => broadcastExhausted(TX_HASH), to('broadcast', 'tx_submit_timeout', { timeout: true }), PROVEN),
  row('proof + a receipt-wait timeout (names a transaction) -> legacy', 'validated', 'broadcast',
    () => receiptWaitTimeout(TX_HASH), to('broadcast', 'tx_submit_timeout', { timeout: true }), PROVEN),
  row('proof + a receipt lookup failure -> legacy catch-all', 'validated', 'broadcast',
    receiptLookupFailed, to('broadcast', 'rpc_unavailable'), PROVEN),
  row('an untyped write-ahead failure is not a store rejection, even with the proof', 'validated', 'broadcast',
    () => adapterRewrap(new Error('ENOSPC: no space left on device')), to('broadcast', 'rpc_unavailable'), PROVEN),
  row('a wrapper that dropped its cause does not qualify', 'validated', 'broadcast',
    () => legacyAdapterRewrap(schedulerBusy()), to('broadcast', 'tx_submit_timeout', { timeout: true }), PROVEN),
  row('a typed cause on an arbitrary error is not unwrapped', 'validated', 'broadcast',
    () => new Error('some other failure', { cause: schedulerBusy() }), to('broadcast', 'rpc_unavailable'), PROVEN),
  row('an indeterminate store timeout never qualifies (its words name no timeout, so the catch-all)', 'validated', 'broadcast',
    indeterminateStoreTimeout, to('broadcast', 'rpc_unavailable'), PROVEN),
  row('two ACK-precondition wrappers do not qualify', 'validated', 'broadcast',
    () => precondition(precondition(exhaustedWithoutKeywords())), to('broadcast', 'rpc_unavailable'), PROVEN),
  row('a typed transient failure without the proof on a validated origin stays on the keyword chain', 'validated', 'validated',
    keyedExhaustedWithoutKeywords, to('validated', 'canonicalization_failed')),

  // --- F. the publish mapper (any origin that is not claimed/validated) --------------------------------
  row('a timeout-worded failure carries the placeholder timeout metadata', 'broadcast', 'broadcast',
    () => new Error('RPC submit timed out'), to('broadcast', 'tx_submit_timeout', { timeout: true })),
  row('a failure with no timeout wording carries none', 'broadcast', 'broadcast',
    () => new Error('transport exploded'), to('broadcast', 'rpc_unavailable')),
  row('insufficient funds', 'broadcast', 'broadcast', () => new Error('insufficient funds for gas'), to('broadcast', 'insufficient_funds')),
  row('nonce conflict', 'broadcast', 'broadcast', () => new Error('nonce too low'), to('broadcast', 'nonce_conflict')),
  row('revert', 'broadcast', 'broadcast', () => new Error('execution reverted'), to('broadcast', 'tx_reverted')),
  row('a permanent author refusal beats the timeout wording, and its metadata is dropped', 'broadcast', 'broadcast',
    () => withCode('timeout while selecting the author', { code: PUBLISH_AUTHOR_NOT_CUSTODIAL_CODE }), to('broadcast', 'authority_forbidden')),
  row('a legacy typed store rejection is not special at broadcast', 'broadcast', 'broadcast',
    () => schedulerBusy(), to('broadcast', 'tx_submit_timeout', { timeout: true })),

  // --- G. the message: the legacy path reads the thrown value verbatim, host-reduced -------------------
  row('a keyed RPC URL on the keyword chain is persisted as its host', 'validated', 'validated',
    () => new Error(`Store query failed while reading ${KEYED_RPC_URL}: busy`), to('validated', 'workspace_unavailable')),
  row('a keyed RPC URL on the publish mapper is persisted as its host', 'broadcast', 'broadcast',
    () => new Error(`execution reverted (info={ "requestUrl": "${KEYED_RPC_URL}" })`), to('broadcast', 'tx_reverted')),
  row('a keyed RPC URL on the typed pre-send lane is persisted as its host', 'validated', 'broadcast',
    keyedExhaustedWithoutKeywords, preSend, PROVEN),
  row('a string throw is its own message', 'claimed', 'claimed',
    () => 'timeout talking to the store', to('claimed', 'workspace_unavailable', { message: 'timeout talking to the store' })),
  row('a plain object with a .message classifies as [object Object] on the legacy path', 'claimed', 'claimed',
    () => ({ message: 'timeout talking to the store' }), to('claimed', 'canonicalization_failed', { message: '[object Object]' })),
  row('a null throw', 'claimed', 'claimed', () => null, to('claimed', 'canonicalization_failed', { message: 'null' })),
  row('a null-prototype throw rejects on the legacy path, nothing recorded', 'claimed', 'claimed',
    nullPrototypeThrow, { rejects: /Cannot convert object to primitive value/ }),
  row('a hostile cause accessor does not escape the typed check', 'validated', 'broadcast',
    () => Object.defineProperty(
      Object.assign(new Error('hostile wrapper'), { code: 'CHAIN_WRITE_AHEAD_HOOK_FAILED' }),
      'cause',
      { get() { throw new Error('getter exploded'); } },
    ), to('broadcast', 'rpc_unavailable'), PROVEN),
  // The two branches read a non-Error throw differently: the legacy claimed/validated path reads
  // `String(error)`, the publish mapper prefers a string `.message`. Pinned, not endorsed.
  row('a non-Error throw with a .message: the publish mapper classifies on .message and persists it', 'broadcast', 'broadcast',
    () => ({ message: 'insufficient funds for gas' }), to('broadcast', 'insufficient_funds', { message: 'insufficient funds for gas' })),
  row('a non-Error throw whose .message names a timeout rejects: the legacy text builds no timeout metadata', 'broadcast', 'broadcast',
    () => ({ message: 'RPC submit timed out' }), { rejects: /Timeout metadata is required/ }),
];

describe('GH#2945 recordExecutionFailure: the failure decision, characterized through the real publisher', () => {
  const h = createAsyncLift2270Harness();
  const { stage } = createStoreRejectionFixtures(h);

  beforeEach(() => h.reset());

  async function sessionAt(persisted: PersistedStatus) {
    const publisher = h.createPublisher(RETRY_LANE);
    await stage();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const claimed = await publisher.claimNext('wallet-1');
    if (!claimed) throw new Error('expected a claim');
    if (persisted !== 'claimed') await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    if (persisted === 'broadcast') {
      await publisher.update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId: 'wallet-1', operationKind: 'create' } });
    }
    return { publisher, jobId, session: publisher.openClaimSession(claimed as ActiveLiftJobClaim) };
  }

  it.each(MAPPING_ROWS)('$name', async (r) => {
    const { publisher, jobId, session } = await sessionAt(r.persisted);

    if ('rejects' in r.expected) {
      await expect(session.recordExecutionFailure(r.requested, r.error(), r.evidence)).rejects.toThrow(r.expected.rejects);
      expect((await publisher.getStatus(jobId))?.status).toBe(r.persisted);
      return;
    }

    const error = r.error();
    const failed = expectFailed(await session.recordExecutionFailure(r.requested, error, r.evidence));
    const policy = getLiftJobFailurePolicy(r.expected.code);

    expect(failed.failure.failedFromState).toBe(r.expected.origin);
    expect(failed.failure.code).toBe(r.expected.code);
    expect(failed.failure.phase).toBe(policy.phase);
    expect(failed.failure.mode).toBe(policy.mode);
    expect(failed.failure.retryable).toBe(policy.retryable);
    expect(failed.failure.resolution).toBe(policy.resolution);
    expect(failed.failure.errorPayloadRef).toBe(`urn:dkg:publisher:error:${jobId}`);
    expect(failed.failure.message).toBe(
      r.expected.message ?? hostOnlyRpcText(error instanceof Error ? error.message : String(error)),
    );
    if (r.expected.timeout) {
      expect(failed.failure.timeout).toEqual({
        timeoutMs: 0,
        timeoutAt: expect.any(Number),
        handling: 'check_chain_then_finalize_or_reset',
      });
      // Stamped by the publisher's own clock while the failure is recorded, so before the job's update stamp.
      expect(failed.failure.timeout?.timeoutAt).toBeGreaterThan(0);
      expect(failed.failure.timeout?.timeoutAt).toBeLessThanOrEqual(failed.timestamps.updatedAt);
    } else {
      expect(failed.failure.timeout).toBeUndefined();
    }
    // The schedule step runs on every failure: a retry is scheduled exactly for the codes that opt in.
    expect(failed.timestamps.nextRetryAt !== undefined).toBe(policy.autoRetry);
  });

  it('records nothing when the failure decision rejects: the job keeps its persisted status', async () => {
    const { publisher, jobId, session } = await sessionAt('validated');

    await expect(session.recordExecutionFailure('claimed', nullPrototypeThrow())).rejects.toThrow();

    expect((await publisher.getStatus(jobId))?.status).toBe('validated');
  });
});

describe('GH#2945 isKnowledgeAssetPublishPreconditionFailure: the pre-send routing of a failed KA VM publish', () => {
  // The caller reports 'validated' (not 'broadcast') for these, so a message-keyed failure that was never
  // sent is not recorded as a possible transaction. No other suite pinned the message regexes.
  it.each([
    'the assertion is not finalized',
    'No quads in shared memory for the share',
    'the share has no private payload',
    'the asset is not a complete full share',
    'cannot recover the reservedKaId for this author',
    'seal binds a different merkle root',
  ])('routes "%s" to the pre-send state', (message) => {
    expect(isKnowledgeAssetPublishPreconditionFailure(new Error(message))).toBe(true);
  });

  it('routes a structured precondition code with none of those words', () => {
    expect(isKnowledgeAssetPublishPreconditionFailure(withCode('x', { code: 'PUBLISH_INTENT_STALE' }))).toBe(true);
  });

  it('reads a string throw and a non-Error object with a .message, in any case', () => {
    expect(isKnowledgeAssetPublishPreconditionFailure('The assertion IS NOT FINALIZED')).toBe(true);
    expect(isKnowledgeAssetPublishPreconditionFailure({ message: 'No quads in shared memory' })).toBe(true);
    expect(isKnowledgeAssetPublishPreconditionFailure('transport exploded')).toBe(false);
  });

  it('does not route an unrelated failure or a null throw', () => {
    expect(isKnowledgeAssetPublishPreconditionFailure(new Error('transport exploded'))).toBe(false);
    expect(isKnowledgeAssetPublishPreconditionFailure(null)).toBe(false);
  });

  it('rejects on a null-prototype throw, as the legacy text read does (pinned, not hardened here)', () => {
    expect(() => isKnowledgeAssetPublishPreconditionFailure(nullPrototypeThrow())).toThrow(/Cannot convert object to primitive value/);
  });
});

describe('GH#2945 mapExecutionFailure: the same decision as a pure function', () => {
  // The legacy text the mapper tests for timeout wording (NOT the publish mapper's own extraction).
  const legacyText = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const namesTimeout = (text: string) => /timeout|timed out/i.test(text);

  function countingClock() {
    const clock = { calls: 0, now: () => { clock.calls += 1; return 5_000 + clock.calls; } };
    return clock;
  }

  it.each(MAPPING_ROWS)('$name', (r) => {
    const clock = countingClock();
    const error = r.error();
    const input = {
      jobId: 'job-9',
      currentStatus: r.persisted,
      requestedOrigin: r.requested,
      error,
      evidence: r.evidence,
      now: clock.now,
    };

    if ('rejects' in r.expected) {
      expect(() => mapExecutionFailure(input)).toThrow(r.expected.rejects);
      return;
    }

    const failure = mapExecutionFailure(input);
    const policy = getLiftJobFailurePolicy(r.expected.code);

    expect(failure.failedFromState).toBe(r.expected.origin);
    expect(failure.code).toBe(r.expected.code);
    expect(failure.phase).toBe(policy.phase);
    expect(failure.mode).toBe(policy.mode);
    expect(failure.retryable).toBe(policy.retryable);
    expect(failure.resolution).toBe(policy.resolution);
    expect(failure.errorPayloadRef).toBe('urn:dkg:publisher:error:job-9');
    expect(failure.message).toBe(r.expected.message ?? hostOnlyRpcText(legacyText(error)));
    if (r.expected.timeout) {
      expect(failure.timeout).toEqual({ timeoutMs: 0, timeoutAt: 5_001, handling: 'check_chain_then_finalize_or_reset' });
    } else {
      expect(failure.timeout).toBeUndefined();
    }
    // The clock is read once, and only when a non-pre-send origin's legacy text names a timeout - even when
    // the publish mapper then drops the metadata (a permanent author refusal beats the timeout wording).
    const preSendOrigin = failure.failedFromState === 'claimed' || failure.failedFromState === 'validated';
    expect(clock.calls).toBe(!preSendOrigin && namesTimeout(legacyText(error)) ? 1 : 0);
  });

  it('reads the clock exactly once for a timeout wording whose metadata the publish mapper drops', () => {
    const clock = countingClock();

    const failure = mapExecutionFailure({
      jobId: 'job-9',
      currentStatus: 'broadcast',
      requestedOrigin: 'broadcast',
      error: withCode('timeout while selecting the author', { code: PUBLISH_AUTHOR_NOT_CUSTODIAL_CODE }),
      now: clock.now,
    });

    expect(failure.code).toBe('authority_forbidden');
    expect(failure.timeout).toBeUndefined();
    expect(clock.calls).toBe(1);
  });

  it('the C lane needs the REPORTED origin to be claimed as well as the record (a combination the state machine cannot commit)', () => {
    const failure = mapExecutionFailure({
      jobId: 'job-9',
      currentStatus: 'claimed',
      requestedOrigin: 'validated',
      error: keyedExhaustedWithoutKeywords(),
      now: countingClock().now,
    });

    expect(failure).toMatchObject({ failedFromState: 'validated', code: 'canonicalization_failed' });
  });

  describe('origins production never reports (pinned as the current collapse)', () => {
    it('an included origin keeps its own state and its finality timeout', () => {
      const clock = countingClock();

      const failure = mapExecutionFailure({
        jobId: 'job-9',
        currentStatus: 'included',
        requestedOrigin: 'included',
        error: new Error('finality wait timed out'),
        now: clock.now,
      });

      expect(failure).toMatchObject({ failedFromState: 'included', code: 'finality_timeout' });
      expect(failure.timeout).toEqual({ timeoutMs: 0, timeoutAt: 5_001, handling: 'check_chain_then_finalize_or_reset' });
    });

    it('an included origin with no timeout wording is a confirmation mismatch', () => {
      const failure = mapExecutionFailure({
        jobId: 'job-9',
        currentStatus: 'included',
        requestedOrigin: 'included',
        error: new Error('receipt is odd'),
        now: countingClock().now,
      });

      expect(failure).toMatchObject({ failedFromState: 'included', code: 'confirmation_mismatch' });
    });

    it.each(['accepted', 'finalized', 'failed'] as const)('a reported %s origin is recorded as a broadcast failure', (requested) => {
      const failure = mapExecutionFailure({
        jobId: 'job-9',
        currentStatus: 'broadcast',
        requestedOrigin: requested,
        error: new Error('transport exploded'),
        now: countingClock().now,
      });

      expect(failure).toMatchObject({ failedFromState: 'broadcast', code: 'rpc_unavailable' });
    });
  });
});


describe('GH#2964 deterministic draft publish failures', () => {
  it.each(DRAFT_PRECONDITIONS)('%s is pre-send and terminal', (code, mapped) => {
    const error = withCode('deterministic refusal', { code });
    expect(isKnowledgeAssetPublishPreconditionFailure(error)).toBe(true);
    expect(getLiftJobFailurePolicy(mapped)).toMatchObject({ retryable: false, autoRetry: false });
  });
});
