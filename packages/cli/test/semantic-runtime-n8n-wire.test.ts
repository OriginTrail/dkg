import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeN8nWorkflowSnapshot, n8nWorkflowSha256 } from '../src/semantic-runtime-n8n-contract.js';
import { pinnedN8nPublishedWorkflow } from '../src/semantic-runtime-n8n-wire.js';

const snapshot = () => ({ versionId: 'version-1', providerMetadata: { retained: true }, nodes: [
  { id: 'first', name: 'First', type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: {}, providerNodeField: 'retained' },
  { id: 'last', name: 'Last', type: 'n8n-nodes-base.set', parameters: {} },
], connections: { First: { main: [null, [{ node: 'Last', type: 'main', index: 0, providerEdgeField: 'retained' }]] } },
settings: { executionOrder: 'v1', providerSetting: 'retained' } });

describe('validated n8n provider workflows', () => {
  it('preserves extra provider fields, null ports and complete serialized snapshots', () => {
    const value = snapshot(), bytes = JSON.stringify(value), digest = n8nWorkflowSha256(value);
    const decoded = decodeN8nWorkflowSnapshot(value);
    expect(decoded).toBe(value);
    expect(JSON.stringify(decoded)).toBe(bytes); expect(n8nWorkflowSha256(decoded)).toBe(digest);
    const pinned = pinnedN8nPublishedWorkflow({ id: 'workflow', active: true, settings: value.settings, activeVersion: value },
      { workflowId: 'workflow', workflowSha256: digest });
    expect(pinned).toEqual(value);
    expect(pinned.nodes.map(node => node.name)).toEqual(['First', 'Last']);
    expect(pinned.connections.First.main[1]?.[0].providerEdgeField).toBe('retained');
  });

  it('does not insert missing settings, parameters or optional node properties', () => {
    const value = { versionId: null, nodes: [{ name: 'First', type: 'n8n-nodes-base.set' }], connections: {} };
    expect(decodeN8nWorkflowSnapshot(value)).toBe(value);
    expect(JSON.stringify(decodeN8nWorkflowSnapshot(value))).toBe(JSON.stringify(value));
  });

  it.each([
    { nodes: [null] }, { nodes: [{ name: 'First', type: 7 }] },
    { nodes: [{ name: 7, type: 'n8n-nodes-base.set' }] },
    { nodes: [{ name: 'First', type: 'n8n-nodes-base.set', parameters: [] }] },
    { connections: { First: [] } }, { connections: { First: { main: {} } } },
    { connections: { First: { main: [[{ node: 'Last', type: 'main', index: -1 }]] } } },
    { connections: { First: { main: [[{ node: 'Last', type: 'main', index: '0' }]] } } },
    { settings: [] }, { nodes: [{ id: 7, name: 'First', type: 'n8n-nodes-base.set' }] },
  ])('rejects malformed workflow structure %j at decoding', patch => {
    expect(() => decodeN8nWorkflowSnapshot({ ...snapshot(), ...patch })).toThrow('INVALID_N8N_WORKFLOW');
  });

  it('pins the published graph and top-level settings rather than the draft graph', () => {
    const value = snapshot(), grant = { workflowId: 'workflow', workflowSha256: n8nWorkflowSha256(value) };
    const provider = { id: grant.workflowId, active: true, nodes: [], connections: {}, settings: value.settings,
      activeVersion: { ...value, settings: { draftOnly: true } } };
    expect(pinnedN8nPublishedWorkflow(provider, grant)).toEqual(value);
    expect(() => pinnedN8nPublishedWorkflow({ ...provider, settings: {} }, grant)).toThrow('N8N_WORKFLOW_NOT_PINNED');
    expect(() => pinnedN8nPublishedWorkflow({ ...provider, active: false }, grant)).toThrow('N8N_WORKFLOW_NOT_PINNED');
    expect(() => pinnedN8nPublishedWorkflow({ ...provider, activeVersion: { ...value, versionId: null } }, grant)).toThrow('N8N_WORKFLOW_NOT_PINNED');
  });

  it('keeps the captured n8n published and execution snapshot hashes unchanged', () => {
    const captured = JSON.parse(readFileSync(new URL('./fixtures/n8n-2.43.8-studio-read-write.json', import.meta.url), 'utf8'));
    expect(n8nWorkflowSha256(decodeN8nWorkflowSnapshot(captured.published)))
      .toBe('e86dc688689743a84c333bed050a6953a9b743bcb7416f867ed5505adc8304c3');
    expect(n8nWorkflowSha256(decodeN8nWorkflowSnapshot(captured.execution.workflowData)))
      .toBe('8fc53a91eca62f3844d287d841a89686c9d5b63cb9fa9010e4838ef86de5e1b1');
  });
});
