/**
 * Finalization-handler promotion — real chain, real data, real promotion.
 *
 * Audit findings covered:
 *   A-4 (CRITICAL / POSSIBLE PROD-BUG) — the existing test
 *       `finalization-handler.test.ts` "promotes workspace data to canonical
 *       when merkle matches (no chain adapter)" is misleading: it builds
 *       a `FinalizationHandler` with `chain: undefined`, which makes
 *       `verifyOnChain()` return false synchronously, so the promotion
 *       branch is never taken. The test name claims promotion happens;
 *       the assertion verifies it *doesn't*. That flipped-name coverage
 *       is the A-4 finding.
 *
 *   This file fills the gap in two directions:
 *
 *     1. Direct invariant test: call `promoteSharedMemoryToCanonical`
 *        (private method, accessed via the same test-only reflection the
 *        existing backfill test uses) without a sub-graph name, and
 *        assert the data ends up in the canonical data graph. This pins
 *        the promotion contract irrespective of the chain.
 *
 *     2. Full e2e test: publish real data via `DKGAgent#publish()` against
 *        Hardhat, then query the `view:'verified-memory'` canonical graph
 *        and assert the published data is observable. If the full pipeline
 *        ever stops promoting confirmed data out of SWM and into canonical
 *        (the A-4 prod-bug suspicion), this test catches it immediately.
 *
 * No mocks — real `FinalizationHandler`, real store, real `DKGAgent`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { FinalizationHandler } from '../src/finalization-handler.js';
import { DKGAgent } from '../src/index.js';
import {
  HARDHAT_KEYS,
  createEVMAdapter,
  createProvider,
  getSharedContext,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';

const PARANET = `a4-finalize-${ethers.hexlify(ethers.randomBytes(4)).slice(2)}`;

let _fileSnapshot: string;
let nodeA: DKGAgent | undefined;

beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(
    provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('1000000'),
  );
  nodeA = await DKGAgent.create({
    name: 'A4Promoter',
    listenPort: 0,
    skills: [],
    chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    nodeRole: 'core',
  });
  await nodeA.start();
});

afterAll(async () => {
  try { await nodeA?.stop(); } catch { /* */ }
  await revertSnapshot(_fileSnapshot);
});

describe('A-4: promoteSharedMemoryToCanonical lands data in the CANONICAL data graph', () => {
  it('writes SWM quads into `did:dkg:context-graph:<id>` when no sub-graph is set', async () => {
    const store = new OxigraphStore();
    const handler = new FinalizationHandler(store, undefined);
    const entity = 'urn:a4:alice';
    const publisher = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    const dataGraph = `did:dkg:context-graph:${PARANET}`;

    // Seed workspace memory that would be promoted. Not strictly required
    // since the promote method takes quads as an argument, but mirrors
    // how the handler is fed in production.
    const quads = [
      { subject: entity, predicate: 'http://schema.org/name', object: '"Alice-A4"', graph: '' },
    ];

    await (handler as any).promoteSharedMemoryToCanonical(
      PARANET,
      quads,
      'did:dkg:evm:31337/0xA4/1',
      [entity],
      publisher,
      '0x' + 'ab'.repeat(32),
      100,
      1n, 1n, 1n,
      createOperationContext('system'),
      undefined, // ctxGraphId
      undefined, // subGraphName → canonical default graph
    );

    const result = await store.query(
      `ASK { GRAPH <${dataGraph}> { <${entity}> <http://schema.org/name> "Alice-A4" } }`,
    );
    expect(result.type).toBe('boolean');
    if (result.type === 'boolean') {
      expect(
        result.value,
        'promoteSharedMemoryToCanonical must write the quad into the canonical data graph',
      ).toBe(true);
    }
  });
});

describe('A-4: e2e — agent.publish() data lands in canonical (verified-memory) view', () => {
  it('published data is observable via query(view:"verified-memory") on the publisher', async () => {
    const cgId = `a4-e2e-${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`;
    const entity = `urn:a4:e2e:${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`;

    await nodeA!.createContextGraph({ id: cgId, name: 'A4 E2E', description: '' });
    await nodeA!.registerContextGraph(cgId);

    const pub = await nodeA!.publish(cgId, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"E2E-A4"', graph: '' },
    ]);
    expect(pub.status, 'publish must confirm for the promotion invariant to apply').toBe('confirmed');

    // Canonical/verified memory must contain the published triple. If this
    // returns 0 bindings, the agent layer is stuck in SWM — A-4's suspected
    // PROD-BUG would be confirmed.
    const qr = await nodeA!.query(
      `SELECT ?o WHERE { <${entity}> <http://schema.org/name> ?o }`,
      { contextGraphId: cgId, view: 'verified-memory' },
    );
    expect(
      qr.bindings.length,
      'canonical (verified-memory) graph must contain the published triple after confirmed publish',
    ).toBe(1);
    expect(qr.bindings[0]['o']).toBe('"E2E-A4"');

    // And the same data MUST NOT remain in SWM post-confirmation —
    // leaving it there would be a double-counting leak.
    const swmQr = await nodeA!.query(
      `SELECT ?o WHERE { <${entity}> <http://schema.org/name> ?o }`,
      { contextGraphId: cgId, view: 'shared-working-memory' },
    );
    expect(
      swmQr.bindings.length,
      'SWM must be cleared after confirmed publish — lingering quads indicate a failed promotion cleanup',
    ).toBe(0);
  });
});
