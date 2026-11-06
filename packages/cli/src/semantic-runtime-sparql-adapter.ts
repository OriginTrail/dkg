import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { analyzeSparqlOperation, canonicalizeJson, sparqlIri, type CanonicalJsonValue } from '@origintrail-official/dkg-core';
import { prepareSparql, prepareSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';
import type { RuntimeAdapterOperation, SemanticSparqlReadGrant } from '@origintrail-official/dkg-semantic-runtime';

import { assertSemanticQueryOutput, queryOutputSchemaSha256 } from './semantic-runtime-query-pins.js';

const MAX_QUERY_BYTES = 64 * 1024;
const views = { wm: 'working-memory', swm: 'shared-working-memory', vm: 'verifiable-memory' } as const;

export function validateSparqlReadGrant(value: unknown): asserts value is SemanticSparqlReadGrant {
  if (!record(value) || Object.keys(value).some((key) => ![
    'toolIri', 'layer', 'timeoutMs', 'maxResultItems', 'maxOutputBytes', 'outputSchema', 'outputSchemaSha256',
  ].includes(key)) || typeof value.toolIri !== 'string' || value.toolIri.length > 2048
    || !/^[a-z][a-z0-9+.-]*:/i.test(value.toolIri) || typeof value.layer !== 'string' || !Object.hasOwn(views, value.layer)
    || !integer(value.timeoutMs, 1, 30_000) || !integer(value.maxResultItems, 1, 1000)
    || !integer(value.maxOutputBytes, 1, 1_048_576)) throw new Error('INVALID_SPARQL_READ_GRANT');
  sparqlIri(value.toolIri);
  if (queryOutputSchemaSha256(value.outputSchema as SemanticSparqlReadGrant['outputSchema']) !== value.outputSchemaSha256) {
    throw new Error('SEMANTIC_QUERY_SCHEMA_PIN_MISMATCH');
  }
}

/** Validate both fresh results and persisted outputs before disclosing them. */
export function assertSparqlReadOutput(grant: SemanticSparqlReadGrant, contextGraphId: string, output: string): void {
  if (Buffer.byteLength(output, 'utf8') > grant.maxOutputBytes) throw new Error('SPARQL_RESULT_TOO_LARGE');
  const value: unknown = JSON.parse(output);
  if (!record(value) || value.kind !== 'sparql-read' || value.contextGraphId !== contextGraphId || value.layer !== grant.layer
    || typeof value.querySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.querySha256)
    || Object.keys(value).some((key) => !['kind', 'contextGraphId', 'layer', 'querySha256', 'result'].includes(key))) {
    throw new Error('SPARQL_OUTPUT_SCOPE_MISMATCH');
  }
  assertResult(grant, value.result);
}

