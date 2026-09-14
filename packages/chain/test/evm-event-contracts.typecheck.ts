import type { EvmEventContractKey } from '../src/evm-event-contracts.js';
import { selectEvmEventPlan } from '../src/evm-event-contracts.js';
import type { EvmHubContractKey } from '../src/evm-hub-contract-bindings.js';

// The binding key type is derived from EVM_EVENT_DESCRIPTORS, so it admits
// only bindings some descriptor actually reads — it must stay narrower than
// the Hub key space. Widening it back would silently let a scan plan request
// a contract no event can be parsed from.
const eventBinding: EvmHubContractKey = 'contextGraphStorage' satisfies EvmEventContractKey;
void eventBinding;
// @ts-expect-error `token` is a Hub binding, but no event descriptor declares it
const notAnEventBinding: EvmEventContractKey = 'token' satisfies EvmHubContractKey;
void notAnEventBinding;

// A plan's bindings carry that narrow type, so callers keep it downstream.
const bindings: readonly EvmEventContractKey[] = selectEvmEventPlan(['KCCreated']).bindings;
void bindings;
