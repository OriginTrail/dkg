import { describe, expect, it } from 'vitest';
import {
  PAPER_BASELINE_V0,
  RatelessIbltDecoder,
  RatelessIbltEncoder,
  bytesToHex,
  hashBytes,
  reconciliationSeed,
  u64be,
  type WalObjectId
} from '../../src/reconciliation/index.js';
import {
  createFixedDifferenceScenario,
  sequentialWalObjectId
} from '../../benchmarks/scenario.js';

const stressEnabled = process.env.WAL_RECONCILIATION_STRESS === '1';
const fullScaleEnabled = process.env.WAL_RECONCILIATION_FULL_SCALE === '1';

describe.runIf(stressEnabled)('WAL-005 deterministic stress acceptance', () => {
  it('decodes a two-sided difference across 100,000 deterministic seeds', { timeout: 600_000 }, () => {
    const common = [sequentialWalObjectId(0, 1), sequentialWalObjectId(1, 1)];
    const providerOnly = sequentialWalObjectId(0, 2);
    const receiverOnly = sequentialWalObjectId(0, 3);
    const provider = [...common, providerOnly];
    const receiver = [...common, receiverOnly];
    const expectedProvider = bytesToHex(providerOnly);
    const expectedReceiver = bytesToHex(receiverOnly);

    for (let repetition = 0; repetition < 100_000; repetition += 1) {
      const seed = reconciliationSeed(hashBytes(u64be(BigInt(repetition))));
      const encoder = new RatelessIbltEncoder({
        ids: provider,
        reconciliationSeed: seed,
        algorithm: PAPER_BASELINE_V0.algorithm
      });
      const decoder = new RatelessIbltDecoder({
        receiverIds: receiver,
        reconciliationSeed: seed,
        algorithm: PAPER_BASELINE_V0.algorithm
      });
      for (let symbol = 0; symbol < 1_024 && !decoder.complete; symbol += 1) {
        decoder.addProviderSymbol(encoder.produceNext());
      }
      const result = decoder.snapshot();
      if (
        !result.complete ||
        result.providerOnly.length !== 1 ||
        result.receiverOnly.length !== 1 ||
        bytesToHex(result.providerOnly[0]) !== expectedProvider ||
        bytesToHex(result.receiverOnly[0]) !== expectedReceiver
      ) {
        throw new Error(`100k seed property failed at deterministic seed ${repetition}`);
      }
    }
  });

  it('reconciles fixed k=32 at N=10^4, 10^5, and optionally 10^6', { timeout: 900_000 }, () => {
    const sizes = fullScaleEnabled ? [10_000, 100_000, 1_000_000] : [10_000, 100_000];
    for (const size of sizes) {
      const { provider, receiver } = createFixedDifferenceScenario(size, 16);
      const seed = reconciliationSeed(hashBytes(u64be(BigInt(size))));
      const encoder = new RatelessIbltEncoder({
        ids: provider,
        reconciliationSeed: seed,
        algorithm: PAPER_BASELINE_V0.algorithm
      });
      const decoder = new RatelessIbltDecoder({
        receiverIds: receiver,
        reconciliationSeed: seed,
        algorithm: PAPER_BASELINE_V0.algorithm
      });
      for (let symbol = 0; symbol < 512 && !decoder.complete; symbol += 1) {
        decoder.addProviderSymbol(encoder.produceNext());
      }
      const result = decoder.snapshot();
      expect(result.complete, `N=${size}`).toBe(true);
      expect(result.providerOnly, `N=${size}`).toHaveLength(16);
      expect(result.receiverOnly, `N=${size}`).toHaveLength(16);
    }
  });
});