export function createSparqlReadAdapter(
  agent: DKGAgent,
  contextGraphId: string,
  executorAgentAddress: string,
  approvedGrant: SemanticSparqlReadGrant,
  assertAuthorized: () => Promise<void>,
): RuntimeAdapterOperation<{ sparql: string }, string> {
  validateSparqlReadGrant(approvedGrant);
  const grant = structuredClone(approvedGrant);
  const implementationHash = createHash('sha256').update(readFileSync(new URL(import.meta.url)))
    .update(readFileSync(new URL(`./semantic-runtime-query-pins.${import.meta.url.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url)))
    .update(canonicalizeJson({ contextGraphId, executorAgentAddress, grant } as unknown as CanonicalJsonValue)).digest('hex');
  const checkAccess = async () => {
    await assertAuthorized();
    if (!(await agent.canReadContextGraph(contextGraphId, { callerAgentAddress: executorAgentAddress, allowSubscriptionFallback: false }))) {
      throw new Error('SPARQL_CONTEXT_GRAPH_ACCESS_DENIED');
    }
    if (grant.layer === 'swm' && !(await agent.canUseSharedMemoryForContextGraph(contextGraphId, { callerAgentAddress: executorAgentAddress }))) {
      throw new Error('SPARQL_SHARED_MEMORY_UNAVAILABLE');
    }
    await assertAuthorized();
  };
  return {
    id: 'dkg/sparql-read', version: '1', witInterface: 'origintrail:semantic-runtime/sparql-read@0.1.0',
    implementationVersion: '1', implementationHash, effectClass: 'read', verb: 'query',
    idempotencyClass: 'pure_read', reconciliationRule: 'not-required-for-pure-read',
    validateInput(value) {
      if (!record(value) || Object.keys(value).length !== 1 || typeof value.sparql !== 'string'
        || Buffer.byteLength(value.sparql, 'utf8') > MAX_QUERY_BYTES) throw new Error('INVALID_SPARQL_ARGUMENT');
      const prepared = prepareSparql(value.sparql);
      if (prepared.status !== 'valid' || prepared.unterminated) throw new Error('INVALID_SPARQL_QUERY');
      const query = prepareSparqlQuery(prepared);
      const analysis = analyzeSparqlOperation(prepared);
      if (!query.structure.balanced || analysis.operation.kind !== 'read' || analysis.mutatingKeyword) {
        throw new Error('SPARQL_READ_ONLY_REQUIRED');
      }
      if (prepared.wordTokens.has('SERVICE') || query.hasDatasetClause) throw new Error('SPARQL_DATASET_OVERRIDE_FORBIDDEN');
      // Keep original text for provenance. DKG's query engine applies the same
      // lexical preparation, read guard and graph-variable/explicit-IRI scoping.
      return { sparql: value.sparql };
    },
    async dispatch(_authorization, input) {
      // Defense in depth for direct adapter callers as well as broker dispatch.
      input = this.validateInput(input);
      const controller = new AbortController();
      const deadline = Date.now() + grant.timeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error('SPARQL_QUERY_TIMEOUT');
          reject(error);
          controller.abort(error);
        }, grant.timeoutMs);
      });
      const checkDeadline = () => {
        if (controller.signal.aborted || Date.now() >= deadline) throw new Error('SPARQL_QUERY_TIMEOUT');
      };
      try {
        return await Promise.race([timeout, (async () => {
          await checkAccess();
          checkDeadline();
          const result = await agent.query(input.sparql, {
            contextGraphId, view: views[grant.layer], callerAgentAddress: executorAgentAddress,
            ...(grant.layer === 'wm' ? { agentAddress: executorAgentAddress } : {}),
            source: 'semantic-runtime-sparql-read', signal: controller.signal,
          });
          checkDeadline();
          await checkAccess();
          checkDeadline();
          assertResult(grant, result);
          const output = canonicalizeJson({
            kind: 'sparql-read', contextGraphId, layer: grant.layer,
            querySha256: createHash('sha256').update(input.sparql, 'utf8').digest('hex'), result,
          } as unknown as CanonicalJsonValue, { maxBytes: grant.maxOutputBytes });
          checkDeadline();
          return { status: 'succeeded' as const, output,
            evidenceRef: `urn:sr:adapter-output:${createHash('sha256').update(output, 'utf8').digest('hex')}` };
        })()]);
      } finally { clearTimeout(timer); }
    },
    reconcile: async () => ({ status: 'not_applied', evidenceRef: 'urn:sr:reconciliation:not-required-for-pure-read' }),
    couldHaveReachedTarget: () => false,
  };
}

function assertResult(grant: SemanticSparqlReadGrant, result: unknown): void {
  if (!record(result) || !Array.isArray(result.bindings) || (result.quads !== undefined && !Array.isArray(result.quads))) {
    throw new Error('SPARQL_RESULT_INVALID');
  }
  if (result.bindings.length + (Array.isArray(result.quads) ? result.quads.length : 0) > grant.maxResultItems) {
    throw new Error('SPARQL_RESULT_TOO_LARGE');
  }
  assertSemanticQueryOutput(grant, result);
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function integer(value: unknown, min: number, max: number): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max; }
