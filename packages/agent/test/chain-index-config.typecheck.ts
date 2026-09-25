import { DKGAgent, type DKGAgentConfig, type StrictDKGAgentConfig } from '../src/index.js';
import type { ChainEventLogStore, KnowledgeAssetReadModelFactory } from '@origintrail-official/dkg-chain';

declare const store: ChainEventLogStore;
declare const readModelFactory: KnowledgeAssetReadModelFactory;
const modern: DKGAgentConfig = { name: 'modern', chainIndex: { store, readModelFactory } };
const legacy: DKGAgentConfig = { name: 'legacy', chainEventLogStore: store };
const noOwner: DKGAgentConfig = { name: 'none' };
// @ts-expect-error Modern and legacy chain-index owners are mutually exclusive.
const dualOwner: StrictDKGAgentConfig = { name: 'invalid', chainIndex: { store }, chainEventLogStore: store };
void [modern, legacy, noOwner, dualOwner];

// Existing SDK extensions remain valid inputs, even with inherited optional ownership.
interface TenantConfig extends DKGAgentConfig { tenantId: string }
const tenantConfig: TenantConfig = { name: 'tenant', tenantId: 'tenant-a', chainEventLogStore: store };
void DKGAgent.create(tenantConfig);
