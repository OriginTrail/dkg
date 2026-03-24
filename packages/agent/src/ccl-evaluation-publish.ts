import { DKG_ONTOLOGY, sparqlString } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { CclEvaluationResult } from './ccl-evaluator.js';

export interface PublishCclEvaluationInput {
  paranetId: string;
  policyUri: string;
  factSetHash: string;
  factQueryHash?: string;
  factResolverVersion?: string;
  factResolutionMode?: 'manual' | 'snapshot-resolved';
  result: CclEvaluationResult;
  evaluatedAt: string;
  view?: string;
  snapshotId?: string;
  scopeUal?: string;
  contextType?: string;
}

export function buildCclEvaluationQuads(input: PublishCclEvaluationInput, graph: string): {
  evaluationUri: string;
  quads: Quad[];
} {
  const suffix = `${Date.now()}-${input.factSetHash.slice(-12)}`;
  const evaluationUri = `did:dkg:ccl-eval:${encodeSegment(input.paranetId)}:${suffix}`;
  const graphUri = String(graph);
  const quads: Quad[] = [
    { subject: evaluationUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: String(DKG_ONTOLOGY.DKG_CCL_EVALUATION), graph: graphUri },
    { subject: evaluationUri, predicate: DKG_ONTOLOGY.DKG_EVALUATED_POLICY, object: String(input.policyUri), graph: graphUri },
    { subject: evaluationUri, predicate: DKG_ONTOLOGY.DKG_FACT_SET_HASH, object: sparqlString(input.factSetHash), graph: graphUri },
    { subject: evaluationUri, predicate: DKG_ONTOLOGY.DKG_CREATED_AT, object: sparqlString(input.evaluatedAt), graph: graphUri },
  ];

  if (input.factQueryHash) quads.push({ subject: evaluationUri, predicate: DKG_ONTOLOGY.DKG_FACT_QUERY_HASH, object: sparqlString(input.factQueryHash), graph: graphUri });
  if (input.factResolverVersion) quads.push({ subject: evaluationUri, predicate: DKG_ONTOLOGY.DKG_FACT_RESOLVER_VERSION, object: sparqlString(input.factResolverVersion), graph: graphUri });
  if (input.factResolutionMode) quads.push({ subject: evaluationUri, predicate: DKG_ONTOLOGY.DKG_FACT_RESOLUTION_MODE, object: sparqlString(input.factResolutionMode), graph: graphUri });
  if (input.view) quads.push({ subject: evaluationUri, predicate: DKG_ONTOLOGY.DKG_VIEW, object: sparqlString(input.view), graph: graphUri });
  if (input.snapshotId) quads.push({ subject: evaluationUri, predicate: DKG_ONTOLOGY.DKG_SNAPSHOT_ID, object: sparqlString(input.snapshotId), graph: graphUri });
  if (input.scopeUal) quads.push({ subject: evaluationUri, predicate: DKG_ONTOLOGY.DKG_SCOPE_UAL, object: sparqlString(input.scopeUal), graph: graphUri });
  if (input.contextType) quads.push({ subject: evaluationUri, predicate: DKG_ONTOLOGY.DKG_POLICY_CONTEXT_TYPE, object: sparqlString(input.contextType), graph: graphUri });

  appendEntries(quads, evaluationUri, 'derived', input.result.derived, graphUri);
  appendEntries(quads, evaluationUri, 'decision', input.result.decisions, graphUri);

  return { evaluationUri, quads };
}

function appendEntries(
  quads: Quad[],
  evaluationUri: string,
  kind: 'derived' | 'decision',
  entries: Record<string, unknown[][]>,
  graph: string,
): void {
  for (const [name, tuples] of Object.entries(entries)) {
    tuples.forEach((tuple, index) => {
      const entryUri = `${evaluationUri}/result/${encodeSegment(kind)}/${encodeSegment(name)}/${index}`;
      quads.push(
        { subject: entryUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CCL_RESULT_ENTRY, graph },
        { subject: evaluationUri, predicate: DKG_ONTOLOGY.DKG_HAS_RESULT, object: entryUri, graph },
        { subject: entryUri, predicate: DKG_ONTOLOGY.DKG_RESULT_KIND, object: sparqlString(kind), graph },
        { subject: entryUri, predicate: DKG_ONTOLOGY.DKG_RESULT_NAME, object: sparqlString(name), graph },
      );

      tuple.forEach((value, argIndex) => {
        const argUri = `${entryUri}/arg/${argIndex}`;
        quads.push(
          { subject: argUri, predicate: DKG_ONTOLOGY.RDF_TYPE, object: DKG_ONTOLOGY.DKG_CCL_RESULT_ARG, graph },
          { subject: entryUri, predicate: DKG_ONTOLOGY.DKG_HAS_RESULT_ARG, object: argUri, graph },
          { subject: argUri, predicate: DKG_ONTOLOGY.DKG_RESULT_ARG_INDEX, object: sparqlString(String(argIndex)), graph },
          { subject: argUri, predicate: DKG_ONTOLOGY.DKG_RESULT_ARG_VALUE, object: sparqlString(JSON.stringify(value)), graph },
        );
      });
    });
  }
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/%/g, '_');
}
