import { describe, expect, it } from 'vitest';
import { prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import { prepareGraphScope } from '../src/sparql-graph-scope.js';
import { parseTriplesBlock, UnreadTriplesBlockError } from '../src/sparql-triples-block.js';

const RDF_TYPE = '<http://www.w3.org/1999/02/22-rdf-syntax-ns#type>';

/** The triples of the WHERE group of `SELECT * WHERE { <block> }`. */
function parse(block: string) {
  const prepared = prepareSparql(`SELECT * WHERE { ${block} }`);
  if (prepared.status !== 'valid') throw new Error('Expected valid test input');
  const scope = prepareGraphScope(prepared);
  let counter = 0;
  const labels = new Map<string, string>();
  return parseTriplesBlock(scope, scope.where!.openingTokenIndex + 1, scope.where!.closingTokenIndex,
    { fresh: name => `?${name}${counter++}`, labels });
}

describe('parseTriplesBlock', () => {
  it('reads property and object lists with every kind of term', () => {
    expect(parse('?s a <urn:T> ; <urn:p> "x"@en-US , "5"^^xsd:int , 5.5 , -3 , true , $v ; ?verb ?o .')).toEqual([
      { subject: '?s', verb: { kind: 'link', iri: RDF_TYPE }, object: '<urn:T>' },
      { subject: '?s', verb: { kind: 'link', iri: '<urn:p>' }, object: '"x"@en-US' },
      { subject: '?s', verb: { kind: 'link', iri: '<urn:p>' }, object: '"5"^^xsd:int' },
      { subject: '?s', verb: { kind: 'link', iri: '<urn:p>' }, object: '5.5' },
      { subject: '?s', verb: { kind: 'link', iri: '<urn:p>' }, object: '-3' },
      { subject: '?s', verb: { kind: 'link', iri: '<urn:p>' }, object: 'true' },
      { subject: '?s', verb: { kind: 'link', iri: '<urn:p>' }, object: '$v' },
      { subject: '?s', verb: { kind: 'variable', text: '?verb' }, object: '?o' },
    ]);
  });

  it('reads property paths', () => {
    const [triple] = parse('?s ^<urn:i>/(<urn:a>|!(<urn:b>|^a))+ ?o');
    expect(triple!.verb).toEqual({ kind: 'sequence', steps: [
      { kind: 'inverse', path: { kind: 'link', iri: '<urn:i>' } },
      { kind: 'repeated', modifier: '+', path: { kind: 'alternative', options: [
        { kind: 'link', iri: '<urn:a>' },
        { kind: 'negated', forward: ['<urn:b>'], inverse: [RDF_TYPE] },
      ] } },
    ] });
  });

  it('turns blank nodes into fresh variables, one per label', () => {
    expect(parse('[ <urn:q> _:b ] <urn:r> [] . _:b <urn:t> ?x . [ <urn:u> ?y ]')).toEqual([
      { subject: '?_blank0', verb: { kind: 'link', iri: '<urn:q>' }, object: '?_blank1' },
      { subject: '?_blank0', verb: { kind: 'link', iri: '<urn:r>' }, object: '?_blank2' },
      { subject: '?_blank1', verb: { kind: 'link', iri: '<urn:t>' }, object: '?x' },
      { subject: '?_blank3', verb: { kind: 'link', iri: '<urn:u>' }, object: '?y' },
    ]);
  });

  it.each([
    ['an RDF collection', '?s <urn:p> ( 1 2 )'],
    ['a missing separator', '?s <urn:p> ?o ?x <urn:q> ?y'],
    ['an unclosed blank-node property list', '?s <urn:p> [ <urn:q> ?o'],
    ['an empty negated property set', '?s !() ?o'],
    ['an unclosed path group', '?s (<urn:p>/<urn:q> ?o'],
  ])('does not read %s', (_label, block) => {
    expect(() => parse(block)).toThrow(UnreadTriplesBlockError);
  });
});
