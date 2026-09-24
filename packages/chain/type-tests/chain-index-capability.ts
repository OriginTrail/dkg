import type { EVMAdapterBaseConfig } from '../src/evm-adapter-types.js';
import type { ChainEventLogStore } from '../src/chain-index/chain-event-log.js';
import { EVMChainAdapter, createEvmChainIndexRuntime, type EVMAdapterConfig, type StrictEVMAdapterConfig, type EvmChainIndexRuntimeOptions } from '../src/index.js';
import type { ChainIndexCapability } from '../src/chain-index-capability.js';
import type { KnowledgeAssetReadModelFactory } from '../src/chain-index/knowledge-asset-read-model.js';

declare const readModelFactory: KnowledgeAssetReadModelFactory;
// @ts-expect-error A custom reader cannot be configured without its required store.
const readerOnly: ChainIndexCapability = { readModelFactory };
void readerOnly;

declare const store: ChainEventLogStore;
declare const common: Omit<EVMAdapterConfig, 'chainIndex' | 'chainEventLogStore'>;
const modern: EVMAdapterConfig = { ...common, chainIndex: { store, readModelFactory } };
const legacy: EVMAdapterConfig = { ...common, chainEventLogStore: store };
const noOwner: EVMAdapterConfig = { ...common };
// @ts-expect-error Modern and legacy ownership cannot coexist.
const dualOwner: StrictEVMAdapterConfig = { ...common, chainIndex: { store }, chainEventLogStore: store };
// @ts-expect-error A legacy reader cannot exist independently of a capability.
const legacyReaderOnly: StrictEVMAdapterConfig = { ...common, chainEventLogReadModelFactory: readModelFactory };
const legacyReaderVariable = { ...common, chainEventLogReadModelFactory: readModelFactory };
// @ts-expect-error Structural variables cannot bypass the removed reader-only option.
const structuralLegacyReader: StrictEVMAdapterConfig = legacyReaderVariable;

declare const runtimeCommon: Omit<EvmChainIndexRuntimeOptions, 'chainIndex' | 'store'>;
createEvmChainIndexRuntime({ ...runtimeCommon, store });
createEvmChainIndexRuntime({ ...runtimeCommon, chainIndex: { store, readModelFactory } });
// @ts-expect-error Runtime ownership also selects only one input shape.
createEvmChainIndexRuntime({ ...runtimeCommon, store, chainIndex: { store } });
// @ts-expect-error A runtime cannot be created without its store.
createEvmChainIndexRuntime(runtimeCommon);
void [modern, legacy, noOwner, dualOwner, legacyReaderOnly, structuralLegacyReader];

// Existing SDK extensions are checked through the actual public constructor.
interface TenantAdapterConfig extends EVMAdapterConfig { tenantId: string }
const tenantAdapter: TenantAdapterConfig = { ...common, tenantId: 'tenant-a', chainEventLogStore: store };
new EVMChainAdapter(tenantAdapter);
interface TenantAdapterBaseConfig extends EVMAdapterBaseConfig { tenantId: string }
const tenantBase: TenantAdapterBaseConfig = { ...common, tenantId: 'tenant-a', chainEventLogStore: store };
new EVMChainAdapter(tenantBase);

interface TenantRuntimeOptions extends EvmChainIndexRuntimeOptions { tenantId: string }
const tenantRuntime: TenantRuntimeOptions = { ...runtimeCommon, store, tenantId: 'tenant-a' };
const legacyRequiredStore: ChainEventLogStore = tenantRuntime.store;
createEvmChainIndexRuntime(tenantRuntime);
void legacyRequiredStore;
