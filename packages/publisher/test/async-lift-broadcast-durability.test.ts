import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NO_FUNDED_PUBLISHER_WALLET_CODE } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncLiftPublisher,
  isDefinitivePreAcceptanceSendFailure,
  type AsyncLiftPublisherConfig,
} from '../src/index.js';
import {
  DEFAULT_JOURNAL_GRAPH_URI,
  JOURNAL_SEQ,
  JOURNAL_KIND,
  parseIntegerLiteral,
  parseLiteral,
} from '../src/async-lift-control-plane.js';
import {
  KA_VM_EXECUTOR_TX_HASH,
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

  // #1867 (deliberate, LOCKED edge) — a mined-then-reverted tx whose revert string happens
  // to contain "insufficient funds" is classified pre-acceptance terminal. This is an
  // ACCEPTED consequence of the substring match: it mirrors classifyPublishFailureCode
  // exactly (the mapper would assign insufficient_funds either way), and a revert is a
  // failure on both the classifier and recovery paths — recovery would only terminate it
  // later with a different code. The go-ethereum pre-check message is a node-level reject,
  // not a Solidity revert, so this collision is not realistic for the publish call; the
  // decision is intentional, not accidental. Do NOT "fix" this by excluding reverts.
  it('classifies a revert message that contains "insufficient funds" as pre-acceptance terminal (accepted edge)', async () => {
    const publisher = createPublisher(store, {
      knowledgeAssetVmPublishHandler: firesBroadcastThenThrows(
        new Error('execution reverted: insufficient funds'),
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
  });
});
