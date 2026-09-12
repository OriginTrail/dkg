// SPDX-License-Identifier: Apache-2.0

import type { ContractCache } from './evm-adapter-types.js';
import type { EvmHubContractKey } from './evm-hub-contract-bindings.js';

/** Event aliases select capabilities from the canonical Hub binding registry. */
const EVENT_CONTRACTS = {
  profileStorage: ['RelayCapabilityUpdated'],
  knowledgeAssetStorage: ['KCCreated', 'KnowledgeAssetCreated'],
  knowledgeAssetsStorage: ['KnowledgeBatchCreated'],
  contextGraphNameRegistry: ['NameClaimed', 'ContextGraphNameClaimed'],
  contextGraphStorage: ['ContextGraphExpanded', 'KnowledgeAssetRegisteredToContextGraph', 'ContextGraphCreated'],
} as const satisfies Partial<Record<EvmHubContractKey, readonly string[]>>;

export type EvmEventContractKey = keyof typeof EVENT_CONTRACTS;
export type EvmEventContracts = Readonly<Pick<ContractCache, EvmEventContractKey>>;
const EVENT_CONTRACT_KEYS = Object.freeze(Object.keys(EVENT_CONTRACTS) as EvmEventContractKey[]);

export function eventContractKeysFor(eventTypes: readonly string[]): readonly EvmEventContractKey[] {
  const selected = new Set(eventTypes);
  return EVENT_CONTRACT_KEYS.filter(key => EVENT_CONTRACTS[key].some(event => selected.has(event)));
}
