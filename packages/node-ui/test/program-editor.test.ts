// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphComputer } from '@origintrail-official/dkg-graph-computer';
const { queries, programs } = vi.hoisted(() => ({ queries: vi.fn(), programs: {
  upload: vi.fn(), getSource: vi.fn(), getApproval: vi.fn(), listApprovals: vi.fn(), approve: vi.fn(), updateApproval: vi.fn(), invoke: vi.fn(), prepareInvocation: vi.fn(),
} }));
vi.mock('../src/ui/components/Programs/client.js', () => ({
  fetchProgramGraphs: async () => [{ id: 'school', name: 'School' }, { id: 'different-graph', name: 'Different graph' }],
  fetchProgramQueries: queries,
  fetchProgramTools: async () => ({ enabled: true, tools: [
    {kind: 'sparqlRead', toolIri: 'urn:dkg:tool:sparql-read', label: 'SPARQL read', description: 'Read SPARQL'},
    {kind: 'query', toolIri: 'urn:dkg:tool:query', label: 'Saved query', description: 'Run a catalog query'},
    {kind: 'assetCreation', toolIri: 'urn:dkg:tool:asset-create', label: 'Create Knowledge Asset', description: 'Create an asset'},
  ] }),
  programClient: async () => ({ programs }), fetchProgramAgents: async () => ({ defaultAddress: address, agents: [ { address, name: 'Owner' }, { address: '0x0000000000000000000000000000000000000002', name: 'Second agent' } ] }) }));
vi.mock('../src/ui/components/Wallet/WalletConnectControl.js', () => ({ WalletConnectControl: () => null }));
vi.mock('../src/ui/components/Programs/TypeScriptEditor.js', () => ({ default: ({ value, onChange, disabled }: any) =>
  React.createElement('textarea', { 'aria-label': 'source', value, disabled, onChange: (event: any) => onChange(event.target.value) }) }));
import ProgramEditor, { type ProgramEditorProps } from '../src/ui/components/Programs/ProgramEditor.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const address = '0x0000000000000000000000000000000000000001';
const operation = { graphId: 'school', operationIri: 'urn:school:total' };
const originalConfirm = window.confirm;
let container: HTMLDivElement, root: Root;
let uploaded: any;
function approval(program = uploaded, revision = 1) {
  return { contextGraphId: 'school', operationIri: operation.operationIri, revision, origin: 'api', bindingDigest: 'b'.repeat(64),
    binding: { contextGraphId: 'school', operationIri: operation.operationIri, enabled: true,
      allowedCallerAgentAddresses: [address], program: { ...program, contextGraphId: program.graphId },
      typescript: { children: [], maxCalls: 64, maxConcurrency: 4, timeoutMs: 30000 } } };
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function render(props: Partial<ProgramEditorProps> = {}) {
  await act(async () => { root.render(React.createElement(ProgramEditor, { contextGraphId: 'school', onClose: vi.fn(), onSaved: vi.fn(), ...props })); });
  await settle();
}
function button(text: string) { return [...container.querySelectorAll('button')].find(b => b.textContent === text)!; }
async function click(text: string) { const b = button(text); expect(b).toBeDefined(); expect(b.disabled).toBe(false); await act(async () => b.click()); await settle(); }
async function fill(label: string, value: string) {
  const element = label === 'source' ? container.querySelector('[aria-label="source"]')!
    : [...container.querySelectorAll('label')].find(l => l.firstChild?.textContent === label)?.querySelector('input,textarea')!;
  expect(element).toBeDefined();
  await act(async () => {
    const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function select(label: string, value: string) {
  const element = [...container.querySelectorAll('label')].find(l => l.firstChild?.textContent === label)!.querySelector('select')!;
  await act(async () => { element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); }); await settle();
}
async function pickTool(label: string) {
  await click('+ Add tool');
  const option = [...container.querySelectorAll<HTMLButtonElement>('.program-tool-option')].find(button => button.querySelector('strong')?.textContent === label)!;
  expect(option.disabled).toBe(false); await act(async () => option.click()); await settle();
}
async function ready() {
  await render(); await fill('Operation IRI', operation.operationIri);
  await click('Save new version'); await click('Check approval'); await click('Approve Program');
}
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  programs.upload.mockImplementation(async input => (uploaded = { ...input, programLayer: 'wm', sourceHash: 'a'.repeat(64), authorAgentAddress: address }));
  programs.getApproval.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
  programs.listApprovals.mockResolvedValue([]);
  queries.mockResolvedValue({ items: [] });
  programs.approve.mockImplementation(async () => approval());
  programs.updateApproval.mockImplementation(async () => approval(uploaded, 4));
  const client = new GraphComputer({ nodeUrl: 'http://node', peerId: 'peer-test', signer: { getAddress: async () => address, signMessage: async () => '' } });
  programs.prepareInvocation.mockImplementation(input => client.programs.prepareInvocation(input));
  programs.invoke.mockImplementation(async input => ({ invocationId: input.invocationId, executionIri: `urn:sr:execution:${input.invocationId}`,
    executionLayer: 'wm', persisted: true, outputs: [12], rawOutputs: ['12'] }));
  window.confirm = vi.fn(() => true);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); window.confirm = originalConfirm; vi.restoreAllMocks(); });

