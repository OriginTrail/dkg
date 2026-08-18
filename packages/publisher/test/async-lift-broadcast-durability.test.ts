import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  NO_FUNDED_PUBLISHER_WALLET_CODE,
  PUBLISH_AUTHOR_NOT_CUSTODIAL_CODE,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncLiftPublisher,
  mapPublishExceptionToLiftJobFailure,
  type AsyncLiftPublisherConfig,
} from '../src/index.js';
// Internal recovery policy — imported directly from the module, deliberately not re-exported
// from the package barrel (kept off the public API surface).
import { isDefinitivePreAcceptanceSendFailure } from '../src/async-lift-publish-result.js';
import {
  DEFAULT_JOURNAL_GRAPH_URI,
  JOURNAL_SEQ,
  JOURNAL_KIND,
  parseIntegerLiteral,
  parseLiteral,
} from '../src/async-lift-control-plane.js';
// GH#2270 — what a failed job carrying a transaction hash MEANS (PR-2's policy module),
// used below to show the raw-lift write-ahead is what puts a job under the chain-proof hold.
import { hasBroadcastEvidence, isHeldForChainProof } from '../src/async-lift-retry-disposition.js';
import type { LiftJob, RawLiftRequest } from '../src/lift-job.js';
import type { PersistedFailedJob } from '../src/async-lift-publisher-utils.js';
import { seedLegacyRawLiftTestJob } from './_helpers/legacy-raw-lift.js';
import {
  KA_VM_EXECUTOR_TX_HASH,
  KA_VM_KA_UAL,
  kaVmPublishRequest,
  stageKnowledgeAssetShareSnapshot,
} from './_helpers/ka-vm-publish.js';

// Read the journal kinds (seq-ordered) straight from the node-local journal graph.
async function journalKinds(store: OxigraphStore): Promise<string[]> {
  const result = await store.query(
    `SELECT ?seq ?kind WHERE { GRAPH <${DEFAULT_JOURNAL_GRAPH_URI}> { ?e <${JOURNAL_SEQ}> ?seq ; <${JOURNAL_KIND}> ?kind } }`,
  );
  if (result.type !== 'bindings') return [];
  return result.bindings
    .map((r) => ({ seq: parseIntegerLiteral(r['seq'] as string), kind: parseLiteral(r['kind'] as string) as string }))
    .sort((a, b) => a.seq - b.seq)
    .map((r) => r.kind);
}

