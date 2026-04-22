/**
 * Per-Context-Graph publish quorum (`requiredSignatures`) enforcement.
 *
 * Audit findings covered:
 *   A-5 (HIGH / PROD-BUG duplicate of TORNADO #4) — dkgv10-spec §06_PUBLISH
 *       says each Context Graph carries a governance parameter,
 *       `requiredSignatures`, which is the minimum number of participant
 *       ACKs a publish to that CG must collect before it is confirmed on
 *       chain. Today, `DKGAgent.publishFromSharedMemory` honors ONLY the
 *       global `ParametersStorage.minimumRequiredSignatures` — the per-CG
 *       `requiredSignatures` is ignored at publish time (it's only used
 *       for context-graph governance).
 *
 *       This test reproduces the spec violation by:
 *         1. Registering a CG on-chain with `requiredSignatures: 2`.
 *         2. Sharing data from the SOLE node on the network (so only
 *            1 ACK — the self-signed one — is collectable).
 *         3. Publishing from SWM → the test asserts `status: 'tentative'`
 *            (spec-correct: insufficient signatures → fallback to SWM-only)
 *            while the current implementation returns `'confirmed'`.
 *
 *       The failure is the direct evidence for BUGS_FOUND.md A-5.
 *
 * Paired commentary at `packages/agent/test/e2e-publish-protocol.test.ts`
 * §5 already documents the behaviour but asserts the (wrong) confirmed
 * outcome. This file asserts the SPEC outcome so regressions in either
 * direction are visible.
 *
 * No mocks — real chain, real publisher.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
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

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

let _fileSnapshot: string;
let nodeA: DKGAgent | undefined;

const PARANET = `per-cg-quorum-${ethers.hexlify(ethers.randomBytes(4)).slice(2)}`;
const ENTITY = 'urn:a5:quorum:entity';

beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(
    provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('1000000'),
  );

  nodeA = await DKGAgent.create({
    name: 'QuorumNodeA',
    listenPort: 0,
    skills: [],
    chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    nodeRole: 'core',
  });
  await nodeA.start();
  await sleep(300);
});

afterAll(async () => {
  try { await nodeA?.stop(); } catch { /* */ }
  await revertSnapshot(_fileSnapshot);
});

describe('A-5: per-CG `requiredSignatures` gates publish (PROD-BUG: currently ignored)', () => {
  it('publish to a CG with requiredSignatures=2, but only 1 ACK available → must be tentative', async () => {
    const ctx = getSharedContext();
    await nodeA!.createContextGraph({ id: PARANET, name: 'Quorum Test', description: '' });
    nodeA!.subscribeToContextGraph(PARANET);

    // Register the CG on-chain with a 2-of-N quorum. Per spec §06 a publish
    // to this CG must collect at least 2 participant signatures before it
    // can confirm on chain. The second participant identity is a real
    // receiver identity, but the receiver node is NOT running → so no ACK
    // will ever be collected from it.
    const cgResult = await nodeA!.registerContextGraphOnChain({
      participantIdentityIds: [BigInt(ctx.coreProfileId), BigInt(ctx.receiverIds[0])],
      requiredSignatures: 2,
    });
    const cgOnChainId = cgResult.contextGraphId;

    await nodeA!.share(PARANET, [
      {
        subject: ENTITY,
        predicate: 'http://schema.org/name',
        object: '"Quorum-Gated Data"',
        graph: '',
      },
    ]);

    const result = await nodeA!.publishFromSharedMemory(
      PARANET,
      { rootEntities: [ENTITY] },
      { subContextGraphId: cgOnChainId },
    );

    // SPEC-correct assertion: with only the self-signed ACK and a CG-level
    // quorum of 2, the publish must NOT confirm — it falls back to
    // tentative (SWM-only). The existing `e2e-publish-protocol.test.ts §5`
    // currently asserts `confirmed` to match buggy behaviour. See
    // BUGS_FOUND.md A-5. Expected to go RED.
    expect(
      result.status,
      'per-CG requiredSignatures is ignored at publish time (BUGS_FOUND.md A-5)',
    ).toBe('tentative');
  });

  it('publish to a CG with requiredSignatures=1 is confirmed (self-ACK satisfies the per-CG quorum)', async () => {
    const cgId = `${PARANET}-q1-${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`;
    const entity = `urn:a5:q1:entity-${ethers.hexlify(ethers.randomBytes(3)).slice(2)}`;
    const ctx = getSharedContext();

    await nodeA!.createContextGraph({ id: cgId, name: 'Quorum=1 Test', description: '' });
    nodeA!.subscribeToContextGraph(cgId);

    const cgResult = await nodeA!.registerContextGraphOnChain({
      participantIdentityIds: [BigInt(ctx.coreProfileId)],
      requiredSignatures: 1,
    });

    await nodeA!.share(cgId, [
      { subject: entity, predicate: 'http://schema.org/name', object: '"Q1 Data"', graph: '' },
    ]);

    const result = await nodeA!.publishFromSharedMemory(
      cgId,
      { rootEntities: [entity] },
      { subContextGraphId: cgResult.contextGraphId },
    );

    // This direction (requiredSignatures=1, 1 ACK) must always confirm —
    // both under the buggy global-only gate and the spec-correct per-CG
    // gate. It serves as a regression anchor: if this flips to tentative,
    // the implementation has over-corrected. See BUGS_FOUND.md A-5.
    expect(result.status).toBe('confirmed');
  });
});
