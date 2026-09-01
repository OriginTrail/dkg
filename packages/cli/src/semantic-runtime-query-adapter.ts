import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { canonicalizeJson, type CanonicalJsonValue } from '@origintrail-official/dkg-core';
import {
  decodeQueryCatalogBindings,
  prepareQueryCatalogExecution,
  type QueryCatalogItem,
} from '@origintrail-official/dkg-core/query-catalog';
import type { RuntimeAdapterOperation } from '@origintrail-official/dkg-semantic-runtime';

import { readContextGraphQueryCatalogBindings } from './daemon/query-catalog-service.js';

const MAX_SELECTOR_BYTES = 512;
const MAX_RESULT_ITEMS = 1_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface DkgQueryInput {
  selector: string;
  parameters?: Record<string, string>;
}

export function createDkgQueryAdapter(
  agent: DKGAgent,
  contextGraphId: string,
  callerAgentAddress?: string,
): RuntimeAdapterOperation<DkgQueryInput, string> {
  const implementationHash = createHash('sha256')
    .update(readFileSync(fileURLToPath(import.meta.url)))
    .digest('hex');
  return {
    id: 'dkg/query',
    version: '1',
    witInterface: 'origintrail:semantic-runtime/query-catalog@0.1.0',
    implementationVersion: '1',
    implementationHash,
    effectClass: 'read',
    verb: 'query',
    idempotencyClass: 'pure_read',
    reconciliationRule: 'not-required-for-pure-read',
    validateInput(value): DkgQueryInput {
      if (
        typeof value !== 'object'
        || value === null
        || !('selector' in value)
        || typeof value.selector !== 'string'
        || value.selector.trim() !== value.selector
        || value.selector.length === 0
        || Buffer.byteLength(value.selector, 'utf8') > MAX_SELECTOR_BYTES
      ) throw new Error('INVALID_QUERY_SELECTOR');
      const parameters = 'parameters' in value && value.parameters !== undefined
        ? validateParameters(value.parameters)
        : {};
      return { selector: value.selector, parameters };
    },
    async dispatch(authorization, input) {
      traceTiming('start', authorization.effectId);
      try {
        if (!(await agent.canReadContextGraph(contextGraphId, { callerAgentAddress }))) {
          throw new Error('QUERY_CONTEXT_GRAPH_ACCESS_DENIED');
        }
        const rows = await readContextGraphQueryCatalogBindings(agent, contextGraphId, {
          callerAgentAddress,
          source: 'semantic-runtime-query-catalog',
        });
        const item = findSavedQuery(
          decodeQueryCatalogBindings(rows, { contextGraphId }),
          input.selector,
        );
        if (!item) throw new Error('QUERY_CATALOG_ENTRY_NOT_FOUND');
        const execution = prepareQueryCatalogExecution(item, input.parameters);
        const result = await agent.query(execution.sparql, {
          contextGraphId,
          source: 'semantic-runtime-dkg-query',
          ...(execution.subGraphName ? { subGraphName: execution.subGraphName } : {}),
          ...(execution.view ? { view: execution.view } : {}),
          ...(callerAgentAddress ? { callerAgentAddress } : {}),
        });
        assertBoundedResult(result);
        const output = canonicalizeJson(
          { queryIri: item.queryIri, result } as unknown as CanonicalJsonValue,
          { maxBytes: MAX_OUTPUT_BYTES },
        );
        return {
          status: 'succeeded',
          output,
          evidenceRef: `urn:sr:adapter-output:${createHash('sha256').update(output, 'utf8').digest('hex')}`,
        };
      } finally {
        traceTiming('finish', authorization.effectId);
      }
    },
    reconcile: async () => ({
      status: 'not_applied',
      evidenceRef: 'urn:sr:reconciliation:not-required-for-pure-read',
    }),
    couldHaveReachedTarget: () => false,
  };
}

function validateParameters(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('INVALID_QUERY_PARAMETERS');
  }
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error('INVALID_QUERY_PARAMETERS');
  const normalized: Record<string, string> = {};
  for (const [name, parameter] of entries) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)
      || typeof parameter !== 'string'
      || Buffer.byteLength(parameter, 'utf8') > 4 * 1024
    ) throw new Error('INVALID_QUERY_PARAMETERS');
    normalized[name] = parameter;
  }
  return normalized;
}

function traceTiming(phase: 'start' | 'finish', effectId: string): void {
  if (process.env.SEMANTIC_RUNTIME_TRACE_ADAPTER_TIMING !== '1') return;
  console.info(`semantic-runtime-tool-timing ${JSON.stringify({
    operation: 'dkg/query',
    phase,
    effectId,
    monotonicNs: process.hrtime.bigint().toString(),
  })}`);
}

function qualifiedSelector(item: QueryCatalogItem): string {
  return `${item.subGraph}/${item.catalogSlug}/${item.slug}`;
}

function findSavedQuery(items: QueryCatalogItem[], selector: string): QueryCatalogItem | undefined {
  const exact = items.filter((item) =>
    item.queryIri === selector || qualifiedSelector(item) === selector);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error('QUERY_SELECTOR_AMBIGUOUS');
  const matches = items.filter((item) => item.slug === selector || item.name === selector);
  if (matches.length > 1) throw new Error('QUERY_SELECTOR_AMBIGUOUS');
  return matches[0];
}

function assertBoundedResult(result: unknown): void {
  if (typeof result !== 'object' || result === null) {
    throw new Error('QUERY_RESULT_INVALID');
  }
  const value = result as { type?: unknown; bindings?: unknown; quads?: unknown; value?: unknown };
  if (
    Array.isArray(value.bindings)
    && (value.type === undefined || value.type === 'bindings')
  ) {
    if (value.bindings.length > MAX_RESULT_ITEMS) throw new Error('QUERY_RESULT_TOO_LARGE');
    return;
  }
  if (
    Array.isArray(value.quads)
    && (value.type === undefined || value.type === 'quads')
  ) {
    if (value.quads.length > MAX_RESULT_ITEMS) throw new Error('QUERY_RESULT_TOO_LARGE');
    return;
  }
  if (
    typeof value.value === 'boolean'
    && (value.type === undefined || value.type === 'boolean')
  ) return;
  throw new Error('QUERY_RESULT_INVALID');
}
