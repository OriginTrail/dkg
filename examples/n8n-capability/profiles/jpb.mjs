/** Explicit opt-in DMaaST demo profile. Importing it never contacts the node. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { remote, remoteScripts } from '../jpb-output.mjs';
import { componentEvidence, JPB_SOURCE, JPB_TARGET, JPB_WORKBOOK } from './jpb-evidence.mjs';
const fail = message => { throw Object.assign(new Error(message), { status: 409, code: 'DKG_COMPONENT_UNCONFIRMED' }); };
const programs = JSON.parse(readFileSync(new URL('../jpb-programs.json', import.meta.url), 'utf8'));
const catalogRevision = createHash('sha256').update(JSON.stringify(programs)).digest('hex').slice(0, 16);
const choice = (label, value, options = [value]) => ({ type: 'string', label, default: value, maxLength: 256, options });
const revision = createHash('sha256');
for (const file of ['./jpb.mjs', './jpb-evidence.mjs', '../jpb-programs.json', '../jpb-output.mjs', '../jpb-read.py', '../jpb-write.py', '../jpb-invoke-program.py'])
  revision.update(file.endsWith('.py') ? remoteScripts[file.slice(3)] : readFileSync(new URL(file, import.meta.url)));
export default {
  id: 'dmaast-jpb', revision: revision.digest('hex'), node: 'JPB', targetGraph: JPB_TARGET,
  programs, catalogRevision,
  parameters: {
    'dkg-read': { node: choice('Source node', 'JPB'), contextGraph: choice('Source Context Graph', JPB_SOURCE), orderNo: choice('Saved ERP order · CUT, USILU, EBAVM', '62633') },
    'invoke-dkg-program': { node: choice('Execution node', 'JPB'), program: choice('Approved Program', programs[0].id, programs.map(p => p.id)), catalogRevision: choice('Approved catalog revision', catalogRevision) },
    'dkg-write': { node: choice('Destination node', 'JPB'), contextGraph: choice('Destination Context Graph', JPB_TARGET), outputKind: choice('Output · private Working Memory', 'PLCAInputEvidence') },
  },
  sampleItems: { 'dkg-read': [{ workbook: [] }], 'dkg-write': [{}], 'invoke-dkg-program': [{}] },
  enabled(id) {
    return process.env[{ 'dkg-read': 'NOS_JPB_READ_ENABLED', 'dkg-write': 'NOS_JPB_WRITE_ENABLED', 'invoke-dkg-program': 'NOS_JPB_PROGRAM_ENABLED' }[id]] === '1';
  },
  loadInputs() {
    const file = process.env.NOS_JPB_WORKBOOK_INPUT_FILE;
    if (!file) return [];
    const rows = JSON.parse(readFileSync(file, 'utf8'))[0]?.workbook;
    if (!Array.isArray(rows) || rows.length !== 4 || rows.some(r => r.evidence?.contentDigest !== JPB_WORKBOOK))
      fail('Configure the reviewed workbook revision before enabling JPB effects.');
    return rows;
  },
  validateInput(definition, input, approvedWorkbook) {
    if (definition.nodes.some(n => ['dkg-write', 'invoke-dkg-program'].includes(n.componentId)) &&
      (!approvedWorkbook.length || !isDeepStrictEqual(JSON.parse(input.itemsJson)[0]?.workbook, approvedWorkbook)))
      fail('Use the reviewed workbook rows and revision for this JPB demo.');
  },
  validateNode(node, rows, input) {
    if (node.params.node !== 'JPB' || node.componentId !== 'invoke-dkg-program' &&
      node.params.contextGraph !== (node.componentId === 'dkg-read' ? JPB_SOURCE : JPB_TARGET)) fail('JPB Context Graph scope mismatch.');
    if (node.componentId === 'dkg-read' && (node.params.orderNo !== '62633' || !isDeepStrictEqual(rows, JSON.parse(input.itemsJson)) || rows.length !== 1 || Object.hasOwn(rows[0], 'erp')))
      fail('DKG Read takes one workbook batch and reads saved JPB order 62633. Do not supply ERP records.');
  },
  readRequest: node => ({ orderNo: node.params.orderNo }),
  readItems(rows, result) {
    if (result.source?.contextGraphId !== JPB_SOURCE || !Array.isArray(result.records) || result.records.length !== 3 ||
      result.records.some(r => r.orderNo !== '62633' || r.evidence?.contextGraphId !== JPB_SOURCE)) fail('JPB source response does not match the selected scope.');
    return [{ ...rows[0], erp: result.records }];
  },
  evidence(rows, context, read, input, programOutput) {
    const evidenceRows = programOutput ? programOutput.result?.records : rows;
    return {
      payload: componentEvidence(evidenceRows, context, read, JSON.parse(input.itemsJson)[0].workbook ?? [], programOutput),
      recordCount: evidenceRows.length,
      summary: { plcaCalculated: programOutput?.result?.assessment?.calculated === true,
        ...(programOutput ? { assessment: programOutput.result.assessment, programExecution: programOutput.programExecution } : {}) },
    };
  },
  transport(payload, operation) {
    const script = { read: 'jpb-read.py', invoke: 'jpb-invoke-program.py', write: 'jpb-write.py' }[operation];
    if (!script) fail('Unknown DKG operation.');
    return remote(payload, script);
  },
};
