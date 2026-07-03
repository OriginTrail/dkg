/**
 * B8 — `decodeConvictionCostCovered` unit coverage (no chain needed).
 *
 * The CostCovered event is emitted by the PublishingConviction LOGIC contract
 * (a different address than KA storage), so `createKnowledgeAssets` decodes it
 * in a separate pass via the PCA logic ABI. A real PCA-covered publish needs a
 * StorageACK quorum (multi-node), so the end-to-end 3-route surfacing is
 * exercised on the CI devnet @mutating lane; here we pin the decode itself by
 * round-tripping a synthesized log through the same interface.
 */
import { describe, it, expect } from 'vitest';
import { Interface } from 'ethers';
import { decodeConvictionCostCovered } from '../src/evm-adapter-base.js';
import { PublishMethods } from '../src/evm-adapter-publish.js';
import { getPcaLogicInterface } from '../src/evm-adapter-errors.js';

function costCoveredLog(values: bigint[]): { topics: string[]; data: string } {
  const iface = getPcaLogicInterface();
  const ev = iface.getEvent('CostCovered');
  if (!ev) throw new Error('CostCovered event missing from PublishingConviction ABI');
  const { topics, data } = iface.encodeEventLog(ev, values);
  return { topics, data };
}

const KAS = '0x1111111111111111111111111111111111111111';

function kaCreatedLog(): { address: string; topics: string[]; data: string } {
  const iface = new Interface([
    'event KnowledgeAssetCreated(uint256 id, address author)',
  ]);
  const ev = iface.getEvent('KnowledgeAssetCreated');
  if (!ev) throw new Error('KnowledgeAssetCreated event missing from test ABI');
  const { topics, data } = iface.encodeEventLog(ev, [55n, '0x2222222222222222222222222222222222222222']);
  return { address: KAS, topics, data };
}

describe('decodeConvictionCostCovered (B8)', () => {
  it('round-trips a CostCovered log into bigint discount detail', () => {
    // accountId, epoch, baseCost, discountedCost, drawnFromEpoch, drawnFromTopUp
    const log = costCoveredLog([7n, 42n, 1000n, 700n, 500n, 200n]);
    expect(decodeConvictionCostCovered([log])).toEqual({
      accountId: 7n,
      epoch: 42,
      baseCost: 1000n,
      discountedCost: 700n,
      drawnFromEpoch: 500n,
      drawnFromTopUp: 200n,
    });
  });

  it('returns undefined when there is no CostCovered log', () => {
    expect(decodeConvictionCostCovered([])).toBeUndefined();
    // An unrelated/garbage log is ignored, not thrown.
    expect(decodeConvictionCostCovered([{ topics: ['0x' + '11'.repeat(32)], data: '0x' }])).toBeUndefined();
  });

  it('finds CostCovered among unrelated logs', () => {
    const out = decodeConvictionCostCovered([
      { topics: ['0x' + 'aa'.repeat(32)], data: '0x' },
      costCoveredLog([1n, 2n, 3n, 4n, 5n, 6n]),
    ]);
    expect(out?.accountId).toBe(1n);
    expect(out?.discountedCost).toBe(4n);
  });

  it('attaches CostCovered when resolving a V10 publish receipt by tx hash', async () => {
    const parser = Object.create(PublishMethods.prototype) as PublishMethods & {
      contracts: Record<string, unknown>;
      getBlockTimestamp: () => Promise<number>;
    };
    parser.contracts = {
      knowledgeAssetStorage: {
        target: KAS,
        interface: new Interface([
          'event KnowledgeAssetCreated(uint256 id, address author)',
        ]),
      },
    };
    parser.getBlockTimestamp = async () => 1234;

    const out = await parser.parseV10PublishReceipt({
      hash: '0xabc',
      blockNumber: 12,
      index: 3,
      from: '0x3333333333333333333333333333333333333333',
      logs: [
        kaCreatedLog(),
        costCoveredLog([7n, 42n, 1000n, 700n, 500n, 200n]),
      ],
    } as any);

    expect(out?.kaId).toBe(55n);
    expect(out?.convictionCostCovered).toEqual({
      accountId: 7n,
      epoch: 42,
      baseCost: 1000n,
      discountedCost: 700n,
      drawnFromEpoch: 500n,
      drawnFromTopUp: 200n,
    });
  });
});
