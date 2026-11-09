import { createHash } from 'node:crypto';
import { iriValue, literalValue } from '../../../packages/cli/dist/semantic-runtime-values.js';
const graph = "0xf77258a965ba13adc77bca85da7c6a287272959a/jpb-data";
const snapshot = "urn:dmaast:jpb:trace:snapshot:6876805538656718c1b000b3b141edeccbef8465076ee8f81d4c7ac95d46591a";
const selected = ["urn:dmaast:jpb:trace:record:bf97e8ad8bb03b08c855013bfde5d8b4371f76458adfb1aef8da298f25e4bfda", "urn:dmaast:jpb:trace:record:cbf0c0755a087cc12b70234e7e9a8d3ea88d4bd75c822cf12de230962665ec2e", "urn:dmaast:jpb:trace:record:3789e86fc7cc194875b600483ee6930267f262959f5a36ebe8d94b3912ed7906"];
const fail = message => { throw new Error(message); };
export async function readJpbThroughNos(call, payload) {
  if (payload.orderNo !== '62633' || Object.keys(payload).length !== 1) fail('Reviewed order required.');
  const prefix = 'did:dkg:context-graph:' + graph + '/_working_memory/0xf77258a965ba13adc77bca85da7c6a287272959a/';
  const branches = selected.map((iri, i) => '{ GRAPH <' + prefix + ['4085', '14902', '4081'][i] + '> { VALUES ?recordVersion { <' + iri + '> } ?recordVersion d:traceabilityRecordJson ?recordJson; d:logicalId ?logicalRecord . } }');
  const sparql = 'PREFIX d: <https://dmaast.eu/ontology/> SELECT DISTINCT ?recordVersion ?recordJson ?logicalRecord ?snapshot ?sourceEvidence ?evidenceCapturedAt WHERE { { ' + branches.join(' UNION ') + ' } GRAPH <' + prefix + '17347> { VALUES ?snapshot { <' + snapshot + '> } ?snapshot d:hasRecord ?recordVersion; d:supportedBy ?evidenceVersion . ?evidenceVersion d:reference ?sourceEvidence; d:capturedAt ?evidenceCapturedAt . } } LIMIT 4';
  const response = await call('query', { contextGraphId: graph, view: 'working-memory', includeContextGraphPartitions: true, sparql });
  const rows = response.result?.bindings;
  if (!Array.isArray(rows) || rows.length !== 3) fail('Saved ERP selection is missing, duplicated or truncated.');
  const readAt = new Date().toISOString();
  const responseSha256 = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const records = rows.map(row => {
    const record = JSON.parse(literalValue(row.recordJson)), f = record.fields;
    const recordVersion = iriValue(row.recordVersion);
    if (record.table !== 'GAMME' || !selected.includes(recordVersion) || f.NAF !== '62633' || record.source.organisation !== 'JPB') fail('ERP source scope differs.');
    return { operationCode: f.COFRAIS, recordId: recordVersion, logicalId: iriValue(row.logicalRecord), orderNo: f.NAF,
      partNumber: f.PARTNUMBER, routePhase: f.PHASE, operation: f.GA_DES,
      evidence: { contextGraphId: graph, snapshot: iriValue(row.snapshot), sourceEvidence: iriValue(row.sourceEvidence), capturedAt: literalValue(row.evidenceCapturedAt),
        responseSha256, readAt, selection: 'pinned-snapshot; not latest SQL state' }, meaning: 'planned-route-reference; not operation execution' };
  });
  if (records.map(r => r.operationCode).sort().join(',') !== 'CUT,EBAVM,USILU') fail('ERP operation selection differs.');
  return { records, source: { node: 'JPB', contextGraphId: graph, orderNo: '62633', readAt, responseSha256,
    querySha256: createHash('sha256').update(sparql).digest('hex'), freshSqlFetch: false, selection: 'pinned-snapshot', snapshot } };
}