// Regression: the mutable 'broadcast' record must be fsync-durable BEFORE the
// on-chain send. It is written inside the write-ahead hook (onBroadcast, awaited
// strictly before the tx sends) via recordDurableBroadcastBeforeSend — the sole
// pre-send durability boundary. Without the flush there, a daemon crash in the
// flush->send window loses the record; on restart the job reads back as
// 'validated', recover() resets it, and it re-broadcasts with a fresh hash — a
// double on-chain submission. Durability is scoped to that helper (not the
// generic update/writeJob), so no other transition takes a whole-store fsync. A
// flush FAILURE must not leave a phantom 'broadcast': the tx was never sent (the
// adapter fails closed), so the job rolls back to its pre-broadcast state, off
// the chain-recovery track.
describe('async lift publisher broadcast durability', () => {
  let now = 1_000;
  let ids = 0;
  let store: OxigraphStore;
  const tempDirs: string[] = [];

  beforeEach(() => {
    now = 1_000;
    ids = 0;
    store = new OxigraphStore();
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function createPublisher(
    targetStore: OxigraphStore = store,
    config: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator'> = {},
  ): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(targetStore, {
      now: () => ++now,
      idGenerator: () => `job-${++ids}`,
      ...config,
    });
  }

  const TX_HASH = KA_VM_EXECUTOR_TX_HASH;

  async function stageShareSnapshot(targetStore: OxigraphStore): Promise<void> {
    await stageKnowledgeAssetShareSnapshot({ store: targetStore });
  }

  // A VM-publish executor that fires the pre-send write-ahead (onPhase → records
  // 'broadcast'), then stops before the real send. Drives the exact pre-send
  // durability boundary through the public processNext() path.
  function firesBroadcastThenStops(): NonNullable<AsyncLiftPublisherConfig['knowledgeAssetVmPublishHandler']> {
    return {
      execute: async (input) => {
        await input.publishOptions.onPhase?.(`chain:txsigned:tx-${TX_HASH}`, 'start');
        throw new Error('stop after the durable write-ahead');
      },
    };
  }

  it('fsyncs once on the pre-send broadcast write-ahead, not on the earlier transitions', async () => {
    let flushCount = 0;
    let flushCountBeforeBroadcast = -1;
    const orig = store.flush?.bind(store);
    (store as unknown as { flush?: () => Promise<void> }).flush = async () => {
      flushCount += 1;
      await orig?.();
    };

    const publisher = createPublisher(store, {
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          // accepted (enqueue) / claimed (claimNext) / validated (update) have all
          // run by now and must not have fsync'd.
          flushCountBeforeBroadcast = flushCount;
          await input.publishOptions.onPhase?.(`chain:txsigned:tx-${TX_HASH}`, 'start');
          throw new Error('stop after the durable write-ahead');
        },
      },
    });

    await stageShareSnapshot(store);
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    expect(flushCountBeforeBroadcast).toBe(0);
    // Exactly one fsync — the pre-send write-ahead; the post-throw catch path adds none.
    expect(flushCount).toBe(1);
    expect(processed?.status).toBe('broadcast');
    expect(processed?.broadcast?.txHash).toBe(TX_HASH);
  });

  it('awaits the broadcast fsync before the pre-send write-ahead resolves', async () => {
    // Proves the fsync is AWAITED, not fire-and-forget: a regression that dropped
    // `await` on store.flush?.() would let the write-ahead resolve before the
    // record is durable, reopening the flush->send crash window.
    const gate: { release: () => void } = { release: () => {} };
    let flushStarted = false;
    (store as unknown as { flush?: () => Promise<void> }).flush = async () => {
      flushStarted = true;
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
    };

    const publisher = createPublisher(store, {
      knowledgeAssetVmPublishHandler: firesBroadcastThenStops(),
    });

    await stageShareSnapshot(store);
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    let settled = false;
    const proc = publisher.processNext('wallet-1').then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // Let microtasks + a macrotask drain: processNext must still be pending,
    // blocked on the in-flight pre-send fsync.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(flushStarted).toBe(true);
    expect(settled).toBe(false);

    gate.release();
    await proc;
    expect(settled).toBe(true);
  });

  it('persists the broadcast record across a restart (fresh store from disk)', async () => {
    // Proves durability, not just that flush() was called: drive the pre-send
    // write-ahead on a persistent store, then reopen a FRESH store+publisher from
    // the same path and confirm the record survived. A crash-recovery reads
    // 'broadcast' (chain-recovery path) instead of 'validated' (reset-and-resend).
    const dir = mkdtempSync(join(tmpdir(), 'lift-broadcast-durability-'));
    tempDirs.push(dir);
    const persistPath = join(dir, 'store.nq');

    const store1 = new OxigraphStore(persistPath);
    const publisher1 = createPublisher(store1, {
      knowledgeAssetVmPublishHandler: firesBroadcastThenStops(),
    });
    await stageShareSnapshot(store1);
    const jobId = await publisher1.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher1.processNext('wallet-1');
    expect(processed?.status).toBe('broadcast');

    const store2 = new OxigraphStore(persistPath);
    const publisher2 = createPublisher(store2);
    const recovered = await publisher2.getStatus(jobId);

    expect(recovered?.status).toBe('broadcast');
    expect(recovered?.broadcast?.txHash).toBe(TX_HASH);
    expect(recovered?.broadcast?.walletId).toBe('wallet-1');
  });

  it('does not send or leave a phantom broadcast when the write-ahead fsync fails', async () => {
    // Regression (#1851 review): the write-ahead fsync runs AFTER the in-memory
    // 'broadcast' transition. If it throws, the store would show 'broadcast'
    // although the adapter fails closed and never sends the tx. The job must roll
    // back to a pre-broadcast state, never be reported/left as 'broadcast' (which
    // recovery would chase as an on-chain tx that never landed).
    let sent = false;
    const publisher = createPublisher(store, {
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          try {
            // Records 'broadcast' (write-ahead) -> flush (rejects) -> rollback.
            await input.publishOptions.onPhase?.(`chain:txsigned:tx-${TX_HASH}`, 'start');
          } catch (hookErr) {
            // Mirror the adapter's fail-closed rewrap (evm-adapter-base.ts:1609):
            // a rejected write-ahead hook aborts the broadcast, tx never sent.
            throw new Error(
              `chain:writeahead hook failed before publish broadcast: ${(hookErr as Error).message}`,
            );
          }
          sent = true; // real adapter's eth_sendRawTransaction — must NOT run
          throw new Error('unreachable: send happened after a failed write-ahead flush');
        },
      },
    });

    // fsync is only invoked on the pre-send broadcast write-ahead; fault-inject it.
    (store as unknown as { flush?: () => Promise<void> }).flush = async () => {
      throw new Error('ENOSPC: no space left on device');
    };

    await stageShareSnapshot(store);
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    // The tx was never sent.
    expect(sent).toBe(false);
    // The job is not left or reported as 'broadcast' (the rollback is what makes
    // this hold — see the mutation-check below).
    expect(processed?.status).toBe('failed');
    expect(processed?.status).not.toBe('broadcast');

    const persisted = await publisher.getStatus(jobId);
    expect(persisted?.status).toBe('failed');
    expect(persisted?.status).not.toBe('broadcast');

    // Treated as never-sent: retryable and reset to accepted, NOT the
    // chain-recovery track (retry_recovery / check-chain) that would chase a tx
    // hash that never landed.
    expect(processed?.failure?.retryable).toBe(true);
    expect(processed?.failure?.resolution).toBe('reset_to_accepted');
    expect(processed?.failure?.resolution).not.toBe('retry_recovery');
    const recovered = await publisher.recover();
    expect(recovered).toBe(0);
    expect((await publisher.getStatus(jobId))?.status).toBe('failed');
  });

  it('classifies a pre-onPhase funding failure as insufficient_funds, off the recovery track', async () => {
    // Regression (#1851 review): a NO_FUNDED_PUBLISHER_WALLET thrown by the
    // executor BEFORE the write-ahead onPhase must keep its structured code
    // (insufficient_funds via the publish mapper), not be relabelled a generic
    // validation failure. No tx is ever sent, so it must not enter chain recovery.
    const publisher = createPublisher(store, {
      knowledgeAssetVmPublishHandler: {
        execute: async () => {
          // Mirrors dkg-chain's funded-wallet selection failing before any send.
          throw Object.assign(
            new Error('No operational wallet has enough funds to publish'),
            { code: NO_FUNDED_PUBLISHER_WALLET_CODE },
          );
        },
      },
    });

    await stageShareSnapshot(store);
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    expect(processed?.status).toBe('failed');
    expect(processed?.failure?.code).toBe('insufficient_funds');
    // Terminal funding failure, off the chain-recovery track (no tx was sent).
    expect(processed?.failure?.resolution).not.toBe('retry_recovery');
    expect(await publisher.recover()).toBe(0);
    expect((await publisher.getStatus(jobId))?.status).toBe('failed');
  });

  // GH#1786 (@lupuszr on PR #1969) — the full late-worker proof, not just the mapper unit.
  // The async lane deliberately ACCEPTS a selected foreign-author UPDATE while wallet
  // selection is still deferred, so "this node cannot re-sign for that author" is only
  // discovered here, in the worker. It must be recorded as a PERMANENT authority failure:
  // before the fix it mapped to retryable `rpc_unavailable`, so the queue reset and retried a
  // job that can never finalize — the forever-retry trap #1013/#1121 fixed for unfundable
  // publishes. Drives the real cycle (enqueue → processNext → stored-job readback) rather
  // than asserting the classifier in isolation.
  it('records a non-custodial selected-author UPDATE as a TERMINAL authority failure, never retried', async () => {
    const publisher = createPublisher(store, {
      knowledgeAssetVmPublishHandler: {
        execute: async () => {
          // Exactly what _buildPrecomputedUpdateAttestationForSeal raises when the claiming
          // wallet is neither custodial for the author nor the publisher EOA.
          throw Object.assign(
            new Error(
              'publishFromFinalizedAssertion (update path): cannot re-sign UpdateAuthorAttestation '
              + 'for author 0xA32f1cc125401B55911678847426759094055B2d — no custodial key on file '
              + 'and it is not the publisher EOA.',
            ),
            { code: PUBLISH_AUTHOR_NOT_CUSTODIAL_CODE },
          );
        },
      },
    });

    await stageShareSnapshot(store);
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    expect(processed?.status).toBe('failed');
    // Authority, not transport — and explicitly NOT the retryable default it used to get.
    expect(processed?.failure?.code).toBe('authority_forbidden');
    expect(processed?.failure?.code).not.toBe('rpc_unavailable');
    expect(processed?.failure?.retryable).toBe(false);
    expect(processed?.failure?.resolution).toBe('fail_job');
    // The refusal is raised while BUILDING the attestation, strictly before the write-ahead
    // records 'broadcast', so NO transaction was sent. The record must say so: recording
    // 'broadcast' here would publish a phantom broadcast (and mislabel the phase with it).
    expect(processed?.failure?.failedFromState).toBe('validated');
    expect(processed?.failure?.phase).toBe('validation');
    expect(processed?.broadcast).toBeUndefined();
    expect(processed?.inclusion).toBeUndefined();

    // Stored-job readback: the persisted record carries the same terminal classification,
    // which is what an operator polling /api/publisher/job actually sees.
    const persisted = await publisher.getStatus(jobId);
    expect(persisted?.status).toBe('failed');
    expect(persisted?.failure?.code).toBe('authority_forbidden');
    expect(persisted?.failure?.retryable).toBe(false);
    expect(persisted?.failure?.resolution).toBe('fail_job');
    expect(persisted?.failure?.failedFromState).toBe('validated');
    expect(persisted?.failure?.phase).toBe('validation');
    // No tx metadata anywhere in the persisted record.
    expect(persisted?.broadcast).toBeUndefined();
    expect(persisted?.inclusion).toBeUndefined();

    // No tx was sent, so recovery must not adopt it, and it must not be reset for retry.
    expect(await publisher.recover()).toBe(0);
    expect((await publisher.getStatus(jobId))?.status).toBe('failed');
  });

  // #1829 — the flush-fail rollback (recordDurableBroadcastBeforeSend → writeJob(current))
  // must NOT append a duplicate 'validated' journal entry: that re-write passes the
  // 'rollback-noop' sentinel so appendJournal no-ops. The journal records the pre-flush
  // 'broadcast' attempt (an ATTEMPTED tx hash, to reconcile vs chain) and the terminal
  // 'failed' entry — one 'validated', not two.
  it('flush-fail rollback appends broadcast + failed but NO duplicate validated entry (#1829)', async () => {
    const publisher = createPublisher(store, {
      journalWrites: true,
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          try {
            await input.publishOptions.onPhase?.(`chain:txsigned:tx-${TX_HASH}`, 'start');
          } catch (hookErr) {
            throw new Error(`chain:writeahead hook failed before publish broadcast: ${(hookErr as Error).message}`);
          }
          throw new Error('unreachable: send after a failed write-ahead flush');
        },
      },
    });
    (store as unknown as { flush?: () => Promise<void> }).flush = async () => {
      throw new Error('ENOSPC: no space left on device');
    };

    await stageShareSnapshot(store);
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.processNext('wallet-1');

    const kinds = await journalKinds(store);
    // Exactly one of each; the rollback's writeJob(current='validated') did NOT add a 2nd 'validated'.
    expect(kinds).toEqual(['admission', 'claimed', 'validated', 'broadcast', 'failed']);
    expect(kinds.filter((k) => k === 'validated')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'broadcast')).toHaveLength(1);
  });

  // A VM-publish executor that fires the pre-send write-ahead (records a durable
  // 'broadcast'), then throws `error` — the post-write-ahead failure #1867 classifies.
  function firesBroadcastThenThrows(
    error: unknown,
  ): NonNullable<AsyncLiftPublisherConfig['knowledgeAssetVmPublishHandler']> {
    return {
      execute: async (input) => {
        await input.publishOptions.onPhase?.(`chain:txsigned:tx-${TX_HASH}`, 'start');
        throw error;
      },
    };
  }

  // #1867 — a send that fails DEFINITIVELY before mempool acceptance (insufficient funds
  // at eth_sendRawTransaction) throws AFTER the durable 'broadcast' record. Instead of
  // stranding the job on the ~15-min recovery chase (ending in recovery_state_inconsistent),
  // it must be an immediate terminal broadcast-phase failure — insufficient_funds — with no
  // recovery lookup and no resend.
  it('records an immediate terminal insufficient_funds when the send is rejected before acceptance (#1867)', async () => {
    const publisher = createPublisher(store, {
      knowledgeAssetVmPublishHandler: firesBroadcastThenThrows(
        new Error('insufficient funds for gas * price + value'),
      ),
    });

    await stageShareSnapshot(store);
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    // Terminal failure now — NOT left as 'broadcast' for recovery to chase.
    expect(processed?.status).toBe('failed');
    expect(processed?.status).not.toBe('broadcast');
    expect(processed?.failure?.code).toBe('insufficient_funds');
    // Terminal, off the chain-recovery track (fail_job, non-retryable).
    expect(processed?.failure?.resolution).toBe('fail_job');
    expect(processed?.failure?.resolution).not.toBe('retry_recovery');
    expect(processed?.failure?.retryable).toBe(false);
    // The attempted broadcast tx hash is retained on the failed job for diagnostics.
    expect(processed?.broadcast?.txHash).toBe(TX_HASH);

    // recover() must NOT chase or resubmit a never-accepted tx: no work, job stays failed.
    expect(await publisher.recover()).toBe(0);
    expect((await publisher.getStatus(jobId))?.status).toBe('failed');
  });

  // #1867 SAFETY (throw-safe classifier) — a pathological, non-stringifiable thrown value
  // (null-prototype object → String() TypeError) thrown AFTER the durable-broadcast record
  // must NOT let the classifier throw: that would skip the ambiguous-recovery branch and
  // strand the job off the recovery track. An unstringifiable error is classified
  // non-definitive → the job stays 'broadcast' on the recovery track, never terminates,
  // never resends.
  it('keeps a non-stringifiable thrown value on the recovery track (throw-safe classifier)', async () => {
    const publisher = createPublisher(store, {
      knowledgeAssetVmPublishHandler: firesBroadcastThenThrows(Object.create(null) as unknown),
    });

    await stageShareSnapshot(store);
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    expect(processed?.status).toBe('broadcast');
    expect(processed?.status).not.toBe('failed');
    expect(processed?.broadcast?.txHash).toBe(TX_HASH);
    expect(await publisher.recover()).toBe(0);
    expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
  });

  // #1867 SAFETY (throw-safe classifier — #1918 round-5 🔴) — inspecting the thrown value must
  // be guarded for MORE than String(): a throwing `code` accessor (or a Proxy) makes the very
  // first property read throw. Thrown AFTER the durable-broadcast record, that would escape the
  // catch before it can return the persisted broadcast job, stranding the job off recovery. The
  // classifier must treat such a value as non-definitive → the job stays 'broadcast'.
  it('keeps a value with a throwing "code" accessor on the recovery track (throw-safe classifier)', async () => {
    const throwingCode = Object.defineProperty(new Error('rpc timeout'), 'code', {
      get() {
        throw new Error('code getter failed');
      },
    });
    const publisher = createPublisher(store, {
      knowledgeAssetVmPublishHandler: firesBroadcastThenThrows(throwingCode),
    });

    await stageShareSnapshot(store);
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    expect(processed?.status).toBe('broadcast');
    expect(processed?.status).not.toBe('failed');
    expect(processed?.broadcast?.txHash).toBe(TX_HASH);
    expect(await publisher.recover()).toBe(0);
    expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
  });

  // #1867 (#1918 round-6 🔴) — a mined-then-reverted tx whose revert string happens to contain
  // "insufficient funds" is NOT a pre-acceptance reject. A revert is post-mempool by definition
  // (the tx was accepted and mined), so it must stay on the recovery track like every other
  // revert (see the plain-revert case in the safety matrix below) — never taken by the
  // pre-acceptance shortcut. This keeps the whitelist strictly to node-level pre-send rejects;
  // go-ethereum's `insufficient funds for gas * price + value` contains no "revert", so the
  // genuine pre-acceptance case (next test) is unaffected.
  it('keeps a revert message that contains "insufficient funds" on the recovery track (revert is post-mempool)', async () => {
    const publisher = createPublisher(store, {
      knowledgeAssetVmPublishHandler: firesBroadcastThenThrows(
        new Error('execution reverted: insufficient funds'),
      ),
    });

    await stageShareSnapshot(store);
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    expect(processed?.status).toBe('broadcast');
    expect(processed?.status).not.toBe('failed');
    expect(processed?.broadcast?.txHash).toBe(TX_HASH);
    expect(await publisher.recover()).toBe(0);
    expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
  });

  // The genuine node-level pre-send reject (contains no "revert") still terminal-fails.
  it('still terminal-fails a node-level "insufficient funds for gas" pre-send reject', async () => {
    const publisher = createPublisher(store, {
      knowledgeAssetVmPublishHandler: firesBroadcastThenThrows(
        new Error('insufficient funds for gas * price + value'),
      ),
    });

    await stageShareSnapshot(store);
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    expect(processed?.status).toBe('failed');
    expect(processed?.failure?.code).toBe('insufficient_funds');
  });

  // #1867 SAFETY INVARIANT (double-submit guard) — every AMBIGUOUS post-write-ahead error
  // (one that could correspond to a tx already in the mempool or mined) MUST stay on the
  // recovery early-return: left as 'broadcast', never terminated, never resent. If a future
  // change broadens the whitelist to any of these, these cases fail loudly. Reverts here
  // deliberately do NOT contain "insufficient funds" (that collision is the locked edge above).
  it.each([
    ['a plain RPC timeout', 'ETIMEDOUT: request timed out'],
    ['a nonce race', 'nonce too low'],
    ['a replacement-underpriced reject', 'replacement transaction underpriced'],
    ['an already-known tx', 'already known'],
    ['a plain on-chain revert', 'execution reverted: KnowledgeCollection: not authorized'],
    ['an opaque executor error', 'stop after the durable write-ahead'],
  ])('keeps %s on the recovery track (stays broadcast, no resend)', async (_label, message) => {
    const publisher = createPublisher(store, {
      knowledgeAssetVmPublishHandler: firesBroadcastThenThrows(new Error(message)),
    });

    await stageShareSnapshot(store);
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    // Left on the recovery track: the durable 'broadcast' is preserved, NOT terminated.
    expect(processed?.status).toBe('broadcast');
    expect(processed?.status).not.toBe('failed');
    expect(processed?.broadcast?.txHash).toBe(TX_HASH);
    // Without a chain recovery resolver, recover() cannot resolve it and must not resend
    // (recover() returns 0 recovered work here; the job stays 'broadcast').
    expect(await publisher.recover()).toBe(0);
    expect((await publisher.getStatus(jobId))?.status).toBe('broadcast');
  });

  // Pure classifier contract for the conservative whitelist — locks the exact boundary
  // independently of the wiring (the invariant test above proves the wiring honors it).
  it('isDefinitivePreAcceptanceSendFailure whitelists only unambiguous pre-mempool rejects', () => {
    // Whitelisted — provably before mempool admission.
    expect(isDefinitivePreAcceptanceSendFailure(new Error('insufficient funds for gas * price + value'))).toBe(true);
    expect(isDefinitivePreAcceptanceSendFailure(new Error('INSUFFICIENT FUNDS'))).toBe(true);
    expect(isDefinitivePreAcceptanceSendFailure(
      Object.assign(new Error('re-wrapped'), { code: NO_FUNDED_PUBLISHER_WALLET_CODE }),
    )).toBe(true);
    expect(isDefinitivePreAcceptanceSendFailure(
      new Error('No operational wallet has enough funds to publish'),
    )).toBe(true);

    // Excluded — each can correspond to a tx already in the mempool or mined.
    expect(isDefinitivePreAcceptanceSendFailure(new Error('nonce too low'))).toBe(false);
    expect(isDefinitivePreAcceptanceSendFailure(new Error('replacement transaction underpriced'))).toBe(false);
    expect(isDefinitivePreAcceptanceSendFailure(new Error('already known'))).toBe(false);
    expect(isDefinitivePreAcceptanceSendFailure(new Error('execution reverted: not authorized'))).toBe(false);
    expect(isDefinitivePreAcceptanceSendFailure(new Error('ETIMEDOUT: request timed out'))).toBe(false);
    expect(isDefinitivePreAcceptanceSendFailure(undefined)).toBe(false);
    // A revert is post-mempool even when its string contains "insufficient funds": excluded.
    expect(isDefinitivePreAcceptanceSendFailure(new Error('execution reverted: insufficient funds'))).toBe(false);
    expect(isDefinitivePreAcceptanceSendFailure(new Error('reverted: not enough; insufficient funds'))).toBe(false);

    // Throw-safe: an unstringifiable value, a throwing `code` accessor, and a throwing Proxy
    // are each classified non-definitive rather than throwing out of the classifier.
    expect(isDefinitivePreAcceptanceSendFailure(Object.create(null) as unknown)).toBe(false);
    expect(isDefinitivePreAcceptanceSendFailure(Symbol('opaque'))).toBe(false);
    expect(isDefinitivePreAcceptanceSendFailure(
      Object.defineProperty(new Error('x'), 'code', { get() { throw new Error('boom'); } }),
    )).toBe(false);
    expect(isDefinitivePreAcceptanceSendFailure(
      new Proxy({}, { get() { throw new Error('proxy trap'); } }),
    )).toBe(false);
  });

  // Whitelist ↔ mapper invariant — the classifier and mapPublishExceptionToLiftJobFailure are
  // kept as SEPARATE functions on purpose (the whitelist must stay conservative-by-construction
  // and must NOT silently widen if the mapper later gains new broadcast-phase codes; unifying
  // via the mapper would also reintroduce the throw path the classifier deliberately avoids).
  // This test pins their agreement without coupling: every whitelisted error maps to the
  // terminal insufficient_funds failure from the 'broadcast' state.
  it('every whitelisted error maps to a terminal insufficient_funds from broadcast', () => {
    const whitelisted: unknown[] = [
      new Error('insufficient funds for gas * price + value'),
      Object.assign(new Error('re-wrapped'), { code: NO_FUNDED_PUBLISHER_WALLET_CODE }),
      new Error('No operational wallet has enough funds to publish'),
    ];
    for (const error of whitelisted) {
      expect(isDefinitivePreAcceptanceSendFailure(error)).toBe(true);
      const failure = mapPublishExceptionToLiftJobFailure({
        error,
        failedFromState: 'broadcast',
        errorPayloadRef: 'urn:dkg:test:error',
      });
      expect(failure.code).toBe('insufficient_funds');
      expect(failure.mode).toBe('terminal');
      expect(failure.retryable).toBe(false);
    }
  });

  // GH#2270 — the RAW LIFT path took no pre-send write-ahead at all. It handed
  // `prepared.publishOptions` to the executor untouched, so the `chain:txsigned:tx-<hash>`
  // breadcrumb the chain adapter fires with the SIGNED hash, strictly before the tx goes on
  // the wire, had no listener. A daemon that died anywhere in the send window left the job at
  // 'validated' with nothing on disk naming the transaction: recover() reset it to 'accepted'
  // and the next attempt published the same content under a fresh hash while the first was
  // still in flight. It now runs through the SAME `createPreSendBroadcastRecorder` KA VM
  // publish has used since #1864 — one implementation, not a second copy.
  //
  // Fail-before: with the recorder unwired (the executor handed `prepared.publishOptions`
  // again), five of the six rows below go red — every one whose assertion is about the hash
  // being on disk before the send. The sixth ('finalizes normally') is the no-regression row
  // and passes either way by design: it pins that finalizing THROUGH a pre-recorded
  // 'broadcast' still works, which is only a claim once the record exists.
  describe('raw lift takes the same pre-send write-ahead [GH#2270]', () => {
    // A raw-lift request over the SAME staged KA share snapshot the VM-publish rows use, so
    // the two paths are compared on identical content and the only variable is the path.
    function rawLiftRequest(overrides: Partial<RawLiftRequest> = {}): RawLiftRequest {
      return {
        swmId: 'swm-1',
        namespace: 'default',
        contextGraphId: 'music-social',
        shareOperationId: 'share-op-1',
        roots: [],
        contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal: KA_VM_KA_UAL,
        assertionVersion: '1',
        publicTripleCount: 2,
        privateTripleCount: 0,
        scope: 'full',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
        ...overrides,
      };
    }

    // Raw lift has no runtime enqueue (legacy, read-only), so seed the persisted record
    // through the same importer offline migrations use.
    async function seedRawLift(
      targetStore: OxigraphStore,
      overrides: Partial<RawLiftRequest> = {},
    ): Promise<string> {
      return await seedLegacyRawLiftTestJob(targetStore, rawLiftRequest(overrides), {
        now: () => ++now,
        idGenerator: () => `job-${++ids}`,
      });
    }

    /** A raw-lift executor that fires the pre-send write-ahead, then stops before the send. */
    function firesRawBroadcastThenStops(
      txHash: string = TX_HASH,
    ): NonNullable<AsyncLiftPublisherConfig['publishExecutor']> {
      return async (input) => {
        await input.publishOptions.onPhase?.(`chain:txsigned:tx-${txHash}`, 'start');
        throw new Error('stop after the durable write-ahead');
      };
    }

    function expectFailed(job: LiftJob | null | undefined): PersistedFailedJob {
      if (!job || job.status !== 'failed') {
        throw new Error(`expected a failed job, got ${job?.status ?? 'null'}`);
      }
      return job;
    }

    it('persists the signed txHash before the send, so the failure carries evidence', async () => {
      const publisher = createPublisher(store, { publishExecutor: firesRawBroadcastThenStops() });

      await stageShareSnapshot(store);
      const jobId = await seedRawLift(store);
      const processed = expectFailed(await publisher.processNext('wallet-1'));

      // The hash the executor signed is on the job — before the change there was no
      // `broadcast` metadata at all, because nothing listened to the phase.
      expect(processed.broadcast?.txHash).toBe(TX_HASH);
      expect(processed.broadcast?.walletId).toBe('wallet-1');
      expect(processed.failure.failedFromState).toBe('broadcast');

      // And that hash is what PR-2's policy reads: the job is now HELD for chain proof
      // instead of being freely reset and resent. This is the whole point of the record.
      expect(hasBroadcastEvidence(processed)).toBe(true);
      expect(isHeldForChainProof(processed)).toBe(true);

      const persisted = expectFailed(await publisher.getStatus(jobId));
      expect(persisted.broadcast?.txHash).toBe(TX_HASH);
      expect(isHeldForChainProof(persisted)).toBe(true);
    });

    it('has the txHash on disk DURING the send window, read from a second store handle', async () => {
      // The crash the write-ahead exists for happens between the record and the send — not
      // after the executor returns. Read the durable state from a SEPARATE store opened on
      // the same path at exactly that instant: this is what a killed daemon's disk holds.
      // Pre-#2270 it read back 'validated' with no transaction named anywhere, which is what
      // made recover() reset the job and re-publish it.
      const dir = mkdtempSync(join(tmpdir(), 'raw-lift-broadcast-durability-'));
      tempDirs.push(dir);
      const persistPath = join(dir, 'store.nq');

      const store1 = new OxigraphStore(persistPath);
      let crashWindowJob: LiftJob | null = null;
      const publisher1 = createPublisher(store1, {
        publishExecutor: async (input) => {
          await input.publishOptions.onPhase?.(`chain:txsigned:tx-${TX_HASH}`, 'start');
          // The tx would be on the wire on the next line.
          crashWindowJob = await createPublisher(new OxigraphStore(persistPath)).getStatus(jobId);
          throw new Error('daemon died in the send window');
        },
      });

      await stageShareSnapshot(store1);
      const jobId = await seedRawLift(store1);
      await publisher1.processNext('wallet-1');

      const crashed = crashWindowJob as LiftJob | null;
      expect(crashed?.status).toBe('broadcast');
      expect(crashed?.status).not.toBe('validated');
      expect(crashed?.broadcast?.txHash).toBe(TX_HASH);
    });

    it('fsyncs once at the pre-send boundary and not on the earlier transitions', async () => {
      // Durability is scoped to the write-ahead: accepted/claimed/validated must not fsync,
      // and the post-throw failure path must not add one either.
      let flushCount = 0;
      let flushCountBeforeBroadcast = -1;
      const orig = store.flush?.bind(store);
      (store as unknown as { flush?: () => Promise<void> }).flush = async () => {
        flushCount += 1;
        await orig?.();
      };

      const publisher = createPublisher(store, {
        publishExecutor: async (input) => {
          flushCountBeforeBroadcast = flushCount;
          await input.publishOptions.onPhase?.(`chain:txsigned:tx-${TX_HASH}`, 'start');
          throw new Error('stop after the durable write-ahead');
        },
      });

      await stageShareSnapshot(store);
      await seedRawLift(store);
      await publisher.processNext('wallet-1');

      expect(flushCountBeforeBroadcast).toBe(0);
      expect(flushCount).toBe(1);
    });

    it('does not send or leave evidence when the write-ahead fsync fails', async () => {
      // The rollback half of the boundary. The fsync runs AFTER the in-memory 'broadcast'
      // transition, so a failure there must restore the pre-broadcast job: the adapter fails
      // closed and never sends, and a job that carried a txHash would be held for a chain
      // proof of a transaction that does not exist.
      let sent = false;
      const publisher = createPublisher(store, {
        publishExecutor: async (input) => {
          try {
            await input.publishOptions.onPhase?.(`chain:txsigned:tx-${TX_HASH}`, 'start');
          } catch (hookErr) {
            // The adapter's fail-closed rewrap: a rejected write-ahead aborts the broadcast.
            throw new Error(
              `chain:writeahead hook failed before publish broadcast: ${(hookErr as Error).message}`,
            );
          }
          sent = true; // the real eth_sendRawTransaction — must NOT run
          throw new Error('unreachable: send happened after a failed write-ahead flush');
        },
      });
      (store as unknown as { flush?: () => Promise<void> }).flush = async () => {
        throw new Error('ENOSPC: no space left on device');
      };

      await stageShareSnapshot(store);
      const jobId = await seedRawLift(store);
      const processed = expectFailed(await publisher.processNext('wallet-1'));

      expect(sent).toBe(false);
      expect(processed.broadcast).toBeUndefined();
      // No transaction exists, so the job must stay off the chain-proof hold and remain
      // freely resettable — the pre-send-safe disposition.
      expect(hasBroadcastEvidence(processed)).toBe(false);
      expect(isHeldForChainProof(processed)).toBe(false);
      expect(processed.failure.resolution).toBe('reset_to_accepted');

      const persisted = expectFailed(await publisher.getStatus(jobId));
      expect(persisted.status).not.toBe('broadcast');
      expect(persisted.broadcast).toBeUndefined();
    });

    it('finalizes normally when the send succeeds, adopting the result merkle root', async () => {
      // The pre-send record carries no merkleRoot (raw lift has none before the send, unlike
      // the KA VM seal root), so this pins that the publish result still supplies it and the
      // job finalizes through the pre-recorded 'broadcast' state rather than stalling in it.
      const publisher = createPublisher(store, {
        publishExecutor: async (input) => {
          await input.publishOptions.onPhase?.(`chain:txsigned:tx-${TX_HASH}`, 'start');
          return {
            kaId: 11n,
            ual: 'did:dkg:mock:31337/0xdef/11',
            merkleRoot: new Uint8Array([0xde, 0xf0]),
            kaManifest: [],
            status: 'confirmed' as const,
            onChainResult: {
              batchId: 11n,
              startKAId: 11n,
              endKAId: 11n,
              // Same hash the write-ahead recorded — the send that follows a signed tx.
              txHash: TX_HASH,
              blockNumber: 77,
              blockTimestamp: 1700000077,
              publisherAddress: '0x2222222222222222222222222222222222222222',
            },
          };
        },
      });

      await stageShareSnapshot(store);
      const jobId = await seedRawLift(store);
      const processed = await publisher.processNext('wallet-1');

      expect(processed?.status).toBe('finalized');
      expect(processed?.broadcast?.txHash).toBe(TX_HASH);
      expect(processed?.broadcast?.merkleRoot).toBe('0xdef0');
      expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
    });

    it('refuses a publish result whose tx differs from the one recorded pre-send', async () => {
      // A guarantee raw lift only gains once the hash is recorded before the send: a result
      // naming a DIFFERENT transaction means a second tx was signed for this job, and
      // accepting it would overwrite the evidence for the first. The job stays failed, still
      // holding the hash actually recorded.
      const otherTx = `0x${'ef'.repeat(32)}`;
      // The premise. A sentinel that collided with the fixture's hash would turn this row
      // into an equality test and pass for the wrong reason (it did, with 'cd').
      expect(otherTx).not.toBe(TX_HASH);
      const publisher = createPublisher(store, {
        publishExecutor: async (input) => {
          await input.publishOptions.onPhase?.(`chain:txsigned:tx-${TX_HASH}`, 'start');
          return {
            kaId: 11n,
            ual: 'did:dkg:mock:31337/0xdef/11',
            merkleRoot: new Uint8Array([0xde, 0xf0]),
            kaManifest: [],
            status: 'confirmed' as const,
            onChainResult: {
              batchId: 11n,
              startKAId: 11n,
              endKAId: 11n,
              txHash: otherTx,
              blockNumber: 77,
              blockTimestamp: 1700000077,
              publisherAddress: '0x2222222222222222222222222222222222222222',
            },
          };
        },
      });

      await stageShareSnapshot(store);
      const jobId = await seedRawLift(store);
      const processed = expectFailed(await publisher.processNext('wallet-1'));

      expect(processed.failure.message).toContain(otherTx);
      expect(processed.broadcast?.txHash).toBe(TX_HASH);
      expect(processed.broadcast?.txHash).not.toBe(otherTx);
      expect(isHeldForChainProof(expectFailed(await publisher.getStatus(jobId)))).toBe(true);
    });
  });
});
