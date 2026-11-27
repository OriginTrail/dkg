import type { ChainEventPollerConfig } from '../../src/index.js';

// Existing SDK callbacks still consume their historical metadata fields.
const legacyConsumer: NonNullable<ChainEventPollerConfig['onCollectionUpdated']> = async ({ blockNumber, txHash, logIndex, blockHash }) => {
  const block: number = blockNumber;
  const transaction: string | undefined = txHash;
  const position: number | undefined = logIndex;
  const fork: string | undefined = blockHash;
  void [block, transaction, position, fork];
};
void legacyConsumer;
