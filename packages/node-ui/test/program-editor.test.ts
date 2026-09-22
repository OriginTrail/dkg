// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphComputer } from '@origintrail-official/dkg-graph-computer';
const { programs } = vi.hoisted(() => ({ programs: {
  upload: vi.fn(), getSource: vi.fn(), getApproval: vi.fn(), approve: vi.fn(), updateApproval: vi.fn(), invoke: vi.fn(), prepareInvocation: vi.fn(),
} }));
vi.mock('../src/ui/components/Programs/client.js', () => ({ programClient: async () => ({ programs }), fetchProgramAgents: async () => ({ defaultAddress: address, agents: [ { address, name: 'Owner' }, { address: '0x0000000000000000000000000000000000000002', name: 'Second agent' } ] }) }));
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
async function ready() {
  await render(); await fill('Operation IRI', operation.operationIri);
  await click('Save new version'); await click('Check approval'); await click('Approve Program');
}
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  programs.upload.mockImplementation(async input => (uploaded = { ...input, programLayer: 'wm', sourceHash: 'a'.repeat(64), authorAgentAddress: address }));
  programs.getApproval.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
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
