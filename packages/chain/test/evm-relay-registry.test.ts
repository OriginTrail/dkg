/**
 * EVMChainAdapter — Network State Registry surface (RFC 04 v0.3 / Issue #461).
 *
 * Drives getRelayCapable / setRelayCapable plus the RelayCapabilityUpdated
 * event emission against a real Hardhat node so we catch contract <-> ABI
 * <-> adapter drift in CI rather than at devnet bring-up time.
 *
 * Multiaddrs are NOT stored on Profile (RFC 04 §5.2) — an earlier revision
 * added them, removed in the v0.3 reconciliation patch.
 *
 * Each test takes a fresh snapshot so we can flip flags without leaking
 * state across tests.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import {
  createEVMAdapter,
  getSharedContext,
  takeSnapshot,
  revertSnapshot,
  HARDHAT_KEYS,
} from './evm-test-context.js';

let fileSnapshotId: string;
let testSnapshotId: string;

describe('EVMChainAdapter — relay registry surface', () => {
  beforeAll(async () => {
    fileSnapshotId = await takeSnapshot();
  });

  afterAll(async () => {
    await revertSnapshot(fileSnapshotId);
  });

  beforeEach(async () => {
    testSnapshotId = await takeSnapshot();
  });

  afterEach(async () => {
    await revertSnapshot(testSnapshotId);
  });

  it('reads default false for the seeded core profile', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const { coreProfileId } = getSharedContext();
    expect(await adapter.getRelayCapable!(BigInt(coreProfileId))).toBe(false);
  });

  it('round-trips relayCapable through setRelayCapable + getRelayCapable', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const { coreProfileId } = getSharedContext();
    const tx = await adapter.setRelayCapable!(true);
    expect(tx.success).toBe(true);
    expect(await adapter.getRelayCapable!(BigInt(coreProfileId))).toBe(true);
  });

  it('emits RelayCapabilityUpdated through listenForEvents', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const { coreProfileId } = getSharedContext();
    const fromBlock = (await adapter.getBlockNumber!()) + 1;

    await adapter.setRelayCapable!(true);

    const seen: Array<{ type: string; identityId: string }> = [];
    for await (const e of adapter.listenForEvents({
      eventTypes: ['RelayCapabilityUpdated'],
      fromBlock,
    })) {
      seen.push({ type: e.type, identityId: String(e.data.identityId) });
    }

    expect(seen).toEqual([
      { type: 'RelayCapabilityUpdated', identityId: String(coreProfileId) },
    ]);
  });
});
