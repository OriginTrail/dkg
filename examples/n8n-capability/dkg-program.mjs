import { createHash } from 'node:crypto';
import { requireDkgOperation } from './dkg-profile.mjs';
import { resolveComponentValue } from './component-values.mjs';
import { programRecords } from './program-block.mjs';

export function programRequest(node, rows, parentInvocationId, profile = null) {
  const operation = requireDkgOperation(profile, 'invoke-dkg-program');
  if (node.params.catalogRevision !== operation.catalogRevision) throw new Error('The approved Program catalog changed. Select and save the current revision.');
  const selected = operation.programs.find(p => p.id === node.params.program && p.node === node.params.node);
  if (!selected) throw new Error('Choose a reviewed Program from the selected execution profile.');
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
  // Keep receipt-verified outputs independent of the workflow's presentation mapping.
  const rawOutputs = structuredClone(result.outputs);
  programRecords([{ outputs: rawOutputs }]);
  return { rawOutputs, items: programRecords([{
    result: resolveComponentValue(request.outputMapping, rawOutputs),
    programExecution: { node: selected.node, contextGraphId: selected.contextGraphId,
      operationIri: selected.operationIri, programIri: selected.program.programIri,
      version: selected.version, sourceHash: selected.program.sourceHash,
      bindingDigest: selected.bindingDigest, invocationId, executionIri: result.executionIri,
      outputSha256: createHash('sha256').update(JSON.stringify(rawOutputs)).digest('hex') },
  }]) };
}
