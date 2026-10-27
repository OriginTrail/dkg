import { programDescriptor } from './program-block.mjs';

/** Only current, caller-approved source pins in this PoC's private graph are offered. */
export function createProgramCatalog({ graphId, owner, client, definitions }) {
  return async function listPrograms() {
    const approvals = await client.programs.listApprovals({ graphId });
    const byOperation = new Map(approvals.map(a => [a.operationIri, a.binding]));
    const requiresExport = (binding, seen = new Set()) => {
      if (!binding || seen.has(binding.operationIri)) return true;
      seen.add(binding.operationIri);
      if (binding.n8n) {
        const known = definitions.find(d => d.grant.workflowId === binding.n8n.workflowId);
        if (!known || known.requiresExportAuthorization || known.descriptor?.writes || known.kind === 'google-sheets-export') return true;
      }
      return (binding.typescript?.children ?? []).some(pin => requiresExport(byOperation.get(pin.operationIri), new Set(seen)));
    };
    const programs = [];
    for (const approval of approvals) {
      const b = approval.binding, ref = b.program;
      if (!b.enabled || b.contextGraphId !== graphId || ref.contextGraphId !== graphId || ref.programLayer !== 'wm'
        || b.executorAgentAddress.toLowerCase() !== owner.toLowerCase()
        || !b.allowedCallerAgentAddresses.some(a => a.toLowerCase() === owner.toLowerCase())
        || definitions.some(d => d.kaRef === ref.programIri)
        || /^urn:demo:nos:(?:studio|workflow):/.test(ref.programIri)) continue;
      if (programs.length >= 32) throw Object.assign(new Error('The Program selector supports 32 approved versions in this PoC.'), { code: 'INVALID_WORKFLOW', status: 409 });
      const source = await client.programs.getSource({ graphId, programIri: ref.programIri, programLayer: 'wm' });
      if (source.sourceHash !== ref.sourceHash || source.authorAgentAddress.toLowerCase() !== ref.authorAgentAddress.toLowerCase()) continue;
      if (ref.programIri.length > 240 || b.operationIri.length > 240 || !source.version || source.version.length > 80) continue;
      programs.push({ kind: 'program', kaRef: ref.programIri, sourceHash: source.sourceHash, graphId,
        operationIri: b.operationIri, authorAgentAddress: source.authorAgentAddress,
        name: (source.label ?? ref.programIri).slice(0, 80), version: source.version, language: source.language,
        available: true, requiresExportAuthorization: requiresExport(b), descriptor: programDescriptor });
    }
    return programs.sort((a, b) => a.name.localeCompare(b.name) || b.version.localeCompare(a.version) || a.operationIri.localeCompare(b.operationIri));
  };
}

export async function installProgramExamples(client, graphId, owner) {
  for (const version of ['1.0.0', '2.0.0']) {
    const programIri = 'urn:demo:program:scale-number:' + version;
    const source = `export function run(input: { value: number; factor?: number }) {
      if (!input || typeof input.value !== 'number' || !Number.isFinite(input.value)
        || input.factor !== undefined && (typeof input.factor !== 'number' || !Number.isFinite(input.factor))) throw new Error('Supply a numeric value and optional numeric factor.');
      const factor = input.factor ?? 2;
      return { result: input.value * factor${version === '2.0.0' ? ', input: input.value, factor' : ''} };
    }`;
    let program;
    try { program = await client.programs.getSource({ graphId, programIri, programLayer: 'wm' }); }
    catch (error) { if (error.code !== 'PROGRAM_NOT_FOUND') throw error; }
    if (!program) program = await client.programs.upload({ graphId, programIri, name: 'scale-number-' + version,
      label: 'Scale number', language: 'typescript-v1', version, source, requiredTools: [], permittedPrograms: [] });
    else {
      if (program.source !== source || program.version !== version) throw new Error('The example Program revision changed.');
      program = { graphId, programIri, programLayer: 'wm', authorAgentAddress: program.authorAgentAddress, sourceHash: program.sourceHash };
    }
    let approval;
    try { approval = await client.programs.getApproval({ graphId, operationIri: programIri }); }
    catch (error) { if (error.status !== 404) throw error; }
    // A revoked existing approval is never silently re-enabled.
    if (!approval) await client.programs.approve({ graphId, operationIri: programIri, program, allowedCallers: [owner],
      typescript: { children: [], maxCalls: 1, maxConcurrency: 1, timeoutMs: 5000 } });
  }
}
