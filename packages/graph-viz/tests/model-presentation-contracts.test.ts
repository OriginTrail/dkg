import { describe, expect, it } from 'vitest';
import { GraphModel } from '../src/core/graph-model.js';
import { PrefixManager } from '../src/core/prefix-manager.js';
import { LabelResolver } from '../src/core/label-resolver.js';
import { applyViewConfig } from '../src/core/view-config.js';
import { ReificationCollapser } from '../src/core/reification-collapser.js';
import { TemporalFilter } from '../src/core/temporal-filter.js';
import { FocusFilter } from '../src/core/focus-filter.js';
const type = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const rdf = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const property = (model: GraphModel, id: string, key: string, value: string) => model.addTriple({ subject: id, predicate: 'https://schema.org/' + key, object: value });

describe('labels and prefixes', () => {
  it('maintains prefix snapshots and handles encoded and malformed URI tails', () => {
    const manager = new PrefixManager({ ex: 'https://example.invalid/' });
    manager.addPrefixes({ team: 'urn:team:' }); expect(manager.getPrefix('urn:team:')).toBe('team'); expect(manager.getPrefix('missing')).toBeUndefined();
    const snapshot = manager.prefixes; snapshot.team = 'changed'; expect(manager.getNamespace('team')).toBe('urn:team:');
    expect(manager.compact('https://example.invalid/')).toBeNull(); expect(manager.expand('plain')).toBe('plain'); expect(manager.expand('unknown:value')).toBe('unknown:value');
    expect(manager.expand('http://example.invalid/x')).toBe('http://example.invalid/x');
    for (const [uri, expected] of [['urn:code:folder%2Ffile.ts', 'file.ts'], ['urn:code:folder%2ffile.ts', 'file.ts'], ['urn:code:bad%2F%ZZ', 'bad%2F%ZZ'], ['urn:ending:', 'urn:ending:'], ['plain', 'plain']]) expect(PrefixManager.localName(uri)).toBe(expected);
  });
  it('resolves type and predicate labels in both modes with explicit label precedence', () => {
    const prefix = new PrefixManager(); const labels = new LabelResolver('humanized', prefix, { predicates: ['urn:title'] });
    expect(labels.mode).toBe('humanized'); expect(labels.resolveTypeLabel('https://schema.org/SocialMediaPosting')).toBe('social media posting'); expect(labels.resolvePredicateLabel('urn:some_value')).toBe('some value'); expect(labels.resolveUri('')).toBe(''); expect(labels.resolveTypeLabel('urn:API')).toBe('API');
    labels.mode = 'strict'; expect(labels.resolveTypeLabel('https://schema.org/Person')).toBe('schema:Person'); expect(labels.resolveTypeLabel('urn:Custom')).toBe('Custom'); expect(labels.resolvePredicateLabel('urn:predicate')).toBe('predicate');
    const model = new GraphModel(); model.addTriple({ subject: 'urn:subject', predicate: 'urn:title', object: 'Explicit label' }); model.addTriple({ subject: 'urn:subject', predicate: 'urn:knows', object: 'urn:other' });
    labels.updateLabels(model.nodes, model.edges); expect(model.getNode('urn:subject')?.label).toBe('Explicit label'); expect([...model.edges.values()][0].label).toBe('knows');
  });
});

