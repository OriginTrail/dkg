/**
 * Publish ordering / write-ahead txHash / RPC spy tests (Hardhat).
 *
 * Audit findings covered:
 *
 *   P-1 (CRITICAL) — Write-ahead txHash persistence. Spec axiom 4 and
 *                    §06 require the node to persist its upcoming
 *                    transaction hash to a durable control-plane
 *                    record BEFORE the `eth_sendRawTransaction` RPC
 *                    call is made. Without this, a crash between
 *                    "tx on wire" and "receipt observed" leaves the
 *                    node unable to resume safely (it can't tell if
 *                    the tx it broadcast ever hit a block, and will
 *                    retry — double-submit). The DKGPublisher emits
 *                    phase events but does not expose a txHash at any
 *                    point before `chain:submit:end`; that is the bug.
 *                    The test spies on the JSON-RPC `send` method of
 *                    the adapter's provider, captures the observed
 *                    phase timeline at the moment of the send, and
 *                    asserts that a txHash DID appear on the phase
 *                    log before the send. Currently no such event
 *                    exists → RED → PROD-BUG evidence.
 *
 *   P-6 (HIGH)     — SWM-before-chain ordering. Spec axiom 4: the
 *                    local store write MUST complete before any
 *                    on-chain RPC is observed. We instrument both
 *                    sides: wrap `store.insert` to record insertion
 *                    timestamps, patch `provider.send` to record RPC
 *                    calls. Assert the store completion strictly
 *                    precedes the first `eth_sendRawTransaction`.
 *
 *   P-7 (HIGH)     — Sync-mode wallet claim. Two publishes in
 *                    succession on the same publisher must NOT issue
 *                    overlapping `eth_sendRawTransaction` calls with
 *                    the same nonce. Serialize via the publisher's
 *                    per-(cgId, subGraph) write lock. Even in sync
 *                    mode, the publisher must not race nonces with
 *                    itself.
 *
 * Per QA policy: no production code is touched. Failing assertions
 * ARE the bug evidence — see BUGS_FOUND.md P-1 / P-6 / P-7.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { DKGPublisher } from '../src/index.js';
import {
  createEVMAdapter,
  getSharedContext,
  createProvider,
  takeSnapshot,
  revertSnapshot,
  createTestContextGraph,
  HARDHAT_KEYS,
} from '../../chain/test/evm-test-context.js';
import {
  mintTokens,
  setMinimumRequiredSignatures,
} from '../../chain/test/hardhat-harness.js';

type WithProvider = { provider: ethers.JsonRpcProvider };

const ENTITY_PREFIX = 'urn:test:ordering:';

function q(s: string, p: string, o: string): Quad {
  return { subject: s, predicate: p, object: o, graph: '' };
}

interface RpcCallRecord {
  method: string;
  at: number;           // monotonic timestamp
  phaseLogSnapshot: string[]; // phases seen BEFORE this RPC call
}

interface StoreInsertRecord {
  at: number;
  count: number;
}

describe('Publish ordering & RPC spy — P-1 / P-6 / P-7', () => {
  let store: OxigraphStore;
  let snapshotId: string;
  let cgId: string;
  let publisher: DKGPublisher;
  let chainProvider: ethers.JsonRpcProvider;

  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    await setMinimumRequiredSignatures(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, 1);
    const wallet = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, wallet.address, ethers.parseEther('5000000'));

    const cgChain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const cgIdBn = await createTestContextGraph(cgChain);
    cgId = String(cgIdBn);
  }, 120_000);

  afterAll(async () => {
    await revertSnapshot(snapshotId);
  });

  beforeEach(async () => {
    store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    // The adapter creates its provider internally from rpcUrl. Reach
    // through the `provider` field explicitly — we don't mutate chain
    // state, only patch `send` to observe it.
    chainProvider = (chain as unknown as WithProvider).provider;
    const eventBus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus,
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
  });

  it('P-6: store.insert completes BEFORE the first eth_sendRawTransaction hits the wire', async () => {
    const storeInserts: StoreInsertRecord[] = [];
    const origInsert = store.insert.bind(store);
    store.insert = async (quads: Quad[]) => {
      const res = await origInsert(quads);
      storeInserts.push({ at: performance.now(), count: quads.length });
      return res;
    };

    const rpcCalls: RpcCallRecord[] = [];
    const phaseLog: string[] = [];

    // Capture provider.send on the adapter's provider for the duration
    // of this test. We spy on eth_sendRawTransaction AND eth_sendTransaction
    // so a hardhat-signed tx is still caught.
    const ourProvider = chainProvider;
    const origSend = ourProvider.send.bind(ourProvider);
    ourProvider.send = async (method: string, params: unknown[]) => {
      if (method === 'eth_sendRawTransaction' || method === 'eth_sendTransaction') {
        rpcCalls.push({
          method,
          at: performance.now(),
          phaseLogSnapshot: [...phaseLog],
        });
      }
      return origSend(method, params);
    };

    try {
      const result = await publisher.publish({
        contextGraphId: cgId,
        quads: [q(`${ENTITY_PREFIX}p6`, 'http://schema.org/name', '"P-6 Test"')],
        onPhase: (phase, event) => phaseLog.push(`${phase}:${event}`),
      });

      expect(result.status).toBe('confirmed');
      expect(rpcCalls.length).toBeGreaterThan(0);
      expect(storeInserts.length).toBeGreaterThan(0);

      // SPEC axiom 4: first store insert for the KC data must have
      // completed BEFORE the first eth_sendRawTransaction was issued.
      const firstSend = rpcCalls[0].at;
      const firstInsert = storeInserts[0].at;
      expect(firstInsert).toBeLessThan(firstSend);

      // Additional structural check: the phase log at the moment the
      // RPC fired must already contain `store:end`.
      expect(rpcCalls[0].phaseLogSnapshot).toContain('store:end');
    } finally {
      ourProvider.send = origSend;
    }
  }, 180_000);

  it(
    'PROD-BUG: P-1 write-ahead txHash — no phase event emits a txHash before the tx is broadcast. ' +
      'See BUGS_FOUND.md P-1.',
    async () => {
      const phaseLog: string[] = [];
      const rpcCalls: RpcCallRecord[] = [];
      const ourProvider = chainProvider;
      const origSend = ourProvider.send.bind(ourProvider);
      ourProvider.send = async (method: string, params: unknown[]) => {
        if (method === 'eth_sendRawTransaction' || method === 'eth_sendTransaction') {
          rpcCalls.push({
            method,
            at: performance.now(),
            phaseLogSnapshot: [...phaseLog],
          });
        }
        return origSend(method, params);
      };

      try {
        const result = await publisher.publish({
          contextGraphId: cgId,
          quads: [q(`${ENTITY_PREFIX}p1`, 'http://schema.org/name', '"P-1 Test"')],
          onPhase: (phase, event) => phaseLog.push(`${phase}:${event}`),
        });
        expect(result.status).toBe('confirmed');
        expect(rpcCalls.length).toBeGreaterThan(0);

        // Spec axiom 4 requires a `txHash persisted` / `journal write-ahead`
        // event that includes the pre-broadcast tx hash. Codex review on
        // PR #241 pointed out that a plain `chain:writeahead:start` /
        // `chain:writeahead:end` boundary (emitted around the adapter
        // send) does NOT satisfy this requirement — the phase name alone
        // cannot carry the hash — so the regex here is intentionally
        // txHash-/journal-specific to prevent the coarse boundary from
        // masquerading as a real write-ahead log entry.
        //
        // To flip this assertion green, the publisher needs to plumb a
        // real pre-broadcast hook (P-1.2): split the EVM adapter's
        // sign/broadcast flow and emit e.g. `chain:txsigned` with the
        // signed txHash BEFORE `eth_sendRawTransaction`. Until that
        // ships, this test stays RED and the bug remains documented in
        // BUGS_FOUND.md P-1.
        const snapshot = rpcCalls[0].phaseLogSnapshot;
        const hasTxHashPreSend = snapshot.some((p) =>
          /tx(hash|signed)|journal:write-?ahead|pre-?send/i.test(p),
        );
        // PROD-BUG: expected `true`, currently `false` → write-ahead missing.
        expect(hasTxHashPreSend).toBe(true);
      } finally {
        ourProvider.send = origSend;
      }
    },
    180_000,
  );

  it('P-7: two sequential publishes on the same publisher serialize their chain txs (no nonce race)', async () => {
    const rpcCalls: RpcCallRecord[] = [];
    const ourProvider = chainProvider;
    const origSend = ourProvider.send.bind(ourProvider);
    // Track the nonces of every broadcast tx so a conflict is easy to
    // spot: two eth_sendRawTransaction calls with the same (nonce, from)
    // would indicate a race.
    const broadcastNonces: number[] = [];
    ourProvider.send = async (method: string, params: unknown[]) => {
      const result = await origSend(method, params);
      if (method === 'eth_sendRawTransaction' && Array.isArray(params) && typeof params[0] === 'string') {
        try {
          const tx = ethers.Transaction.from(params[0]);
          if (tx.nonce !== undefined && tx.nonce !== null) {
            broadcastNonces.push(Number(tx.nonce));
          }
        } catch {
          // not a parseable tx — ignore
        }
        rpcCalls.push({
          method,
          at: performance.now(),
          phaseLogSnapshot: [],
        });
      }
      return result;
    };

    try {
      // Two publishes for different entities → two independent chain
      // txs, both from the same publisher wallet. If sync mode does not
      // claim the wallet lease, a nonce collision will surface as two
      // broadcasts with the same nonce.
      const a = await publisher.publish({
        contextGraphId: cgId,
        quads: [q(`${ENTITY_PREFIX}p7-a`, 'http://schema.org/name', '"P-7 A"')],
      });
      const b = await publisher.publish({
        contextGraphId: cgId,
        quads: [q(`${ENTITY_PREFIX}p7-b`, 'http://schema.org/name', '"P-7 B"')],
      });

      expect(a.status).toBe('confirmed');
      expect(b.status).toBe('confirmed');

      // Nonces for the two publishDirect tx must be distinct.
      // (publishDirect itself may be preceded by an allowance tx — that's
      // fine; we just require no DUPLICATES across the whole run.)
      const dedup = new Set(broadcastNonces);
      expect(dedup.size).toBe(broadcastNonces.length);

      // If we saw at least 2 publishDirect tx, their nonces must be
      // monotonically increasing.
      if (broadcastNonces.length >= 2) {
        for (let i = 1; i < broadcastNonces.length; i++) {
          expect(broadcastNonces[i]).toBeGreaterThan(broadcastNonces[i - 1]);
        }
      }
    } finally {
      ourProvider.send = origSend;
    }
  }, 240_000);
});
