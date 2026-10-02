// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { TypedEventBus } from '@origintrail-official/dkg-core';
import {
  StorageACKHandler,
  type StorageACKHandlerConfig,
} from '../src/storage-ack-handler.js';

const fakePeerId = { toString: () => 'publisher-peer' };

/**
 * PublishIntent and UpdateIntent both encode contextGraphId as protobuf field
 * 2 (length-delimited). Build that wire field directly so these regressions
 * exercise the untrusted decode boundary without going through a typed intent
 * builder or populating fields that must never be inspected for an invalid id.
 */
function rawStringFields(fields: readonly (readonly [number, string])[]): Uint8Array {
  const wire: number[] = [];
  for (const [fieldNumber, fieldValue] of fields) {
    const value = new TextEncoder().encode(fieldValue);
    const tag = fieldNumber * 8 + 2;
    if (tag >= 128 || value.length >= 128) {
      throw new Error('test helper only supports one-byte tags and lengths');
    }
    wire.push(tag, value.length, ...value);
  }
  return Uint8Array.from(wire);
}

function rawContextGraphIdIntent(contextGraphId: string): Uint8Array {
  return rawStringFields([[2, contextGraphId]]);
}

function createBoundaryHarness() {
  const storeEffects = {
    query: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    dropGraph: vi.fn(),
    deleteByPattern: vi.fn(),
    flush: vi.fn(),
  };
  const signMessage = vi.fn();
  const isSignerRegistered = vi.fn();
  const isCgCurated = vi.fn();
  const contextGraphSharedMemoryUri = vi.fn(
    (contextGraphId: string) => `did:dkg:context-graph:${contextGraphId}/_shared_memory`,
  );
  const config: StorageACKHandlerConfig = {
    nodeRole: 'core',
    nodeIdentityId: 42n,
    signerWallet: { signMessage } as never,
    contextGraphSharedMemoryUri,
    chainId: 31337n,
    kav10Address: '0x000000000000000000000000000000000000c10a',
    isSignerRegistered,
    isCgCurated,
  };
  const handler = new StorageACKHandler(
    storeEffects as never,
    config,
    new TypedEventBus() as never,
  );
  const expectNoEffects = () => {
    for (const effect of Object.values(storeEffects)) expect(effect).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    expect(isSignerRegistered).not.toHaveBeenCalled();
    expect(isCgCurated).not.toHaveBeenCalled();
    expect(contextGraphSharedMemoryUri).not.toHaveBeenCalled();
  };
  return { handler, expectNoEffects };
}

const invalidContextGraphIds = [
  ['padded decimal', '042'],
  ['zero', '0'],
  ['uint256 overflow', (ethers.MaxUint256 + 1n).toString(10)],
] as const;

const invalidUint256Decimals = [
  ['padded decimal', '01'],
  ['negative decimal', '-1'],
  ['uint256 overflow', (ethers.MaxUint256 + 1n).toString(10)],
] as const;

describe('StorageACKHandler contextGraphId decode boundary', () => {
  it.each(invalidContextGraphIds)(
    'rejects a raw PublishIntent with %s before store, RPC, or signing',
    async (_label, contextGraphId) => {
      const { handler, expectNoEffects } = createBoundaryHarness();

      await expect(
        handler.handler(rawContextGraphIdIntent(contextGraphId), fakePeerId),
      ).rejects.toThrow('canonical positive uint256 context graph id');

      expectNoEffects();
    },
  );

  it.each(invalidContextGraphIds)(
    'rejects a raw UpdateIntent with %s before store, RPC, or signing',
    async (_label, contextGraphId) => {
      const { handler, expectNoEffects } = createBoundaryHarness();

      await expect(
        handler.updateHandler(rawContextGraphIdIntent(contextGraphId), fakePeerId),
      ).rejects.toThrow('canonical positive uint256 context graph id');

      expectNoEffects();
    },
  );

  it.each(invalidUint256Decimals)(
    'rejects a raw PublishIntent tokenAmountStr with %s before store, RPC, or signing',
    async (_label, tokenAmountStr) => {
      const { handler, expectNoEffects } = createBoundaryHarness();

      await expect(handler.handler(rawStringFields([
        [2, '42'],
        [10, tokenAmountStr],
      ]), fakePeerId)).rejects.toThrow('PublishIntent.tokenAmountStr');

      expectNoEffects();
    },
  );

  it.each([
    ...invalidUint256Decimals.map(([label, value]) => [label, 1, value] as const),
    ...invalidUint256Decimals.map(([label, value]) => [label, 6, value] as const),
    ...invalidUint256Decimals.map(([label, value]) => [label, 8, value] as const),
  ])(
    'rejects a raw UpdateIntent uint256 field with %s before store, RPC, or signing',
    async (_label, invalidFieldNumber, invalidValue) => {
      const { handler, expectNoEffects } = createBoundaryHarness();
      const fields: Array<readonly [number, string]> = [
        [1, invalidFieldNumber === 1 ? invalidValue : '7'],
        [2, '42'],
      ];
      if (invalidFieldNumber === 6) fields.push([6, invalidValue]);
      if (invalidFieldNumber === 8) fields.push([8, invalidValue]);

      await expect(
        handler.updateHandler(rawStringFields(fields), fakePeerId),
      ).rejects.toThrow(/UpdateIntent\.(?:kaId|newTokenAmount|burnTokenIds)/);

      expectNoEffects();
    },
  );
});