describe('TypeScript Program editor', () => {
  const existing = { programIri: 'urn:existing', programLayer: 'wm' as const };
  function storedProgram() {
    const program = { ...existing, graphId: 'school', sourceHash: 'a'.repeat(64), authorAgentAddress: address };
    programs.getSource.mockResolvedValue({ ...program, contextGraphId: 'school', layer: 'wm', language: 'typescript-v1',
      source: 'export function run() { return 7; }', version: '1', permittedPrograms: [] });
    return program;
  }

  it('generates bounded SPARQL permissions without granting them and requires a new version after scope changes', async () => {
    await render(); await pickTool('SPARQL read'); await fill('Row limit', '25');
    await click('Save new version');
    expect(uploaded.requiredTools).toEqual(['urn:dkg:tool:sparql-read']);
    expect(uploaded.requestedPermissions).toMatchObject({ graphId: 'school', executionLayer: 'wm', sparqlRead: {
      toolIri: 'urn:dkg:tool:sparql-read', layer: 'wm', timeoutMs: 5000, maxResultItems: 25, maxOutputBytes: 32768,
      outputSchema: { properties: { bindings: { maxItems: 25, items: { required: ['s', 'p', 'o'] } } } },
    } });
    expect(container.textContent).toContain('await invoke_tool("urn:dkg:tool:sparql-read"');
    expect(programs.approve).not.toHaveBeenCalled(); expect(programs.updateApproval).not.toHaveBeenCalled();
    await select('Operation graph', 'different-graph');
    expect(button('Run Program').disabled).toBe(true); expect(button('Save new version').disabled).toBe(false);
    await click('Save new version'); expect(uploaded.requestedPermissions.graphId).toBe('different-graph');
  });

  it('preserves a stored custom tool ID and schema until explicitly edited', async () => {
    const program = storedProgram();
    const permissions = { graphId: 'school', sparqlRead: { toolIri: 'urn:legacy:read', layer: 'wm', timeoutMs: 2000,
      maxResultItems: 10, maxOutputBytes: 8192, outputSchema: { type: 'boolean' } } };
    programs.getSource.mockResolvedValue({ ...program, contextGraphId: 'school', layer: 'wm', language: 'typescript-v1',
      source: 'export function run() { return 7; }', version: '1', requiredTools: ['urn:legacy:read'], requestedPermissions: permissions, permittedPrograms: [] });
    await render({ existing });
    expect(button('Save new version').disabled).toBe(true);
    expect(container.textContent).toContain('custom output schema is preserved');
    await fill('Read timeout (ms)', '3000'); await click('Save new version');
    expect(uploaded.requiredTools).toEqual(['urn:legacy:read']);
    expect(uploaded.requestedPermissions).toEqual({ ...permissions, sparqlRead: { ...permissions.sparqlRead, timeoutMs: 3000 } });
  });

  it('preserves invalid Advanced input and does not save it or grant access', async () => {
    await render(); await fill('Requested tool permissions (JSON)', '{ broken');
    expect(container.textContent).toContain('Correct the JSON under Advanced');
    await click('Save new version'); expect(programs.upload).not.toHaveBeenCalled();
    expect(programs.approve).not.toHaveBeenCalled();
    expect((container.querySelector('textarea[rows="9"]') as HTMLTextAreaElement).value).toBe('{ broken');
  });

  it('selects a real query and invalidates its selector when the graph changes', async () => {
    queries.mockResolvedValue({ items: [{ queryIri: 'urn:query:students', name: 'Students', catalogName: 'School queries', sparql: 'SELECT ?s WHERE { ?s ?p ?o }', parameters: [{ name: 'class', type: 'string', required: true }] }] });
    await render(); await pickTool('Saved query'); await select('Saved query', 'urn:query:students');
    await click('Save new version'); expect(uploaded.requestedPermissions.query.selector).toBe('urn:query:students');
    expect(uploaded.requiredTools).toEqual(['urn:dkg:tool:query']);
    expect(container.textContent).toContain('"class": "<class>"');
    await select('Operation graph', 'different-graph'); await click('Save new version');
    expect(programs.upload).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Select a saved query before saving');
  });

  it('selects an approved child operation and rechecks its current binding at approval time', async () => {
    await render();
    const child = approval({ ...existing, graphId: 'school', sourceHash: 'c'.repeat(64), authorAgentAddress: address });
    child.operationIri = 'urn:child:run';
    programs.listApprovals.mockResolvedValue([child, { ...child, operationIri: 'urn:disabled', binding: { ...child.binding, enabled: false } }]);
    await click('+ Add child Program');
    const option = container.querySelector<HTMLButtonElement>('.program-tool-option')!;
    await act(async () => option.click()); await settle();
    expect(container.textContent).toContain('invoke_program("urn:existing", [])');
    expect(container.textContent).not.toContain('urn:disabled');
    await fill('Operation IRI', operation.operationIri); await click('Save new version');
    expect(uploaded.permittedPrograms).toEqual(['urn:existing']);
    expect(programs.approve).not.toHaveBeenCalled();
    await click('Check approval');
    programs.getApproval.mockResolvedValue({ ...child, bindingDigest: 'd'.repeat(64) });
    await click('Approve Program');
    expect(programs.approve.mock.calls[0][0].typescript.children).toEqual([{ graphId: 'school', operationIri: 'urn:child:run', programIri: 'urn:existing', bindingDigest: 'd'.repeat(64) }]);
  });

  it('ignores saved-query responses from a graph that is no longer selected', async () => {
    let finish!: (value: any) => void;
    queries.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render(); await pickTool('Saved query');
    await select('Operation graph', 'different-graph');
    await act(async () => finish({ items: [{ queryIri: 'urn:old-query', name: 'Old graph query', catalogName: 'Old', parameters: [] }] }));
    await settle(); expect(container.textContent).not.toContain('Old graph query');
    expect(programs.approve).not.toHaveBeenCalled();
  });

  it('adds a generic write capability and removes only its own declaration', async () => {
    await render(); await pickTool('SPARQL read'); await pickTool('Create Knowledge Asset');
    await click('Save new version');
    expect(uploaded.requestedPermissions.assetCreation).toEqual({ toolIri: 'urn:dkg:tool:asset-create' });
    expect(container.textContent).toContain('does not grant arbitrary SPARQL updates');
    await act(async () => (container.querySelector('[aria-label="Remove Create Knowledge Asset"]') as HTMLButtonElement).click());
    await click('Save new version');
    expect(uploaded.requiredTools).toEqual(['urn:dkg:tool:sparql-read']);
    expect(uploaded.requestedPermissions.assetCreation).toBeUndefined();
    expect(uploaded.requestedPermissions.sparqlRead).toBeDefined();
    expect(programs.approve).not.toHaveBeenCalled();
  });

  it('loads a unique matching approval on reopen and invokes without creating a grant', async () => {
    const program = storedProgram();
    programs.listApprovals.mockResolvedValue([approval(program), approval({ ...program, graphId: 'other' })]);
    await render({ existing }); await settle();
    expect(button('Run Program').disabled).toBe(false);
    expect(programs.approve).not.toHaveBeenCalled(); expect(programs.updateApproval).not.toHaveBeenCalled();
    await fill('Arguments (JSON array)', '[]'); await click('Run Program');
    expect(programs.invoke.mock.calls[0][0]).toMatchObject({ ...operation, inputs: [] });
  });

  it('requires a choice when multiple approved operations match', async () => {
    const program = storedProgram();
    programs.listApprovals.mockResolvedValue([approval(program), { ...approval(program), operationIri: 'urn:school:second' }]);
    await render({ existing }); await settle();
    expect(button('Run Program').disabled).toBe(true);
    expect(container.textContent).toContain('Select an existing operation');
    await act(async () => {
      const select = [...container.querySelectorAll('label')].find(l => l.firstChild?.textContent === 'Existing operation')!.querySelector('select')!;
      select.value = operation.operationIri; select.dispatchEvent(new Event('change', { bubbles: true }));
    }); await settle();
    expect(button('Run Program').disabled).toBe(false);
  });

  it.each(['disabled', 'different caller', 'different version'])('does not enable a discovered approval with %s', async kind => {
    const program = storedProgram(); const value = approval(program);
    if (kind === 'disabled') value.binding.enabled = false;
    if (kind === 'different caller') value.binding.allowedCallerAgentAddresses = ['0x0000000000000000000000000000000000000002'];
    if (kind === 'different version') value.binding.program.sourceHash = 'c'.repeat(64);
    programs.listApprovals.mockResolvedValue([value]);
    await render({ existing }); await settle();
    expect(button('Run Program').disabled).toBe(true);
    expect(container.querySelector('#program-run-unavailable')?.textContent).toBeTruthy();
    expect(programs.approve).not.toHaveBeenCalled();
  });

  it('ignores discovery for an operation graph that has changed', async () => {
    const program = storedProgram(); let finish!: (value: any) => void;
    programs.listApprovals.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await render({ existing });
    await fill('Operation graph ID', 'different-graph');
    await act(async () => finish([approval(program)])); await settle();
    expect(button('Run Program').disabled).toBe(true);
    expect(container.querySelector('#program-run-unavailable')?.textContent).toContain('Operation IRI');
  });

  it('persists and displays requested tool permissions before owner approval', async () => {
    const permissions = {graphId: 'school', assetCreation: {toolIri: 'urn:school:write'}};
    await render(); await fill('Operation IRI', operation.operationIri);
    await fill('Tool IRIs', 'urn:school:write');
    await fill('Requested tool permissions (JSON)', JSON.stringify(permissions));
    await click('Save new version');
    expect(programs.upload.mock.calls[0][0]).toMatchObject({requiredTools: ['urn:school:write'], requestedPermissions: permissions});
    expect(container.querySelector('[aria-label="Permissions to approve"]')?.textContent).toContain('assetCreation');
    expect(programs.approve).not.toHaveBeenCalled();
    await click('Check approval'); await click('Approve Program');
    expect(programs.approve.mock.calls[0][0]).toMatchObject(permissions);
    await fill('Requested tool permissions (JSON)', JSON.stringify({...permissions, executionLayer: 'swm'}));
    expect(button('Run Program').disabled).toBe(true);
    expect(button('Save new version').disabled).toBe(false);
  });

  it('saves source without granting permission, explicitly approves, then invokes the saved Program', async () => {
    await render(); await fill('Operation IRI', operation.operationIri); await click('Save new version');
    expect(programs.approve).not.toHaveBeenCalled();
    expect(button('Run Program').disabled).toBe(true);
    expect(programs.upload.mock.calls[0][0]).toMatchObject({ graphId: 'school', language: 'typescript-v1', requiredTools: [], permittedPrograms: [] });
    await click('Check approval'); await click('Approve Program'); await click('Run Program');
    expect(programs.approve.mock.calls[0][0]).toMatchObject({ ...operation, allowedCallers: [address], program: uploaded, typescript: { children: [] } });
    expect(programs.invoke.mock.calls[0][0].inputs).toEqual([[1, 2, 3]]);
    expect(container.textContent).toContain('Execution completed');
    const oldIri = uploaded.programIri;
    await fill('source', 'export function run() { return 99; }');
    expect(button('Retry same invocation').disabled).toBe(true);
    await click('Save new version');
    expect(uploaded.programIri).not.toBe(oldIri);
    expect(uploaded.derivedFrom).toBe(oldIri);
  });

  it('retains an uncertain invocation ID and refuses to retry it with different inputs', async () => {
    await ready(); programs.invoke.mockRejectedValueOnce(new Error('Network response lost'));
    await click('Run Program'); const id = programs.invoke.mock.calls[0][0].invocationId;
    await click('Retry same invocation'); expect(programs.invoke.mock.calls[1][0].invocationId).toBe(id);
    await fill('Arguments (JSON array)', '[[9]]'); await click('Retry same invocation');
    expect(programs.invoke).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('inputs differ');
    await click('New execution'); await click('Run Program');
    expect(programs.invoke.mock.calls[2][0].invocationId).not.toBe(id);
  });

  it('shows compilation failures and never enables execution', async () => {
    programs.approve.mockRejectedValue(new Error('PROGRAM_COMPILATION_FAILED: unsupported import'));
    await ready();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('unsupported import');
    expect(button('Run Program').disabled).toBe(true);
  });

  it('updates only the reviewed approval revision and surfaces a conflict without retry', async () => {
    await render(); await fill('Operation IRI', operation.operationIri); await click('Save new version');
    programs.getApproval.mockResolvedValue(approval({ ...uploaded, programIri: 'urn:old' }, 3));
    await click('Check approval'); programs.updateApproval.mockRejectedValue(new Error('PROGRAM_CONFIGURATION_CONFLICT'));
    await click('Replace approval');
    expect(programs.updateApproval.mock.calls[0][0].expectedRevision).toBe(3);
    expect(programs.updateApproval).toHaveBeenCalledTimes(1);
    expect(button('Run Program').disabled).toBe(true);
  });

  it('automatically loads stored source with the node agent, without a browser wallet', async () => {
    const existing = { programIri: 'urn:existing', programLayer: 'wm' as const };
    programs.getSource.mockResolvedValue({ contextGraphId: 'school', programIri: existing.programIri, layer: 'wm',
      language: 'typescript-v1', source: 'export function run() { return 7; }', sourceHash: 'a'.repeat(64),
      authorAgentAddress: address, version: '2', permittedPrograms: [] });
    await render({ existing }); expect(programs.getSource).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain('Connect wallet');
    expect((container.querySelector('[aria-label="source"]') as HTMLTextAreaElement).value).toContain('return 7');
    expect(button('Save new version').disabled).toBe(true);
    await fill('source', 'export function run() { return 8; }'); await click('Save new version');
    expect(uploaded.derivedFrom).toBe(existing.programIri);
  });

  it('does not restore approval from an action completed after the selected node agent changes', async () => {
    await render(); await fill('Operation IRI', operation.operationIri); await click('Save new version'); await click('Check approval');
    let finish!: (value: any) => void;
    programs.approve.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await click('Approve Program');
    await act(async () => { const select = container.querySelector('select')!; select.disabled = false; select.value = '0x0000000000000000000000000000000000000002'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => finish(approval())); await settle();
    expect(button('Run Program').disabled).toBe(true);
  });

  it('shows source-load failures and permits an explicit retry without allowing a blank save', async () => {
    programs.getSource.mockRejectedValueOnce(new Error('Source access denied'));
    programs.getSource.mockResolvedValue({ contextGraphId: 'school', programIri: 'urn:existing', layer: 'wm',
      language: 'typescript-v1', source: 'export function run() { return 7; }', sourceHash: 'a'.repeat(64),
      authorAgentAddress: address, version: '2', permittedPrograms: [] });
    await render({ existing: { programIri: 'urn:existing', programLayer: 'wm' } });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Source access denied');
    expect(button('Save new version').disabled).toBe(true);
    await click('Reload stored source');
    expect((container.querySelector('[aria-label="source"]') as HTMLTextAreaElement).value).toContain('return 7');
  });

  it('does not treat the same Program IRI in a different graph as the saved Program', async () => {
    await render(); await fill('Operation IRI', operation.operationIri); await click('Save new version');
    programs.getApproval.mockResolvedValue(approval({ ...uploaded, graphId: 'different-graph' }));
    await click('Check approval');
    expect(button('Run Program').disabled).toBe(true);
  });

  it('restores an uncertain execution after reopening and refuses to reuse it after approval changes', async () => {
    await ready(); programs.invoke.mockRejectedValueOnce(new Error('Response lost'));
    await click('Run Program'); const id = programs.invoke.mock.calls[0][0].invocationId;
    await act(async () => root.unmount()); root = createRoot(container);
    const previous = uploaded;
    programs.getSource.mockResolvedValue({ ...previous, contextGraphId: 'school', layer: 'wm',
      language: 'typescript-v1', source: previous.source, permittedPrograms: [] });
    await render({ existing: { programIri: previous.programIri, programLayer: 'wm' } });
    await fill('Operation IRI', operation.operationIri);
    programs.getApproval.mockResolvedValue(approval(previous)); await click('Check approval');
    await click('Retry same invocation'); expect(programs.invoke.mock.calls[1][0].invocationId).toBe(id);
    programs.getApproval.mockResolvedValue({ ...approval(previous, 2), bindingDigest: 'c'.repeat(64) });
    await click('Check approval'); await click('Retry same invocation');
    expect(programs.invoke).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('approval changed');
  });
});
