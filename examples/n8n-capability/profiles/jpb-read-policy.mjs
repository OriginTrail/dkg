/** Trusted selection and normalization policy shared by the nOS and SSH readers. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { iriValue } from '../../../packages/cli/dist/semantic-runtime-values.js';
import { parseRdfLiteralTerm } from '../../../packages/rdf-utils/dist/index.js';

const specificationBytes = readFileSync(new URL('./jpb-read-spec.json', import.meta.url), 'utf8');
const specification = JSON.parse(specificationBytes);
// Revision and execution use the same captured bytes, including after file changes.
export const jpbReadPolicyRevision = createHash('sha256').update(specificationBytes)
  .update(readFileSync(new URL(import.meta.url))).digest('hex');
const prefix = 'did:dkg:context-graph:' + specification.contextGraphId + '/_working_memory/' + specification.assertionOwner + '/';
const branches = specification.records.map(({ iri, partition }) => '{ GRAPH <' + prefix + partition + '> { VALUES ?recordVersion { <' + iri + '> } ?recordVersion d:traceabilityRecordJson ?recordJson; d:logicalId ?logicalRecord . } }');
const sparql = 'PREFIX d: <https://dmaast.eu/ontology/> SELECT DISTINCT ?recordVersion ?recordJson ?logicalRecord ?snapshot ?sourceEvidence ?evidenceCapturedAt WHERE { { ' + branches.join(' UNION ') + ' } GRAPH <' + prefix + specification.evidencePartition + '> { VALUES ?snapshot { <' + specification.snapshot + '> } ?snapshot d:hasRecord ?recordVersion; d:supportedBy ?evidenceVersion . ?evidenceVersion d:reference ?sourceEvidence; d:capturedAt ?evidenceCapturedAt . } } LIMIT ' + (specification.records.length + 1);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
// The SSH bundle embeds this exact compiled specification, never request-supplied policy.
export const jpbReadSpec = freeze({ ...specification, query: { contextGraphId: specification.contextGraphId,
  view: 'working-memory', includeContextGraphPartitions: true, sparql } });
const fail = message => { throw new Error(message); };
const literalValue = value => {
  if (value == null) return null;
  if (typeof value === 'object' && typeof value.value === 'string') return value.value;
  const literal = typeof value === 'string' && parseRdfLiteralTerm(value, { combineSurrogatePairs: true });
  if (!literal) fail('Invalid JPB RDF literal binding.');
  return literal.value;
};
export function validateJpbReadRequest(payload) {
  if (payload.orderNo !== jpbReadSpec.orderNo || Object.keys(payload).length !== 1) fail('Reviewed order required.');
}
export function normalizeJpbRead(response) {
  const spec = jpbReadSpec, selected = spec.records.map(r => r.iri), rows = response.result?.bindings;
  if (!Array.isArray(rows) || rows.length !== selected.length || new Set(rows.map(row => iriValue(row.recordVersion))).size !== selected.length)
    fail('Saved ERP selection is missing, duplicated or truncated.');
  const readAt = new Date().toISOString();
  const responseSha256 = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const records = rows.map(row => {
    const record = JSON.parse(literalValue(row.recordJson)), fields = record.fields;
    const recordVersion = iriValue(row.recordVersion);
    if (record.table !== spec.table || !selected.includes(recordVersion) || fields[spec.fields.orderNo] !== spec.orderNo
      || record.source.organisation !== spec.organisation) fail('ERP source scope differs.');
    return { ...Object.fromEntries(Object.entries(spec.fields).map(([key, field]) => [key, fields[field]])),
      recordId: recordVersion, logicalId: iriValue(row.logicalRecord),
      evidence: { contextGraphId: spec.contextGraphId, snapshot: iriValue(row.snapshot), sourceEvidence: iriValue(row.sourceEvidence),
        capturedAt: literalValue(row.evidenceCapturedAt), responseSha256, readAt, selection: spec.evidenceSelection }, meaning: spec.meaning };
  });
  if (records.map(r => r.operationCode).sort().join(',') !== [...spec.operationCodes].sort().join(',')) fail('ERP operation selection differs.');
  return { records, source: { node: spec.node, contextGraphId: spec.contextGraphId, orderNo: spec.orderNo, readAt, responseSha256,
    querySha256: createHash('sha256').update(spec.query.sparql).digest('hex'), freshSqlFetch: false, selection: spec.selection, snapshot: spec.snapshot } };
}
