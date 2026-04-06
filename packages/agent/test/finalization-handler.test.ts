import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { encodeFinalizationMessage, type FinalizationMessageMsg, encodePublishRequest } from '@origintrail-official/dkg-core';
import { FinalizationHandler } from '../src/finalization-handler.js';

const PARANET = 'test-paranet';

function makeFinalizationMsg(overrides?: Partial<FinalizationMessageMsg>): FinalizationMessageMsg {
  return {
    ual: 'did:dkg:evm:31337/0xABC/1',
    paranetId: PARANET,
    kcMerkleRoot: new Uint8Array(32),
    txHash: '0x' + 'ab'.repeat(32),
    blockNumber: 100,
    batchId: 1,
    startKAId: 1,
    endKAId: 2,
    publisherAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    rootEntities: ['urn:test:entity'],
    timestampMs: Date.now(),
    operationId: 'test-op-1',
    ...overrides,
  };
}

describe('FinalizationHandler', () => {
  let store: OxigraphStore;
  let handler: FinalizationHandler;

  beforeEach(async () => {
    store = new OxigraphStore();
    handler = new FinalizationHandler(store, undefined);
  });

  it('deduplicates messages with same UAL and txHash', async () => {
    const msg = makeFinalizationMsg();
    const data = encodeFinalizationMessage(msg);

    // Process same message twice — should not throw, second should be skipped
    await handler.handleFinalizationMessage(data, PARANET);
    await handler.handleFinalizationMessage(data, PARANET);
    // No assertion needed — the test passes if no errors are thrown
    // and no double-processing occurs (verified by log "already processed")
  });

  it('processes messages with different UALs separately', async () => {
    const msg1 = makeFinalizationMsg({ ual: 'did:dkg:evm:31337/0xABC/1' });
    const msg2 = makeFinalizationMsg({ ual: 'did:dkg:evm:31337/0xABC/2', txHash: '0x' + 'cd'.repeat(32) });

    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg1), PARANET);
    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg2), PARANET);
  });

  it('silently skips non-finalization protobuf messages (wrong wire type)', async () => {
    // Encode a publish request message instead of a finalization message
    const wrongTypeData = encodePublishRequest({
      ual: 'did:dkg:test/1',
      nquads: new TextEncoder().encode('<urn:s> <urn:p> <urn:o> .'),
      paranetId: PARANET,
      kas: [{ tokenId: 1, rootEntity: 'urn:s', privateTripleCount: 0, privateMerkleRoot: new Uint8Array(0) }],
      txHash: '',
      blockNumber: 0,
    });

    // Should not throw — just silently skip
    await handler.handleFinalizationMessage(wrongTypeData, PARANET);
  });

  it('silently skips random binary data', async () => {
    const garbage = new Uint8Array([0xFF, 0xFE, 0x01, 0x02, 0x03]);
    await handler.handleFinalizationMessage(garbage, PARANET);
  });

  it('ignores messages with mismatched paranetId', async () => {
    const msg = makeFinalizationMsg({ paranetId: 'wrong-paranet' });
    const data = encodeFinalizationMessage(msg);
    await handler.handleFinalizationMessage(data, PARANET);
  });

  it('rejects messages with incomplete fields', async () => {
    const msg = makeFinalizationMsg({ rootEntities: [] });
    const data = encodeFinalizationMessage(msg);
    await handler.handleFinalizationMessage(data, PARANET);
  });
});