describe('view decoration decisions', () => {
  it('chooses platform edges before URL fallbacks and preserves existing application images', () => {
    const model = new GraphModel();
    for (const id of ['urn:post', 'https://site.invalid/post', 'urn:existing']) model.addTriple({ subject: id, predicate: type, object: 'https://schema.org/SocialMediaPosting' });
    model.addTriple({ subject: 'urn:post', predicate: 'https://schema.org/platform', object: 'https://platform.invalid/unknown' }); model.addTriple({ subject: 'urn:post', predicate: 'https://schema.org/platform', object: 'https://platform.invalid/video' });
    model.getNode('urn:existing')!.imageUrl = 'application.png';
    applyViewConfig({ name: 'platforms', platformIcons: { icons: { video: 'video.svg', web: 'web.svg' }, urlFallbacks: { 'missing': 'unknown', 'site.invalid': 'web' } } }, model);
    expect(model.getNode('urn:post')!.imageUrl).toBe('video.svg'); expect(model.getNode('https://site.invalid/post')!.imageUrl).toBe('web.svg'); expect(model.getNode('urn:existing')!.imageUrl).toBe('application.png');
  });
  it.each(['https://schema.org/Person', 'schema:Person', 'vocab:Person', 'Person'])('assigns node type icons using %s aliases', key => {
    const model = new GraphModel(); model.addTriple({ subject: 'urn:a', predicate: type, object: 'https://schema.org/Person' }); model.addTriple({ subject: 'urn:b', predicate: type, object: 'https://schema.org/Unknown' });
    applyViewConfig({ name: 'types', nodeTypes: { [key]: { icon: 'person.svg' }, Unknown: { color: 'red' } } }, model);
    expect(model.getNode('urn:a')?.imageUrl).toBe('person.svg'); expect(model.getNode('urn:b')?.imageUrl).toBeNull();
    model.getNode('urn:a')!.imageUrl = 'app.png'; applyViewConfig({ name: 'types', nodeTypes: { [key]: { icon: 'person.svg' } } }, model); expect(model.getNode('urn:a')?.imageUrl).toBe('app.png');
  });
  it.each([false, true])('scores negative sentiment by magnitude with inversion %s and ignores invalid values', invert => {
    const model = new GraphModel(); for (const [id, value] of [['low', '-.2'], ['high', '-.8'], ['invalid', 'not numeric'], ['zero', '0']]) property(model, 'urn:' + id, 'score', value);
    applyViewConfig({ name: 'risk', focal: { uri: 'urn:high', sizeMultiplier: 5 }, highlight: { property: 'score', threshold: .5, color: 'red', invert } }, model);
    expect(model.getNode('urn:low')?.isHighRisk).toBe(invert ? true : undefined); expect(model.getNode('urn:high')?.isHighRisk).toBe(invert ? undefined : true); expect(model.getNode('urn:high')?.riskScore).toBe(.8); expect(model.getNode('urn:high')?.sizeMultiplier).toBe(5); expect(model.getNode('urn:invalid')?.riskScore).toBeUndefined();
  });
  it.each(['linear', 'log'] as const)('scales %s values at endpoints and gives equal values a middle size', scale => {
    const model = new GraphModel(); for (const [id, value] of [['min', '10'], ['max', '100'], ['negative', '-1'], ['zero', '0'], ['invalid', 'oops']]) property(model, 'urn:' + id, 'count', value);
    applyViewConfig({ name: 'sizes', sizeBy: { property: 'count', scale } }, model);
    expect(model.getNode('urn:min')?.sizeMultiplier).toBe(.5); expect(model.getNode('urn:max')?.sizeMultiplier).toBe(3); expect(model.getNode('urn:negative')?.sizeMultiplier).toBeUndefined(); expect(model.getNode('urn:zero')?.sizeMultiplier).toBeUndefined(); expect(model.getNode('urn:invalid')?.sizeMultiplier).toBeUndefined();
    const same = new GraphModel(); property(same, 'urn:a', 'count', '10'); property(same, 'urn:b', 'count', '10'); applyViewConfig({ name: 'equal', sizeBy: { property: 'count', scale } }, same); expect([...same.nodes.values()].map(n => n.sizeMultiplier)).toEqual([1.75, 1.75]);
  });
});

