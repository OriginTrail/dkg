import { describe, it, expect } from 'vitest';
import { GraphModel } from '../src/core/graph-model.js';
import { ReificationCollapser } from '../src/core/reification-collapser.js';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

function addStandardReification(
  model: GraphModel,
  stmtId: string,
  subject: string,
  predicate: string,
  object: string,
  annotations: Array<{ pred: string; val: string; datatype?: string }> = [],
): void {
  model.addTriple({ subject: stmtId, predicate: `${RDF}type`, object: `${RDF}Statement` });
  model.addTriple({ subject: stmtId, predicate: `${RDF}subject`, object: subject });
  model.addTriple({ subject: stmtId, predicate: `${RDF}predicate`, object: predicate });
  model.addTriple({ subject: stmtId, predicate: `${RDF}object`, object: object });
  for (const a of annotations) {
    model.addTriple({ subject: stmtId, predicate: a.pred, object: a.val, datatype: a.datatype });
  }
}

describe('ReificationCollapser', () => {
  it('returns empty set when disabled', () => {
    const model = new GraphModel();
    model.addTriple({ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' });

    const collapser = new ReificationCollapser({ enabled: false });
    const collapsed = collapser.collapse(model);
    expect(collapsed.size).toBe(0);
    expect(collapser.enabled).toBe(false);
  });

  it('returns empty set when no reification patterns exist', () => {
    const model = new GraphModel();
    model.addTriple({ subject: 'urn:a', predicate: 'http://ex.org/name', object: '"Alice"' });

    const collapser = new ReificationCollapser({ enabled: true });
    const collapsed = collapser.collapse(model);
    expect(collapsed.size).toBe(0);
  });

  it('detects and collapses standard RDF reification', () => {
    const model = new GraphModel();

    model.addTriple({ subject: 'urn:alice', predicate: 'http://ex.org/knows', object: 'urn:bob' });

    addStandardReification(model, 'urn:stmt1', 'urn:alice', 'http://ex.org/knows', 'urn:bob', [
      { pred: 'http://ex.org/source', val: '"Wikipedia"' },
    ]);

    const collapser = new ReificationCollapser({ enabled: true });
    const collapsed = collapser.collapse(model);

    expect(collapsed.has('urn:stmt1')).toBe(true);
    expect(collapsed.size).toBe(1);
  });

  it('attaches annotations from collapsed node to subject node property', () => {
    const model = new GraphModel();

    // Use a literal object so it's stored as a property (not an edge)
    model.addTriple({ subject: 'urn:alice', predicate: 'http://ex.org/age', object: '"30"' });

    addStandardReification(model, 'urn:stmt1', 'urn:alice', 'http://ex.org/age', '"30"', [
      { pred: 'http://ex.org/confidence', val: '"0.95"' },
    ]);

    const collapser = new ReificationCollapser({ enabled: true });
    collapser.collapse(model);

    const aliceNode = model.getNode('urn:alice');
    expect(aliceNode).toBeDefined();

    const ageProps = aliceNode!.properties.get('http://ex.org/age');
    expect(ageProps).toBeDefined();
    expect(ageProps!.length).toBeGreaterThan(0);

    const hasAnnotation = ageProps!.some(pv =>
      pv.annotations?.some(a => a.predicate === 'http://ex.org/confidence' && a.value === '"0.95"'),
    );
    expect(hasAnnotation).toBe(true);
  });

  it('skips statements without a reified subject', () => {
    const model = new GraphModel();
    model.addTriple({ subject: 'urn:stmt', predicate: `${RDF}type`, object: `${RDF}Statement` });
    model.addTriple({ subject: 'urn:stmt', predicate: `${RDF}predicate`, object: 'http://ex.org/p' });

    const collapser = new ReificationCollapser({ enabled: true });
    const collapsed = collapser.collapse(model);
    expect(collapsed.size).toBe(0);
  });

  it('collapses multiple reified statements', () => {
    const model = new GraphModel();

    model.addTriple({ subject: 'urn:a', predicate: 'http://ex.org/p1', object: 'urn:b' });
    model.addTriple({ subject: 'urn:a', predicate: 'http://ex.org/p2', object: 'urn:c' });

    addStandardReification(model, 'urn:stmt1', 'urn:a', 'http://ex.org/p1', 'urn:b');
    addStandardReification(model, 'urn:stmt2', 'urn:a', 'http://ex.org/p2', 'urn:c');

    const collapser = new ReificationCollapser({ enabled: true });
    const collapsed = collapser.collapse(model);

    expect(collapsed.size).toBe(2);
    expect(collapsed.has('urn:stmt1')).toBe(true);
    expect(collapsed.has('urn:stmt2')).toBe(true);
  });

  it('works with custom reification patterns', () => {
    const model = new GraphModel();

    model.addTriple({ subject: 'urn:x', predicate: 'http://ex.org/rel', object: 'urn:y' });
    model.addTriple({ subject: 'urn:custom', predicate: `${RDF}type`, object: 'http://custom/Statement' });
    model.addTriple({ subject: 'urn:custom', predicate: 'http://custom/aboutSubject', object: 'urn:x' });
    model.addTriple({ subject: 'urn:custom', predicate: 'http://custom/forPredicate', object: 'http://ex.org/rel' });
    model.addTriple({ subject: 'urn:custom', predicate: 'http://custom/hasValue', object: 'urn:y' });

    const collapser = new ReificationCollapser({
      enabled: true,
      patterns: [{
        statementType: 'http://custom/Statement',
        subjectPredicate: 'http://custom/aboutSubject',
        predicatePredicate: 'http://custom/forPredicate',
        objectPredicate: 'http://custom/hasValue',
      }],
    });
    const collapsed = collapser.collapse(model);
    expect(collapsed.has('urn:custom')).toBe(true);
  });

  it('undefined config defaults to disabled', () => {
    const collapser = new ReificationCollapser(undefined);
    expect(collapser.enabled).toBe(false);
  });
});


describe('ReificationCollapser metadata and annotation identity', () => {
  it('collapses statements whose structural links are stored as metadata and attaches typed annotations', () => {
    const model = new GraphModel([RDF + 'subject', RDF + 'predicate', RDF + 'object', 'urn:meta']);
    model.addTriple({ subject: 'urn:s', predicate: 'urn:p', object: 'value' });
    model.addTriple({ subject: 'urn:s', predicate: 'urn:meta', object: 'metadata' });
    addStandardReification(model, 'urn:stmt', 'urn:s', 'urn:p', 'value', [
      { pred: 'urn:confidence', val: '0.9', datatype: 'urn:decimal' },
      { pred: 'urn:meta', val: 'trusted' },
    ]);
    const collapser = new ReificationCollapser({ enabled: true });
    expect(collapser.enabled).toBe(true);
    expect(collapser.collapse(model)).toEqual(new Set(['urn:stmt']));
    expect(model.getNode('urn:s')?.properties.get('urn:p')?.[0].annotations).toEqual(expect.arrayContaining([
      { predicate: 'urn:confidence', value: '0.9', datatype: 'urn:decimal' },
      { predicate: 'urn:meta', value: 'trusted', datatype: undefined },
    ]));
  });
  it.each([{ value: 'value', previous: true }, { value: 'urn:resource', previous: false }])('attaches metadata annotations to a matching value and preserves earlier annotations: %j', ({ value, previous }) => {
    const model = new GraphModel(['urn:p']);
    model.addTriple({ subject: 'urn:s', predicate: 'urn:p', object: value });
    addStandardReification(model, 'urn:stmt', 'urn:s', 'urn:p', value, [
      { pred: 'urn:confidence', val: 'high' },
    ]);
    model.addTriple({ subject: 'urn:incomplete', predicate: RDF + 'type', object: RDF + 'Statement' });
    if (previous) model.getNode('urn:s')!.metadata.get('urn:p')![0].annotations = [{ predicate: 'urn:previous', value: 'keep' }];
    expect(new ReificationCollapser({ enabled: true }).collapse(model)).toEqual(new Set(['urn:stmt']));
    expect(model.getNode('urn:s')!.metadata.get('urn:p')![0].annotations).toEqual([
      ...(previous ? [{ predicate: 'urn:previous', value: 'keep' }] : []),
      { predicate: 'urn:confidence', value: 'high', datatype: undefined },
    ]);
  });
  it.each(['absent entity', 'empty subject'])('leaves an unresolved statement visible: %s', mode => {
    const model = new GraphModel([RDF + 'subject', RDF + 'predicate', RDF + 'object']);
    addStandardReification(model, 'urn:stmt', 'urn:absent', 'urn:p', 'value', [
      { pred: 'urn:annotation', val: 'evidence' },
    ]);
    if (mode === 'empty subject') model.getNode('urn:stmt')!.metadata.set(RDF + 'subject', []);
    expect(model.getNode('urn:absent')).toBeUndefined();
    expect(new ReificationCollapser({ enabled: true }).collapse(model)).toEqual(new Set());
    expect(model.getNode('urn:stmt')?.properties.get('urn:annotation')?.[0].value).toBe('evidence');
  });

  it('attaches separate statement annotations only to their matching property values', () => {
    const model = new GraphModel();
    for (const value of ['unrelated', 'first', 'second']) {
      model.addTriple({ subject: 'urn:s', predicate: 'urn:p', object: value });
    }
    addStandardReification(model, 'urn:stmt-first', 'urn:s', 'urn:p', 'first', [
      { pred: 'urn:annotation', val: 'first evidence' },
    ]);
    addStandardReification(model, 'urn:stmt-second', 'urn:s', 'urn:p', 'second', [
      { pred: 'urn:annotation', val: 'second evidence' },
    ]);
    expect(new ReificationCollapser({ enabled: true }).collapse(model))
      .toEqual(new Set(['urn:stmt-first', 'urn:stmt-second']));
    expect(model.getNode('urn:s')?.properties.get('urn:p')?.map(({ value, annotations }) => ({ value, annotations })))
      .toEqual([
        { value: 'unrelated', annotations: undefined },
        { value: 'first', annotations: [{ predicate: 'urn:annotation', value: 'first evidence', datatype: undefined }] },
        { value: 'second', annotations: [{ predicate: 'urn:annotation', value: 'second evidence', datatype: undefined }] },
      ]);
  });
});
