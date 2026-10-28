// @vitest-environment happy-dom
import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlPanel } from '../src/components/ControlPanel';
import * as api from '../src/api';
import { makeStore, mountUi, type MountedUi } from './ui-test-support';
vi.mock('../src/api');
vi.mock('../src/store', () => ({ useStore: () => store }));
let store = makeStore();
let ui: MountedUi;
beforeEach(() => {
  vi.resetAllMocks(); store = makeStore();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(api.fetchContextGraphs).mockResolvedValue({ contextGraphs: [] });
  vi.mocked(api.publishKA).mockResolvedValue({ assertionUri: 'urn:assertion', kaId: 'ka-1', status: 'confirmed', kas: [{ tokenId: 'token', rootEntity: 'urn:entity' }] });
  vi.mocked(api.createSharedKnowledgeAsset).mockResolvedValue({ name: 'shared-1' });
  vi.mocked(api.queryNode).mockResolvedValue({ result: { bindings: [{ label: 'actual-result' }] } });
  vi.mocked(api.createContextGraph).mockResolvedValue({ created: true, uri: 'urn:team' });
  vi.mocked(api.subscribeContextGraph).mockResolvedValue({ subscribed: 'devnet-test' });
});
afterEach(() => { ui?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount(tab?: string) { ui = await mountUi(React.createElement(ControlPanel)); if (tab) await ui.click(tab, ui.container.querySelector('.tab-bar')!); }
function result() { return ui.container.querySelector('.result-box')?.textContent; }

describe('publish and shared-memory controls', () => {
  it.each(['literal text', 'https://example/entity', 'did:dkg:entity:x', 'urn:entity'])('publishes %s using the selected node and exact quad scope', async object => {
    vi.mocked(store.dispatch).mockImplementation(action => {
      if (action.type === 'SELECT_NODE') store.state = { ...store.state, selectedNode: action.id };
    });
    await mount();
    await ui.fill('Subject', 'urn:subject'); await ui.fill('Predicate', 'urn:predicate');
    await ui.fill('Object', object); await ui.fill('Context Graph', 'did:dkg:context-graph:custom');
    await ui.click('N2', ui.container.querySelector('.node-selector')!);
    expect(store.dispatch).toHaveBeenCalledWith({ type: 'SELECT_NODE', id: 2 });
    await ui.render(React.createElement(ControlPanel));
    await ui.click('Publish Knowledge Asset');
    expect(api.publishKA).toHaveBeenCalledExactlyOnceWith(2, 'did:dkg:context-graph:custom', [{ subject: 'urn:subject', predicate: 'urn:predicate', object: object === 'literal text' ? '"literal text"' : object, graph: 'did:dkg:context-graph:custom' }], undefined);
    expect(store.addBroadcast).toHaveBeenCalledExactlyOnceWith('publish', 2, 'publish');
    expect(store.completeOperation).toHaveBeenCalledWith('broadcast', 'success', 'KC: ka-1');
    expect(result()).toBe('KC: ka-1 | Status: confirmed | KAs: 1');
  });
  it('passes optional private data and surfaces errors while restoring the button', async () => {
    vi.mocked(api.publishKA).mockRejectedValue(new Error('private publication unsupported'));
    await mount(); await ui.fill('Private Data (optional)', 'private value'); await ui.click('Publish Knowledge Asset');
    expect(api.publishKA).toHaveBeenCalledWith(1, 'devnet-test', expect.any(Array), [{ subject: 'did:dkg:entity:001', predicate: 'http://schema.org/secret', object: '"private value"', graph: 'did:dkg:context-graph:devnet-test' }]);
    expect(store.addBroadcast).toHaveBeenCalledWith('publish', 1, 'publish (private)');
    expect(store.completeOperation).toHaveBeenCalledWith('broadcast', 'error', 'private publication unsupported');
    expect(result()).toBe('Error: private publication unsupported');
    expect(ui.button('Publish Knowledge Asset').disabled).toBe(false);
  });
  it('renders graph IDs and legacy names and disables duplicate pending publishes', async () => {
    vi.mocked(api.fetchContextGraphs).mockResolvedValue({ contextGraphs: [{ id: 'team', name: 'Team' }, { id: '', name: 'legacy' }] });
    let resolve!: (value: any) => void;
    vi.mocked(api.publishKA).mockReturnValue(new Promise(done => { resolve = done; }));
    await mount();
    expect(Array.from(ui.field('Context Graph').querySelectorAll('option')).map(o => o.value)).toEqual(['team', 'legacy', 'devnet-test']);
    await ui.fill('Context Graph', 'team'); await ui.click('Publish Knowledge Asset');
    expect(ui.button('Publishing...').disabled).toBe(true);
    await act(async () => resolve({ kaId: 'asset', status: 'done' }));
    expect(result()).toBe('KC: asset | Status: done | KAs: 0');
  });
  it.each(['plain value', 'urn:value', 'did:value', 'https://example/value'])('shares %s and reads only shared-memory quads', async object => {
    await mount('Shared Memory');
    await ui.fill('Subject', 'urn:subject'); await ui.fill('Predicate', 'urn:predicate'); await ui.fill('Object', object);
    await ui.fill('Context Graph', 'team'); await ui.click('Write to Shared Memory (Free)');
    expect(api.createSharedKnowledgeAsset).toHaveBeenCalledExactlyOnceWith(1, 'team', [{ subject: 'urn:subject', predicate: 'urn:predicate', object: object === 'plain value' ? '"plain value"' : object, graph: 'did:dkg:context-graph:team' }]);
    expect(result()).toContain('Name: shared-1');
    await ui.click('Query Shared Memory');
    expect(api.queryNode).toHaveBeenCalledWith(1, 'SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 50', 'team', { graphSuffix: '_shared_memory' });
    expect(ui.container.textContent).toContain('actual-result');
  });
  it('preserves full graph URIs and shows shared-memory write and query failures', async () => {
    vi.mocked(api.createSharedKnowledgeAsset).mockRejectedValue(new Error('write failed'));
    vi.mocked(api.queryNode).mockRejectedValue(new Error('query failed'));
    await mount('Shared Memory'); await ui.fill('Context Graph', 'did:dkg:context-graph:team');
    await ui.click('Write to Shared Memory (Free)');
    expect(store.completeOperation).toHaveBeenCalledWith('broadcast', 'error', 'write failed');
    expect(result()).toBe('Error: write failed');
    await ui.click('Query Shared Memory');
    expect(ui.container.textContent).toContain('Error: query failed');
  });
});

describe('query and collaboration controls', () => {
  it.each([['Published', undefined], ['Shared Memory', { graphSuffix: '_shared_memory' }], ['Both', { includeSharedMemory: true }]])('routes query target %s without broadening its scope', async (target, options) => {
    await mount('Query');
    await ui.fill('Context Graph', ''); await ui.fill('SPARQL', 'ASK { ?s ?p ?o }');
    await ui.click(String(target), ui.container.querySelector('.graph-target-pills')!);
    await ui.click('Execute Query');
    expect(api.queryNode).toHaveBeenCalledExactlyOnceWith(1, 'ASK { ?s ?p ?o }', undefined, options);
    expect(result()).toBe(JSON.stringify({ bindings: [{ label: 'actual-result' }] }, null, 2));
    expect(store.completeOperation).toHaveBeenCalledWith('operation', 'success', expect.stringMatching(/chars$/));
  });
  it('reports query failures', async () => {
    vi.mocked(api.queryNode).mockRejectedValue(new Error('SPARQL invalid'));
    await mount('Query'); await ui.click('Execute Query');
    expect(result()).toBe('Error: SPARQL invalid');
    expect(store.completeOperation).toHaveBeenCalledWith('operation', 'error', 'SPARQL invalid');
  });
  it.each([{ delivered: true }, { delivered: false, error: 'rejected' }, { delivered: false }])('reports actual chat delivery %j', async response => {
    vi.mocked(api.sendChat).mockResolvedValue(response);
    await mount('Chat'); await ui.fill('Message', 'new message'); await ui.click('Send Message');
    expect(api.sendChat).toHaveBeenCalledExactlyOnceWith(1, 'peer-2', 'new message');
    expect(result()).toBe(response.delivered ? 'Message delivered' : `Not delivered: ${response.error ?? 'unknown'}`);
    expect(store.completeOperation).toHaveBeenCalledWith('operation', response.delivered ? 'success' : 'error', response.delivered ? 'delivered' : response.error ?? 'not delivered');
  });
  it('does not send to offline peers and reports transport failures', async () => {
    vi.mocked(api.sendChat).mockRejectedValue(new Error('connection closed'));
    await mount('Chat'); await ui.click('N3', ui.container.querySelector('.tab-form')!); await ui.click('Send Message');
    expect(result()).toContain('Target node not online'); expect(api.sendChat).not.toHaveBeenCalled();
    await ui.click('N2', ui.container.querySelector('.tab-form')!); await ui.click('Send Message');
    expect(result()).toBe('Error: connection closed');
  });
  it('requires a UAL and online publisher before remote lookup', async () => {
    vi.mocked(api.queryRemote).mockResolvedValue({ operationId: 'remote-op', status: 'allowed' });
    await mount('Access'); expect(ui.button('Request Private Access').disabled).toBe(true);
    await ui.fill('Knowledge Asset UAL', 'did:dkg:asset'); await ui.click('N3', ui.container.querySelector('.tab-form')!); await ui.click('Request Private Access');
    expect(result()).toContain('Publisher node not online'); expect(api.queryRemote).not.toHaveBeenCalled();
    await ui.click('N2', ui.container.querySelector('.tab-form')!); await ui.click('Request Private Access');
    expect(api.queryRemote).toHaveBeenCalledExactlyOnceWith(1, 'peer-2', { lookupType: 'ual', ual: 'did:dkg:asset' });
    expect(store.completeOperation).toHaveBeenCalledWith('operation', 'success', 'status: allowed');
    vi.mocked(api.queryRemote).mockRejectedValue(new Error('access denied')); await ui.click('Request Private Access');
    expect(result()).toBe('Error: access denied');
  });
});

describe('setup and local calculation controls', () => {
  it('creates a graph and subscribes only online nodes', async () => {
    await mount('Setup'); await ui.fill('Context Graph ID', 'project'); await ui.fill('Context Graph Name', 'Project');
    await ui.click('Initialize Devnet');
    expect(api.createContextGraph).toHaveBeenCalledExactlyOnceWith(1, 'project', 'Project');
    expect(vi.mocked(api.subscribeContextGraph).mock.calls).toEqual([[1, 'project'], [2, 'project']]);
    expect(result()).toContain('Created context graph "project" on Node 1');
    expect(result()).toContain('Node 3: offline, skipped');
    expect(store.completeOperation).toHaveBeenCalledWith('operation', 'success', 'project ready');
  });
  it.each(['already exists', 'already registered', 'permission denied'])('reports graph creation outcome %s and continues subscriptions', async message => {
    vi.mocked(api.createContextGraph).mockRejectedValue(new Error(message));
    vi.mocked(api.subscribeContextGraph).mockRejectedValueOnce(new Error('subscribe failed'));
    await mount('Setup'); await ui.click('Initialize Devnet');
    expect(result()).toContain(message.startsWith('already') ? 'already exists' : 'Create context graph: permission denied');
    expect(result()).toContain('Node 1: subscribe failed');
    expect(result()).toContain('Node 2: subscribed');
    expect(api.subscribeContextGraph).toHaveBeenCalledTimes(2);
  });
  it('offers a clear offline setup result and tolerates graph-list failure', async () => {
    store.state.nodes.forEach(n => { n.online = false; });
    await mount('Setup'); await ui.click('Initialize Devnet');
    expect(result()).toContain('No nodes online');
    expect(api.createContextGraph).not.toHaveBeenCalled(); expect(api.fetchContextGraphs).not.toHaveBeenCalled();
    store.state.nodes = [{ ...store.state.nodes[0], online: true }];
    vi.mocked(api.fetchContextGraphs).mockRejectedValue(new Error('graph-list offline'));
    await ui.render(React.createElement(ControlPanel));
    expect(ui.button('Initialize Devnet').disabled).toBe(false);
  });
  it('shows graph inventory and manages create/subscribe results separately', async () => {
    vi.mocked(api.fetchContextGraphs).mockResolvedValue({ contextGraphs: [{ id: 'existing', name: 'Existing' }] });
    await mount('Setup'); expect(ui.container.textContent).toContain('existing');
    await ui.click('Create'); expect(result()).toBe('Created: urn:team');
    vi.mocked(api.createContextGraph).mockRejectedValue(new Error('name invalid'));
    await ui.click('Create'); expect(result()).toBe('Error: name invalid');
    expect(store.completeOperation).toHaveBeenLastCalledWith('operation', 'error', 'name invalid');
    vi.mocked(api.subscribeContextGraph).mockRejectedValueOnce(new Error('unreachable'));
    await ui.click('Subscribe All Nodes');
    expect(result()).toBe('Node 1: unreachable\nNode 2: subscribed to "devnet-test"\nNode 3: offline, skipped');
  });
  it('calculates stake weight at the no-lock boundary and an ordinary lock', async () => {
    await mount('Stake'); await ui.fill('Amount (TRAC)', '200'); await ui.fill('Lock Epochs', '1');
    expect(ui.container.textContent).toContain('1.000x');
    expect(ui.container.textContent).toContain('200.00 TRAC');
    await ui.click('Stake with Conviction Lock');
    expect(result()).toContain('Effective weight: 200.00 TRAC');
    expect(store.completeOperation).toHaveBeenLastCalledWith('operation', 'success', '200 TRAC × 1.000');
    await ui.fill('Lock Epochs', '12'); await ui.click('Stake with Conviction Lock');
    expect(result()).toContain('Conviction multiplier: 1.050x');
    expect(result()).toContain('Effective weight: 210.00 TRAC');
    await ui.fill('Amount (TRAC)', ''); await ui.fill('Lock Epochs', '');
    expect(ui.container.textContent).toContain('0.00 TRAC');
  });
  it('calculates conviction discount and keeps zero/empty deposits at zero discount', async () => {
    await mount('Conviction'); await ui.fill('Deposit (TRAC)', '1000'); await ui.fill('Lock Epochs', '10'); await ui.fill('Base Publish Cost (TRAC)', '200');
    expect(ui.container.textContent).toContain('25.00%'); expect(ui.container.textContent).toContain('150.00 TRAC');
    await ui.click('Create Conviction Account');
    expect(result()).toContain('Publishing cost of 200 TRAC → 150.00 TRAC');
    expect(store.completeOperation).toHaveBeenLastCalledWith('operation', 'success', '25.0% discount');
    await ui.fill('Lock Epochs', '0'); expect(ui.container.textContent).toContain('0.00%');
    await ui.fill('Lock Epochs', '10'); await ui.fill('Deposit (TRAC)', ''); await ui.fill('Base Publish Cost (TRAC)', '');
    expect(ui.container.textContent).toContain('0.00 TRAC');
    await ui.fill('Lock Epochs', ''); expect(ui.container.textContent).toContain('0.00%');
  });
  it('previews the selected seller, asset and exact fair-swap protocol fee', async () => {
    await mount('FairSwap'); await ui.click('N2', ui.container.querySelector('.tab-form')!);
    await ui.fill('Knowledge Asset ID', '42'); await ui.fill('Price (TRAC)', '200');
    await ui.click('Initiate Purchase');
    expect(result()).toContain('Buyer (Node 1) initiates purchase of KA #42');
    expect(result()).toContain('Seller (Node 2)');
    expect(result()).toContain('Protocol fee: 5.00 TRAC (2.5%)');
    expect(store.addOperation).toHaveBeenCalledWith('fairswap', 1, 'initiate purchase KA #42', 2);
    await ui.fill('Price (TRAC)', ''); expect(ui.container.textContent).toContain('0.00 TRAC');
  });
  it.each(['Shared Memory', 'Query'])('selects existing graph IDs in %s', async tab => {
    vi.mocked(api.fetchContextGraphs).mockResolvedValue({ contextGraphs: [{ id: 'team', name: 'Team' }, { id: 'devnet-test', name: 'Default' }] });
    await mount(tab); await ui.fill('Context Graph', 'team');
    await ui.click(tab === 'Query' ? 'Execute Query' : 'Write to Shared Memory (Free)');
    if (tab === 'Query') expect(api.queryNode).toHaveBeenCalledWith(1, expect.any(String), 'team', undefined);
    else expect(api.createSharedKnowledgeAsset).toHaveBeenCalledWith(1, 'team', expect.any(Array));
  });
});