describe('model metadata and reification', () => {
  it('collects KA members during ingestion and retains distinct metadata values', () => {
    const model = new GraphModel(['urn:metadata']); model.setKaMembershipPredicate('urn:member');
    model.addTriples([{ subject: 'urn:a', predicate: 'urn:member', object: 'urn:asset' }, { subject: 'urn:b', predicate: 'urn:member', object: 'urn:asset' }, { subject: 'urn:a', predicate: 'urn:metadata', object: 'first' }, { subject: 'urn:a', predicate: 'urn:metadata', object: 'second' }]);
    expect(model.kaGroups).toEqual(new Map([['urn:asset', new Set(['urn:a', 'urn:b'])]])); expect(model.getNode('urn:a')?.metadata.get('urn:metadata')?.map(v => v.value)).toEqual(['first', 'second']);
    model.setKaMembershipPredicate(null); model.addTriple({ subject: 'urn:c', predicate: 'urn:member', object: 'urn:asset' }); expect(model.kaGroups.get('urn:asset')?.has('urn:c')).toBe(false);
  });
  it('collapses statements whose structural links are stored as metadata and attaches typed annotations', () => {
    const model = new GraphModel([rdf + 'subject', rdf + 'predicate', rdf + 'object', 'urn:meta']);
    model.addTriples([{ subject: 'urn:s', predicate: 'urn:p', object: 'value' }, { subject: 'urn:s', predicate: 'urn:meta', object: 'metadata' }, { subject: 'urn:stmt', predicate: type, object: rdf + 'Statement' }, { subject: 'urn:stmt', predicate: rdf + 'subject', object: 'urn:s' }, { subject: 'urn:stmt', predicate: rdf + 'predicate', object: 'urn:p' }, { subject: 'urn:stmt', predicate: rdf + 'object', object: 'value' }, { subject: 'urn:stmt', predicate: 'urn:confidence', object: '0.9', datatype: 'urn:decimal' }, { subject: 'urn:stmt', predicate: 'urn:meta', object: 'trusted' }]);
    const collapser = new ReificationCollapser({ enabled: true }); expect(collapser.enabled).toBe(true); expect(collapser.collapse(model)).toEqual(new Set(['urn:stmt']));
    expect(model.getNode('urn:s')?.properties.get('urn:p')?.[0].annotations).toEqual(expect.arrayContaining([{ predicate: 'urn:confidence', value: '0.9', datatype: 'urn:decimal' }, { predicate: 'urn:meta', value: 'trusted', datatype: undefined }]));
  });
  it('attaches annotations to metadata values, preserves earlier annotations, and ignores incomplete statements', () => {
    const model = new GraphModel(['urn:p']);
    model.addTriples([{ subject: 'urn:s', predicate: 'urn:p', object: 'value' }, { subject: 'urn:stmt', predicate: type, object: rdf + 'Statement' }, { subject: 'urn:stmt', predicate: rdf + 'subject', object: 'urn:s' }, { subject: 'urn:stmt', predicate: rdf + 'predicate', object: 'urn:p' }, { subject: 'urn:stmt', predicate: rdf + 'object', object: 'urn:resource' }, { subject: 'urn:stmt', predicate: 'urn:confidence', object: 'high' }, { subject: 'urn:incomplete', predicate: type, object: rdf + 'Statement' }]);
    model.getNode('urn:s')!.metadata.get('urn:p')![0].annotations = [{ predicate: 'urn:previous', value: 'keep' }];
    expect(new ReificationCollapser({ enabled: true }).collapse(model)).toEqual(new Set(['urn:stmt']));
    expect(model.getNode('urn:s')!.metadata.get('urn:p')![0].annotations).toEqual([{ predicate: 'urn:previous', value: 'keep' }, { predicate: 'urn:confidence', value: 'high', datatype: undefined }]);
  });
  it('controls undated temporal visibility and permits empty focus results without a focal node', () => {
    const model = new GraphModel(); property(model, 'urn:dated', 'dateCreated', '2025-01-01'); property(model, 'urn:undated', 'name', 'Label');
    const filter = new TemporalFilter(); filter.scan(model); expect(filter.showUndated).toBe(true); filter.showUndated = false; expect(filter.getVisibleNodeIds(model.nodes.keys())).toEqual(new Set(['urn:dated'])); expect(filter.getNodeDate('missing')).toBeNull(); expect(filter.getNodeDate('urn:dated')).toEqual(new Date('2025-01-01'));
    const focus = new FocusFilter({ maxNodes: -1 }); expect(focus.compute(new GraphModel())).toEqual({ nodes: new Map(), edges: new Map() });
  });
});


