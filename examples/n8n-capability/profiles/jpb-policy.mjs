/** Shared JPB business policy; no SSH or nOS transport dependencies. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canonicalizeJson } from '../../../packages/core/dist/index.js';
import { componentEvidence, JPB_SOURCE, JPB_TARGET, JPB_WORKBOOK } from './jpb-evidence.mjs';
import { jpbReadSpec, jpbReadPolicyRevision } from './jpb-read-policy.mjs';
const fail = message => { throw Object.assign(new Error(message), { status: 409, code: 'DKG_COMPONENT_UNCONFIRMED' }); };
export const loadJpbPrograms = () => JSON.parse(readFileSync(new URL('../jpb-programs.json', import.meta.url), 'utf8'));
export function createJpbPolicy(programs = loadJpbPrograms()) {
  const catalogRevision = createHash('sha256').update(JSON.stringify(programs)).digest('hex').slice(0, 16);
  const choice = (label, value, options = [value]) => ({ type: 'string', label, default: value, maxLength: 256, options });
  // Snapshot policy once: installation, invocation and revision use the same bytes.
  const workbookFile = process.env.NOS_JPB_WORKBOOK_INPUT_FILE;
  const approvedWorkbook = workbookFile ? JSON.parse(readFileSync(workbookFile, 'utf8'))[0]?.workbook : [];
  if (workbookFile && (!Array.isArray(approvedWorkbook) || approvedWorkbook.length !== 4 ||
    approvedWorkbook.some(r => !r || typeof r !== 'object' || Array.isArray(r) || r.evidence?.contentDigest !== JPB_WORKBOOK)))
    fail('Configure the reviewed workbook revision before enabling JPB effects.');
  const workbookDigest = createHash('sha256').update(canonicalizeJson(approvedWorkbook, { maxBytes: 8192, maxDepth: 30 })).digest('hex');
  const revision = createHash('sha256');
  for (const file of ['./jpb-policy.mjs', './jpb-evidence.mjs']) revision.update(readFileSync(new URL(file, import.meta.url)));
  revision.update('\0read-policy\0').update(jpbReadPolicyRevision);
  revision.update('\0programs\0').update(JSON.stringify(programs));
  revision.update('\0approved-workbook\0').update(workbookDigest);
  return {
    revision: revision.digest('hex'), node: 'JPB', targetGraph: JPB_TARGET,
    programs, catalogRevision,
    parameters: {
      'dkg-read': { node: choice('Source node', 'JPB'), contextGraph: choice('Source Context Graph', JPB_SOURCE), orderNo: choice('Saved ERP order · ' + jpbReadSpec.operationCodes.join(', '), jpbReadSpec.orderNo) },
      'invoke-dkg-program': { node: choice('Execution node', 'JPB'), program: choice('Approved Program', programs[0].id, programs.map(p => p.id)), catalogRevision: choice('Approved catalog revision', catalogRevision) },
      'dkg-write': { node: choice('Destination node', 'JPB'), contextGraph: choice('Destination Context Graph', JPB_TARGET), outputKind: choice('Output · private Working Memory', 'PLCAInputEvidence') },
    },
    sampleItems: { 'dkg-read': [{ workbook: [] }], 'dkg-write': [{}], 'invoke-dkg-program': [{}] },
    enabled(id) {
      return process.env[{ 'dkg-read': 'NOS_JPB_READ_ENABLED', 'dkg-write': 'NOS_JPB_WRITE_ENABLED', 'invoke-dkg-program': 'NOS_JPB_PROGRAM_ENABLED' }[id]] === '1';
    },
    loadInputs: () => structuredClone(approvedWorkbook),
    validateInput(definition, input, approvedWorkbook) {
      if (definition.nodes.some(n => ['dkg-write', 'invoke-dkg-program'].includes(n.componentId)) &&
        (!approvedWorkbook.length || !isDeepStrictEqual(JSON.parse(input.itemsJson)[0]?.workbook, approvedWorkbook)))
        fail('Use the reviewed workbook rows and revision for this JPB demo.');
    },
    validateNode(node, rows, input) {
      if (node.params.node !== 'JPB' || node.componentId !== 'invoke-dkg-program' &&
        node.params.contextGraph !== (node.componentId === 'dkg-read' ? JPB_SOURCE : JPB_TARGET)) fail('JPB Context Graph scope mismatch.');
      if (node.componentId === 'dkg-read' && (node.params.orderNo !== jpbReadSpec.orderNo || !isDeepStrictEqual(rows, JSON.parse(input.itemsJson)) || rows.length !== 1 || Object.hasOwn(rows[0], 'erp')))
        fail('DKG Read takes one workbook batch and reads saved JPB order ' + jpbReadSpec.orderNo + '. Do not supply ERP records.');
    },
    readRequest: node => ({ orderNo: node.params.orderNo }),
    readItems(rows, result) {
      if (result.source?.contextGraphId !== JPB_SOURCE || !Array.isArray(result.records) || result.records.length !== jpbReadSpec.records.length ||
        result.records.some(r => r.orderNo !== jpbReadSpec.orderNo || r.evidence?.contextGraphId !== JPB_SOURCE)) fail('JPB source response does not match the selected scope.');
      return [{ ...rows[0], erp: result.records }];
    },
    evidence(rows, context, read, input, programContext) {
      const evidenceRows = programContext ? rows[0]?.result?.records : rows;
      if (programContext && !isDeepStrictEqual(rows[0]?.result?.assessment, programContext.rawOutputs?.[0]?.assessment))
        fail('Calculated evidence must preserve the verified Program output assessment and records.');
      return {
        payload: componentEvidence(evidenceRows, context, read, JSON.parse(input.itemsJson)[0].workbook ?? [], programContext),
        recordCount: evidenceRows.length,
        summary: { plcaCalculated: programContext?.rawOutputs?.[0]?.assessment?.calculated === true,
          ...(programContext ? { assessment: programContext.rawOutputs[0].assessment, programExecution: programContext.receipt } : {}) },
      };
    },
  };
}
