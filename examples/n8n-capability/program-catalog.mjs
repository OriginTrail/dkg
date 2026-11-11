import { mapWithConcurrency } from '../../packages/agent/dist/map-with-concurrency.js';
import { isProgramReference, programDescriptor } from './program-block.mjs';
import { componentNeedsExport } from './component-registry.mjs';

/** Only current, caller-approved source pins in this PoC's private graph are offered. */
export function createProgramCatalog({ graphId, owner, client, definitions }) {
  return async function listPrograms() {
    const approvals = await client.programs.listApprovals({ graphId });
    const key = (graph, operation) => JSON.stringify([graph, operation]);
    const bindings = new Map(approvals.map(a => [key(graphId, a.operationIri), Promise.resolve(a.binding)]));
    let remaining = 128, traversals = 512;
    const resolve = async (graph, operation) => {
      if (typeof graph !== 'string' || typeof operation !== 'string') return undefined;
      const id = key(graph, operation);
      if (!bindings.has(id)) {
        if (remaining-- <= 0) return undefined;
        bindings.set(id, client.programs.getApproval({ graphId: graph, operationIri: operation })
          .then(a => a.binding).catch(() => undefined));
      }
      const binding = await bindings.get(id);
      return binding?.contextGraphId === graph && binding.operationIri === operation && binding.enabled ? binding : undefined;
    };
    const requiresExport = async (binding, seen = new Set()) => {
      if (!binding || traversals-- <= 0) return true;
      const id = key(binding.contextGraphId, binding.operationIri);
      if (seen.has(id) || seen.size >= 32) return true;
      seen.add(id);
      if (binding.n8n) {
        const known = definitions.find(d => d.grant?.workflowId === binding.n8n.workflowId && d.grant.workflowSha256 === binding.n8n.workflowSha256);
        if (!known || known.requiresExportAuthorization || componentNeedsExport(known.descriptor) || known.kind === 'google-sheets-export') return true;
      }
      for (const pin of binding.typescript?.children ?? [])
        if (await requiresExport(await resolve(pin.contextGraphId, pin.operationIri), new Set(seen))) return true;
      return false;
    };
    const eligible = approvals.map(a => a.binding).filter(b => {
      const ref = b.program;
      return b.enabled && b.contextGraphId === graphId && ref.contextGraphId === graphId && ref.programLayer === 'wm'
        && b.executorAgentAddress.toLowerCase() === owner.toLowerCase()
        && b.allowedCallerAgentAddresses.some(a => a.toLowerCase() === owner.toLowerCase())
        && !definitions.some(d => d.kaRef === ref.programIri)
        && !/^urn:demo:nos:(?:studio|workflow):/.test(ref.programIri);
    });
    const sources = await mapWithConcurrency(eligible, 4, b =>
      client.programs.getSource({ graphId, programIri: b.program.programIri, programLayer: 'wm' }));
    const programs = [];
    // Metadata reads are independent; policy traversal consumes shared budgets in approval order.
    for (const [index, b] of eligible.entries()) {
      const ref = b.program, source = sources[index];
      if (source.sourceHash !== ref.sourceHash || source.authorAgentAddress.toLowerCase() !== ref.authorAgentAddress.toLowerCase()) continue;
      // Run Program KA always passes one mapped argument; sexpr-v1 accepts none.
      if (source.language !== 'typescript-v1') continue;
      if (!isProgramReference(ref.programIri) || b.operationIri.length > programDescriptor.parameters.operationIri.maxLength
        || !source.version || source.version.length > programDescriptor.parameters.version.maxLength) continue;
      if (programs.length >= 32) throw Object.assign(new Error('The Program selector supports 32 approved versions in this PoC.'), { code: 'INVALID_WORKFLOW', status: 409 });
      programs.push({ kind: 'program', kaRef: ref.programIri, sourceHash: source.sourceHash, graphId,
        operationIri: b.operationIri, authorAgentAddress: source.authorAgentAddress,
        name: (source.label ?? ref.programIri).slice(0, 80), version: source.version, language: source.language,
        available: true, requiresExportAuthorization: await requiresExport(b), descriptor: programDescriptor });
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