describe('incremental removal boundaries', () => {
  it('preserves sibling values and ignores absent resources, types and properties', () => {
    const model = new GraphModel(['urn:meta']);
    model.addTriples([{ subject: 'urn:a', predicate: type, object: 'urn:Type' }, { subject: 'urn:a', predicate: type, object: 'urn:Type' }, { subject: 'urn:a', predicate: 'urn:meta', object: 'one' }, { subject: 'urn:a', predicate: 'urn:meta', object: 'two' }, { subject: 'urn:a', predicate: 'urn:p', object: 'first' }, { subject: 'urn:a', predicate: 'urn:p', object: 'second' }]);
    model.removeTriples([{ subject: 'urn:a', predicate: 'urn:p', object: 'first' }, { subject: 'urn:a', predicate: 'urn:meta', object: 'one' }, { subject: 'missing', predicate: type, object: 'urn:Type' }, { subject: 'missing', predicate: 'urn:p', object: 'value' }, { subject: 'urn:a', predicate: 'urn:absent', object: 'value' }, { subject: 'urn:a', predicate: 'urn:edge', object: 'urn:absent' }]);
    expect(model.getNode('urn:a')?.types).toEqual(['urn:Type']); expect(model.getNode('urn:a')?.properties.get('urn:p')?.map(v => v.value)).toEqual(['second']); expect(model.getNode('urn:a')?.metadata.get('urn:meta')?.map(v => v.value)).toEqual(['two']); expect(model.nodes.size).toBe(1);
  });
  it('falls back to the first property value when a statement does not identify an existing literal', () => {
    const model = new GraphModel(); model.addTriples([{ subject: 'urn:s', predicate: 'urn:p', object: 'actual' }, { subject: 'urn:stmt', predicate: type, object: rdf + 'Statement' }, { subject: 'urn:stmt', predicate: rdf + 'subject', object: 'urn:s' }, { subject: 'urn:stmt', predicate: rdf + 'predicate', object: 'urn:p' }, { subject: 'urn:stmt', predicate: rdf + 'object', object: 'other' }, { subject: 'urn:stmt', predicate: 'urn:annotation', object: 'context' }]);
    new ReificationCollapser({ enabled: true }).collapse(model); expect(model.getNode('urn:s')?.properties.get('urn:p')?.[0].annotations).toEqual([{ predicate: 'urn:annotation', value: 'context', datatype: undefined }]);
  });
  it('finds a focal entity across namespace variants and ignores linked entities without a score', () => {
    const model = new GraphModel(); property(model, 'https://umanitek.ai/dkg/person/alice', 'name', 'Alice'); model.addTriple({ subject: 'urn:post', predicate: 'urn:hasScore', object: 'urn:unscored' });
    applyViewConfig({ name: 'aliases', focal: { uri: 'https://other.invalid/person/alice' }, highlight: { source: 'linked', linkedVia: 'hasScore', property: 'score', threshold: 1, color: 'red' } }, model);
    expect(model.getNode('https://umanitek.ai/dkg/person/alice')?.sizeMultiplier).toBe(1.5); expect(model.getNode('urn:post')?.isHighRisk).toBeUndefined();
  });
});

it('limits a zero-hop focus to its focal node and can re-enable without changing that node', () => {
  const model = new GraphModel(); model.addTriples([{ subject: 'urn:a', predicate: 'urn:p', object: 'urn:b' }, { subject: 'urn:b', predicate: 'urn:p', object: 'urn:c' }]);
  const focus = new FocusFilter({ maxNodes: 2, hops: 0 }); focus.enable('urn:b'); expect([...focus.compute(model).nodes.keys()]).toEqual(['urn:b']); focus.disable(); focus.enable(); expect(focus.focalNode).toBe('urn:b');
});

it('ignores invalid and empty date values while finding the earliest valid namespace variant', () => {
  const model = new GraphModel(); property(model, 'urn:a', 'dateCreated', 'invalid'); property(model, 'urn:b', 'dateCreated', '2025-03-01');
  model.getNode('urn:a')!.properties.set('http://schema.org/dateCreated', []);
  model.getNode('urn:b')!.properties.set('http://schema.org/dateCreated', [{ value: '2025-01-01' }]);
  const filter = new TemporalFilter(); filter.scan(model); expect(filter.getNodeDate('urn:a')).toBeNull(); expect(filter.getNodeDate('urn:b')).toEqual(new Date('2025-01-01')); expect(filter.datedNodeCount).toBe(1);
});
