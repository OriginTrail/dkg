import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolveComponentValue } from './component-values.mjs';
import { programRecords } from './program-block.mjs';

// Reviewed remote references, never browser-selected endpoints or executable text.
export const jpbPrograms = JSON.parse(readFileSync(new URL('./jpb-programs.json', import.meta.url), 'utf8'));
export const jpbProgramCatalogRevision = createHash('sha256').update(JSON.stringify(jpbPrograms)).digest('hex').slice(0, 16);
export function programRequest(node, rows, parentInvocationId) {
  if (node.params.catalogRevision !== jpbProgramCatalogRevision) throw new Error('The approved Program catalog changed. Select and save the current revision.');
  const selected = jpbPrograms.find(p => p.id === node.params.program && p.node === node.params.node);
  if (!selected) throw new Error('Choose a reviewed JPB Program.');
  const inputs = resolveComponentValue(node.params.inputs, rows);
  if (!Array.isArray(inputs) || inputs.length > 8 || JSON.stringify(inputs).length > 8192)
    throw new Error('Program arguments must be a JSON array of up to eight bounded arguments.');
  // Apply the same JSON restrictions as other Program calls, including null preservation.
  programRecords(inputs);
  const bytes = createHash('sha256').update(JSON.stringify([parentInvocationId, node.id])).digest();
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  const invocationId = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
  return { selected, invocationId, inputs, outputMapping: node.params.outputMapping };
}
export function programResult(result, request) {
  const { selected, invocationId } = request;
  if (result?.invocationId !== invocationId || result.operationIri !== selected.operationIri
    || result.sourceHash !== selected.program.sourceHash || result.bindingDigest !== selected.bindingDigest
    || result.executionIri !== 'urn:sr:execution:' + invocationId || !Array.isArray(result.outputs))
    throw new Error('The remote Program receipt does not match this pinned invocation.');
  return { items: programRecords([{
    result: resolveComponentValue(request.outputMapping, result.outputs),
    programExecution: { node: 'JPB', contextGraphId: selected.contextGraphId,
      operationIri: selected.operationIri, programIri: selected.program.programIri,
      version: selected.version, sourceHash: selected.program.sourceHash,
      bindingDigest: selected.bindingDigest, invocationId, executionIri: result.executionIri,
      outputSha256: createHash('sha256').update(JSON.stringify(result.outputs)).digest('hex') },
  }]) };
}
