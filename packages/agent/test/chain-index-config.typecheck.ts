import { DKGAgent, type DKGAgentConfig, type StrictDKGAgentConfig } from '../src/index.js';
import type { ChainEventLogStore, KnowledgeAssetReadModelFactory } from '@origintrail-official/dkg-chain';

declare const store: ChainEventLogStore;
declare const readModelFactory: KnowledgeAssetReadModelFactory;
const modern: DKGAgentConfig = { name: 'modern', chainIndex: { store, readModelFactory } };
const legacy: DKGAgentConfig = { name: 'legacy', chainEventLogStore: store };
const noOwner: DKGAgentConfig = { name: 'none' };
// @ts-expect-error Modern and legacy chain-index owners are mutually exclusive.
const dualOwner: StrictDKGAgentConfig = { name: 'invalid', chainIndex: { store }, chainEventLogStore: store };
// @ts-expect-error Legacy reader-only configuration has no owning store capability.
const readerOnly: StrictDKGAgentConfig = { name: 'invalid', chainEventLogReadModelFactory: readModelFactory };
const legacyReaderVariable = { name: 'invalid', chainEventLogReadModelFactory: readModelFactory };
// @ts-expect-error Structural variables cannot bypass the removed reader-only option.
const structuralReaderOnly: StrictDKGAgentConfig = legacyReaderVariable;
void [modern, legacy, noOwner, dualOwner, readerOnly, structuralReaderOnly];

// Existing SDK extensions remain valid inputs, even with inherited optional ownership.
interface TenantConfig extends DKGAgentConfig { tenantId: string }
const tenantConfig: TenantConfig = { name: 'tenant', tenantId: 'tenant-a', chainEventLogStore: store };
void DKGAgent.create(tenantConfig);
