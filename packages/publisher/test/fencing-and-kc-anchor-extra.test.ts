/**
 * Fencing-token + kcMerkleRoot chain-anchor tests.
 *
 * Audit findings covered:
 *
 *   P-2  (CRITICAL) — Fencing token / stale-worker double-broadcast.
 *                     Spec §06 + control-plane axiom: after a health-
 *                     check clears a worker's wallet lock (e.g. the
 *                     worker is declared dead by a heartbeat sweep or
 *                     operator reset), any subsequent call into the
 *                     lift-job publisher from that worker's context
 *                     MUST be fenced: the per-job claim token from
 *                     the caller has to be re-validated against the
 *                     current wallet lock, and any write that doesn't
 *                     match MUST be rejected. Otherwise a stale worker
 *                     can still flip `claimed → validated → broadcast`
 *                     on a job a fresh worker has taken over, leading
 *                     to a double-broadcast on-chain.
 *
 *                     The current `TripleStoreAsyncLiftPublisher.update`
 *                     implementation takes only `(jobId, status, data)`;
 *                     it does NOT take (and therefore cannot verify) a
 *                     caller claim token, and it does not re-read the
 *                     wallet lock to cross-check the job's stored claim
 *                     token before mutating. The tests below pin this
 *                     behavior as a RED regression.
 *
 *   P-19 (LOW)      — kcMerkleRoot chain-anchor mismatch → no
 *                     promotion. Spec §9.0.5: when a KnowledgeBatchCreated
 *                     event is observed, the publisher MUST compare the
 *                     on-chain merkle root with the pending publish's
 *                     locally computed expected root before promoting
 *                     tentative → confirmed. A mismatch means a different
 *                     batch was anchored (adversarial or race) and the
 *                     node must NOT promote its own tentative data. This
 *                     is a pinning / regression test that guarantees
 *                     `PublishHandler.confirmPublish` returns false and
 *                     does NOT insert a confirmed-status quad when the
 *                     on-chain root does not match.
 *
 * Per QA policy: production code is not modified. Where a failing
 * assertion encodes a spec violation, it IS the bug evidence and is
 * tagged `PROD-BUG:` in-line.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  TypedEventBus,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import {
  TripleStoreAsyncLiftPublisher,
  type LiftRequest,
} from '../src/index.js';
import {
  DEFAULT_WALLET_LOCK_GRAPH_URI,
  walletLockSubject,
} from '../src/async-lift-control-plane.js';
import { PublishHandler } from '../src/publish-handler.js';

// ────────────────────────────────────────────────────────────────────────────
// P-2: fencing token — stale worker broadcast must be rejected
// ────────────────────────────────────────────────────────────────────────────

describe('P-2 (CRITICAL): fencing token — stale worker after health-check reset', () => {
  let store: OxigraphStore;
  let now = 1_000;
  let idCounter = 0;

  const nextNow = () => ++now;
  const nextId = () => `job-${++idCounter}`;

  function request(): LiftRequest {
    return {
      swmId: 'swm-1',
      shareOperationId: 'op-1',
      roots: ['urn:local:/fence'],
      contextGraphId: 'cg-fence',
      namespace: 'ns-fence',
      scope: 'person-profile',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof:owner:1' },
    };
  }

  function createPublisher() {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: nextNow,
      idGenerator: nextId,
    });
  }

  async function walletLockRowCount(walletId: string): Promise<number> {
    const res = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> { <${walletLockSubject(walletId)}> ?p ?o } }`,
    );
    return res.type === 'bindings' ? res.bindings.length : 0;
  }

  async function deleteWalletLockOutOfBand(walletId: string): Promise<void> {
    // Simulate what a health-check sweep or control-plane operator
    // would do: drop the active wallet lock for a worker the cluster
    // no longer considers live. We reach directly into the store here
    // because, per spec, the publisher must treat the on-disk lock as
    // the single source of truth for which worker can mutate a job.
    const subj = walletLockSubject(walletId);
    const res = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> { <${subj}> ?p ?o } }`,
    );
    if (res.type !== 'bindings') return;
    const quads: Quad[] = res.bindings.map((row) => ({
      subject: subj,
      predicate: (row['p'] as string).replace(/^<|>$/g, ''),
      object: row['o'] as string,
      graph: DEFAULT_WALLET_LOCK_GRAPH_URI,
    }));
    if (quads.length > 0) await store.delete(quads);
  }

  beforeEach(() => {
    store = new OxigraphStore();
    now = 1_000;
    idCounter = 0;
  });

  it('baseline: a healthy claim produces an active wallet lock', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.lift(request());
    const claimed = await publisher.claimNext('wallet-A');
    expect(claimed).not.toBeNull();
    expect(claimed?.jobId).toBe(jobId);
    expect(claimed?.claim?.walletId).toBe('wallet-A');
    expect(claimed?.claim?.claimToken).toBeTruthy();
    expect(await walletLockRowCount('wallet-A')).toBeGreaterThan(0);
  });

  it(
    'PROD-BUG: after the wallet lock is cleared, a stale worker can still ' +
      'flip `claimed → validated` on its own job — update() has no fence on ' +
      'the caller claim token. See BUGS_FOUND.md P-2.',
    async () => {
      const publisher = createPublisher();
      const jobId = await publisher.lift(request());
      const claimed = await publisher.claimNext('wallet-A');
      expect(claimed?.claim?.claimToken).toBeTruthy();
      expect(await walletLockRowCount('wallet-A')).toBeGreaterThan(0);

      // Health-check reset: external control-plane observes wallet-A
      // as dead and removes its lock. Any subsequent mutation from
      // wallet-A is by definition coming from a stale worker.
      await deleteWalletLockOutOfBand('wallet-A');
      expect(await walletLockRowCount('wallet-A')).toBe(0);

      // Stale worker-A still holds the jobId in-memory and tries to
      // push the FSM forward. Per spec this must be rejected with a
      // fence / stale-lease error. Currently update() has no claim-
      // token argument and does not re-read the lock before writing,
      // so this call silently succeeds → documented PROD-BUG.
      let caught: unknown = null;
      try {
        await publisher.update(jobId, 'validated', {
          validation: {
            canonicalRoots: ['dkg:cg-fence:ns-fence:person/x'],
            canonicalRootMap: { 'urn:local:/fence': 'dkg:cg-fence:ns-fence:person/x' },
            swmQuadCount: 1,
            authorityProofRef: 'proof:owner:1',
            transitionType: 'CREATE',
          },
        });
      } catch (err) {
        caught = err;
      }

      // Expected (spec): update from stale worker is rejected.
      expect(
        caught,
        'PROD-BUG: stale update after lock reset should throw a fencing error ' +
          '(e.g. "stale_claim", "fence_token_mismatch"). Currently succeeds.',
      ).toBeInstanceOf(Error);
      if (caught instanceof Error) {
        expect(caught.message).toMatch(/fenc|stale|lock|claim/i);
      }
    },
  );

  it('PROD-BUG: update() accepts an in-memory LiftJob even when the on-disk claim token has been overwritten by a different worker', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.lift(request());
    const claimedByA = await publisher.claimNext('wallet-A');
    expect(claimedByA).not.toBeNull();
    const originalTokenA = claimedByA?.claim?.claimToken;
    expect(originalTokenA).toBeTruthy();

    // Simulate health-check sweep + takeover: wipe wallet-A's lock,
    // then put the job back into `accepted` so a different wallet can
    // legitimately re-claim it.
    await deleteWalletLockOutOfBand('wallet-A');
    // Force the FSM back to `accepted` by manually overwriting the
    // status quad via the claimed snapshot. We do this through the
    // supported `update()` path only for the PURPOSE of resetting —
    // in a real node this would happen through an async-lift recovery.
    // We intentionally do NOT use recover() here because that would
    // release wallet-A's lease via the happy path.
    // ---
    // Instead, we re-drive the job directly with the API: it does not
    // expose a "reset" so the realistic simulation is "wallet-B claims
    // a fresh job" in the same store, sharing the control plane. For
    // the fencing-token scope we only need to verify that stale wallet-
    // A's update is unconditionally accepted — the presence of a second
    // worker is not required for the assertion below to be meaningful.
    // The claim token persisted on the job is still wallet-A's; the
    // lock however is gone. Per spec this is already "stale".
    let caughtStale: unknown = null;
    try {
      await publisher.update(jobId, 'validated', {
        validation: {
          canonicalRoots: ['dkg:cg-fence:ns-fence:person/y'],
          canonicalRootMap: { 'urn:local:/fence': 'dkg:cg-fence:ns-fence:person/y' },
          swmQuadCount: 1,
          authorityProofRef: 'proof:owner:1',
          transitionType: 'CREATE',
        },
      });
    } catch (err) {
      caughtStale = err;
    }
    // FIXED (BUGS_FOUND.md P-2): update() now refuses to mutate a job
    // when the caller's wallet lock has been cleared by the control
    // plane, and `syncWalletLockForJob` no longer silently resurrects
    // the lock during refresh. The spec invariant is therefore that
    // BOTH of these facts must hold simultaneously after the
    // out-of-band wallet-lock delete:
    //   1. the stale update is rejected with a fencing error, and
    //   2. the wallet lock stays cleared.
    expect(
      caughtStale,
      'FIXED: stale wallet-A update must be rejected with a fencing error.',
    ).toBeInstanceOf(Error);
    if (caughtStale instanceof Error) {
      expect(caughtStale.message).toMatch(/fenc|stale|lock|claim/i);
    }
    expect(
      await walletLockRowCount('wallet-A'),
      'FIXED: a fenced update must NOT silently recreate a control-plane-cleared lock.',
    ).toBe(0);

    const staleWriteAccepted = caughtStale === null;
    const lockSilentlyRecreated = (await walletLockRowCount('wallet-A')) > 0;
    // Spec axiom — neither failure mode may hold after the fix.
    expect(
      staleWriteAccepted && lockSilentlyRecreated,
      'FIXED: stale worker is rejected and the cleared wallet lock is preserved.',
    ).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P-19: kcMerkleRoot chain-anchor mismatch → no tentative → confirmed promotion
// ────────────────────────────────────────────────────────────────────────────

describe('P-19 (LOW): kcMerkleRoot chain-anchor mismatch — no VM promotion', () => {
  const CGID = 'cg-anchor-test';
  const UAL = `did:dkg:kc:${CGID}:test:1`;
  const GRAPH = `did:dkg:context-graph:${CGID}`;

  function makePendingHandler() {
    const store = new OxigraphStore();
    const eventBus = new TypedEventBus();
    const handler = new PublishHandler(store, eventBus);
    return { store, handler };
  }

  it('confirmPublish with on-chain merkleRoot that does NOT match the pending local root returns false and leaves no confirmed-status quad', async () => {
    const { store, handler } = makePendingHandler();

    // Seed a pending publish directly via the internal map. Private
    // test-only access is intentional — we are pinning the behavior
    // of the confirm check, not the ingest pipeline.
    const localMerkle = new Uint8Array(32).fill(0xaa);
    const onChainMerkle = new Uint8Array(32).fill(0xbb);
    const pending = {
      ual: UAL,
      contextGraphId: CGID,
      dataQuads: [] as Quad[],
      metadataQuads: [] as Quad[],
      timeout: setTimeout(() => {}, 60_000),
      expectedPublisherAddress: ethers.ZeroAddress,
      expectedMerkleRoot: localMerkle,
      expectedStartKAId: 1n,
      expectedEndKAId: 1n,
      expectedChainId: 'evm:31337',
      rootEntities: [] as string[],
      createdAt: Date.now(),
    };
    (handler as unknown as { pendingPublishes: Map<string, typeof pending> }).pendingPublishes.set(UAL, pending);

    const ctx = createOperationContext('publish-anchor-test');
    const confirmed = await handler.confirmPublish(
      UAL,
      {
        publisherAddress: ethers.ZeroAddress,
        merkleRoot: onChainMerkle,
        startKAId: 1n,
        endKAId: 1n,
      },
      ctx,
    );

    expect(confirmed).toBe(false);

    const confirmedRows = await store.query(
      `SELECT ?o WHERE { GRAPH <${GRAPH}> { <${UAL}> <http://dkg.io/ontology/status> ?o } }`,
    );
    const values =
      confirmedRows.type === 'bindings'
        ? confirmedRows.bindings.map((r) => r['o'] as string)
        : [];
    // Must not have promoted to confirmed.
    expect(values.some((v) => v.includes('confirmed'))).toBe(false);

    clearTimeout(pending.timeout);
  });

  it('confirmByMerkleRoot with a root that no pending publish expects returns false and promotes nothing', async () => {
    const { store, handler } = makePendingHandler();

    const localMerkle = new Uint8Array(32).fill(0xaa);
    const pending = {
      ual: UAL,
      contextGraphId: CGID,
      dataQuads: [] as Quad[],
      metadataQuads: [] as Quad[],
      timeout: setTimeout(() => {}, 60_000),
      expectedPublisherAddress: ethers.ZeroAddress,
      expectedMerkleRoot: localMerkle,
      expectedStartKAId: 1n,
      expectedEndKAId: 1n,
      expectedChainId: 'evm:31337',
      rootEntities: [] as string[],
      createdAt: Date.now(),
    };
    (handler as unknown as { pendingPublishes: Map<string, typeof pending> }).pendingPublishes.set(UAL, pending);

    const foreignMerkle = new Uint8Array(32).fill(0xcc);
    const confirmed = await handler.confirmByMerkleRoot(foreignMerkle, {
      publisherAddress: ethers.ZeroAddress,
      startKAId: 1n,
      endKAId: 1n,
      chainId: 'evm:31337',
    });

    expect(confirmed).toBe(false);

    const confirmedRows = await store.query(
      `SELECT ?o WHERE { GRAPH <${GRAPH}> { <${UAL}> <http://dkg.io/ontology/status> ?o } }`,
    );
    const values =
      confirmedRows.type === 'bindings'
        ? confirmedRows.bindings.map((r) => r['o'] as string)
        : [];
    expect(values.some((v) => v.includes('confirmed'))).toBe(false);

    clearTimeout(pending.timeout);
  });
});
