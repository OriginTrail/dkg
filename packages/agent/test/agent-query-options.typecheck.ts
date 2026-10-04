import type { AgentQueryOptions } from '../src/dkg-agent-query.js';

const supported: AgentQueryOptions = {
  contextGraphId: 'cg-1',
  maxResponseBytes: 1024,
  includeContextGraphPartitions: true,
};

// Engine-internal routing controls must not enter the public agent contract.
// @ts-expect-error excludeGraphPrefixes is intentionally engine-only
const engineOnly: AgentQueryOptions = { excludeGraphPrefixes: ['urn:private:'] };

// @ts-expect-error maxMaterializedBytes is an engine-internal aggregate budget
const internalBudget: AgentQueryOptions = { maxMaterializedBytes: 1024 };

void supported;
void engineOnly;
void internalBudget;
