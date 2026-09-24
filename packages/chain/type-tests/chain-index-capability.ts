import type { EVMAdapterConfig } from '../src/evm-adapter-types.js';
import type { ChainIndexCapability } from '../src/chain-index-capability.js';
import type { KnowledgeAssetReadModelFactory } from '../src/chain-index/knowledge-asset-read-model.js';

declare const readModelFactory: KnowledgeAssetReadModelFactory;
// @ts-expect-error A custom reader cannot be configured without its required store.
const readerOnly: ChainIndexCapability = { readModelFactory };
// @ts-expect-error The independent reader configuration is intentionally removed.
type RemovedReaderField = EVMAdapterConfig['chainEventLogReadModelFactory'];
void readerOnly;
declare const removed: RemovedReaderField;
void removed;
