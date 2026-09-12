// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { Parser as SparqlParser } from '@traqula/parser-sparql-1-1';

import {
  CANARY_PREDICATE,
  CANARY_SUBJECT_PREFIX,
} from './canary-vocabulary.mjs';
import { invalid } from './errors.mjs';

const sparqlParser = new SparqlParser();

/** @typedef {ReturnType<(typeof sparqlParser)['parse']>} SparqlAstV1 */
/** @typedef {Extract<SparqlAstV1, { type: 'query', subType: 'ask' }>} AskAstV1 */
/** @typedef {AskAstV1['where']['patterns'][number]} SparqlPatternV1 */
/** @typedef {Extract<SparqlPatternV1, { type: 'pattern', subType: 'bgp' }>} SparqlBgpV1 */
/** @typedef {SparqlBgpV1['triples'][number]} SparqlBgpEntryV1 */
/** @typedef {Extract<SparqlBgpEntryV1, { type: 'triple' }>} SparqlTripleV1 */
/** @typedef {SparqlTripleV1['subject'] | SparqlTripleV1['predicate'] | SparqlTripleV1['object']} SparqlTripleValueV1 */
/** @typedef {Extract<SparqlTripleValueV1, { type: 'term' }>} SparqlTermV1 */
/** @typedef {Extract<SparqlTermV1, { subType: 'namedNode' }>} SparqlNamedNodeV1 */

/**
 * Parse one configured ASK query at the dependency boundary and enforce the
 * data-dependence and reserved-vocabulary policy over the typed parser AST.
 * @param {string} value
 * @param {'vm' | 'catalog-swm'} label
 */
export function validateAskSparqlPolicyV1(value, label) {
  /** @type {SparqlAstV1} */
  let parsed;
  try {
    parsed = sparqlParser.parse(value);
  } catch {
    invalid(`${label}-query-must-be-ask`);
  }
  if (parsed.type === 'update') invalid(`${label}-query-must-be-read-only`);
  if (parsed.subType !== 'ask') invalid(`${label}-query-must-be-ask`);

  const facts = inspectAskQueryV1(parsed);
  if (!facts.mandatoryBgp || !facts.concreteTermPresent) {
    invalid(`${label}-query-must-depend-on-data`);
  }
  if (
    label === 'catalog-swm'
    && facts.referencedNamedIris.some(reservedCanaryIriV1)
  ) invalid('catalog-swm-query-uses-canary-vocabulary');
}

/**
 * @param {AskAstV1} query
 * @returns {Readonly<{
 *   mandatoryBgp: boolean,
 *   concreteTermPresent: boolean,
 *   referencedNamedIris: readonly string[],
 * }>}
 */
function inspectAskQueryV1(query) {
  const patterns = query.where.patterns;
  const bgps = patterns.filter(isBgpV1);
  const triples = bgps.flatMap((pattern) => pattern.triples.filter(isTripleV1));
  const iriContext = resolveSparqlIriContextV1(query.context);
  return Object.freeze({
    mandatoryBgp: patterns.length > 0
      && bgps.length === patterns.length
      && bgps.every((pattern) => pattern.triples.length > 0)
      && triples.length > 0,
    concreteTermPresent: triples.some((triple) => [
      triple.subject,
      triple.predicate,
      triple.object,
    ].some(isConcreteTermV1)),
    referencedNamedIris: Object.freeze(triples.flatMap((triple) => [
      triple.subject,
      triple.predicate,
      triple.object,
    ].flatMap(collectNamedNodeIrisV1)).map((term) => (
      resolveNamedNodeIriV1(term, iriContext)
    ))),
  });
}

/** @param {SparqlPatternV1} pattern @returns {pattern is SparqlBgpV1} */
function isBgpV1(pattern) {
  return pattern.type === 'pattern' && pattern.subType === 'bgp';
}

/** @param {SparqlBgpEntryV1} entry @returns {entry is SparqlTripleV1} */
function isTripleV1(entry) {
  return entry.type === 'triple';
}

/** @param {SparqlTripleValueV1} value @returns {boolean} */
function isConcreteTermV1(value) {
  return value.type === 'term' && ['namedNode', 'literal'].includes(value.subType);
}

/**
 * Visit every term-bearing child admitted by a basic triple, including nested
 * collections, datatype IRIs, and property paths.
 * @param {SparqlTripleValueV1} value
 * @returns {SparqlNamedNodeV1[]}
 */
function collectNamedNodeIrisV1(value) {
  if (value.type === 'term') {
    if (value.subType === 'namedNode') return [value];
    if (
      value.subType === 'literal'
      && value.langOrIri !== undefined
      && typeof value.langOrIri !== 'string'
    ) return collectNamedNodeIrisV1(value.langOrIri);
    return [];
  }
  if (value.type === 'path') return value.items.flatMap(collectNamedNodeIrisV1);
  return [
    value.identifier,
    ...value.triples.flatMap((triple) => [triple.subject, triple.predicate, triple.object]),
  ].flatMap(collectNamedNodeIrisV1);
}

/** @param {AskAstV1['context']} entries */
function resolveSparqlIriContextV1(entries) {
  /** @type {string | undefined} */
  let base;
  /** @type {Map<string, string>} */
  const prefixes = new Map();
  for (const entry of entries) {
    if (entry.subType === 'base') {
      base = resolveIriReferenceV1(entry.value.value, base);
    } else {
      prefixes.set(entry.key, resolveIriReferenceV1(entry.value.value, base));
    }
  }
  return Object.freeze({ base, prefixes });
}

/**
 * @param {SparqlNamedNodeV1} term
 * @param {{ base: string | undefined, prefixes: ReadonlyMap<string, string> }} context
 */
function resolveNamedNodeIriV1(term, context) {
  if (!('prefix' in term)) return resolveIriReferenceV1(term.value, context.base);
  const prefix = context.prefixes.get(term.prefix);
  return typeof prefix === 'string' ? `${prefix}${term.value}` : term.value;
}

/** @param {string} value @param {string | undefined} base @returns {string} */
function resolveIriReferenceV1(value, base) {
  if (base === undefined) return value;
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

/** @param {string} value @returns {boolean} */
function reservedCanaryIriV1(value) {
  return value === CANARY_PREDICATE || value.startsWith(CANARY_SUBJECT_PREFIX);
}
