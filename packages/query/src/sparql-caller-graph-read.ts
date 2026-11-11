import { assertSafeIri } from '@origintrail-official/dkg-core';
import { isSparqlKeyword, type PreparedSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';
import { transitionGraphScope } from './sparql-query-transition.js';
import { ScopedQueryViolationError } from './scoped-query-error.js';
import { createBlankNodeRenamer, createVariableAllocator } from './sparql-rewrite-names.js';

const MAX_CALLER_GRAPH_BRANCHES = 128;

/** Bound UNION nesting instead of giving the parser a linear chain of branches. */
function balancedUnion(branches: readonly string[], start = 0, end = branches.length): string {
  if (end - start <= 16) return branches.slice(start, end).join(' UNION ');
  const middle = start + Math.floor((end - start) / 2);
  return `{ ${balancedUnion(branches, start, middle)} } UNION { ${balancedUnion(branches, middle, end)} }`;
}

/** A generated binding must not precede a caller assignment in the same group. */
function assignsGraphVariable(scope: PreparedSparqlQuery, opening: number, closing: number, variable: string): boolean {
  const { tokens } = scope.prepared;
  const depth = scope.structure.braces.depthBefore[opening] + 1;
  for (let index = opening + 1; index < closing; index++) {
    if (scope.structure.braces.depthBefore[index] !== depth || !isSparqlKeyword(tokens, index, 'BIND')) continue;
    const end = scope.structure.parentheses.matchingTokenIndexes[index + 1] ?? -1;
    const target = tokens[end - 1];
    if (end > index && end < closing && isSparqlKeyword(tokens, end - 2, 'AS')
      && target?.kind === 'variable' && target.logicalValue.slice(1) === variable) return true;
  }
  return false;
}

type Assignment = 'constant' | 'expression';

/**
 * Visit the variables a group binds for the pattern around it: each assignment
 * `( … AS ?var )` (a BIND, or a subquery's projection or grouping), as
 * `constant` when it is a single IRI and `expression` otherwise, and every
 * other variable. The parts whose bindings stay inside them are left out: a
 * MINUS group, an EXISTS group, a FILTER constraint and an assignment's
 * expression.
 */
function visitGroupBindings(
  scope: PreparedSparqlQuery, opening: number, closing: number,
  visit: (index: number, name: string, assignment?: Assignment) => void,
): void {
  const { tokens } = scope.prepared;
  const braces = scope.structure.braces.matchingTokenIndexes;
  const parentheses = scope.structure.parentheses.matchingTokenIndexes;
  const isSymbol = (index: number, value: string) => tokens[index]?.kind === 'symbol' && tokens[index].logicalValue === value;
  for (let index = opening + 1; index < closing; index++) {
    let end = -1;
    if ((isSparqlKeyword(tokens, index, 'MINUS') || isSparqlKeyword(tokens, index, 'EXISTS')) && isSymbol(index + 1, '{')) {
      end = braces[index + 1] ?? -1;
    } else if (isSparqlKeyword(tokens, index, 'FILTER')) {
      // FILTER ( … ), or a call: FILTER regex( … ), FILTER <f>( … ), FILTER x:f( … ).
      const call = isSymbol(index + 1, '(') ? index + 1 : index + 2;
      if (isSymbol(call, '(')) end = parentheses[call] ?? -1;
    } else if (isSymbol(index, '(')) {
      const last = parentheses[index] ?? -1;
      const target = tokens[last - 1];
      if (last > index && isSparqlKeyword(tokens, last - 2, 'AS') && target?.kind === 'variable') {
        const term = tokens[index + 1];
        const constant = last - 2 === index + 2 && (term?.kind === 'iri' || term?.kind === 'prefixed-name');
        visit(last - 1, target.logicalValue.slice(1), constant ? 'constant' : 'expression');
        end = last;
      }
    } else {
      const token = tokens[index];
      if (token.kind === 'variable') visit(index, token.logicalValue.slice(1));
    }
    if (end > index) index = end;
  }
}

/**
 * The assignments of each caller GRAPH ?var block to ?var that bind it for the
 * block, at any depth inside it, in a block that holds a subquery: a block
 * without one reads its assignment under another name instead.
 */
function callerGraphAssignmentsInside(scope: PreparedSparqlQuery): Assignment[] {
  const found: Assignment[] = [];
  for (const target of scope.graphTargets) {
    if (target.kind !== 'variable') continue;
    const opening = target.targetTokenIndex + 1;
    const closing = scope.structure.braces.matchingTokenIndexes[opening] ?? -1;
    if (!holdsSubquery(scope, opening, closing)) continue;
    visitGroupBindings(scope, opening, closing, (_index, name, assignment) => {
      if (assignment && name === target.variable.logicalName) found.push(assignment);
    });
  }
  return found;
}

/** Whether one branch per graph of `graphs` for every caller GRAPH ?var block stays within the rewrite's bound. */
export function callerGraphBranchesFit(scope: PreparedSparqlQuery, graphs: readonly string[]): boolean {
  return new Set(graphs).size * scope.graphTargets.filter(target => target.kind === 'variable').length <= MAX_CALLER_GRAPH_BRANCHES;
}

function holdsSubquery(scope: PreparedSparqlQuery, opening: number, closing: number): boolean {
  for (let index = opening + 1; index < closing; index++) if (isSparqlKeyword(scope.prepared.tokens, index, 'SELECT')) return true;
  return false;
}

/** The block's own assignments to ?name, and every other variable it binds for the pattern around it. */
function readGraphBlockBindings(scope: PreparedSparqlQuery, opening: number, closing: number, name: string) {
  const assignments: number[] = [];
  const others = new Set<string>();
  visitGroupBindings(scope, opening, closing, (index, variable, assignment) => {
    if (variable !== name) others.add(`?${variable}`);
    else if (assignment) assignments.push(index);
  });
  return { assignments, others };
}

/** The closing brace of the innermost OPTIONAL group inside the block that holds the token at `index`, or -1. */
function enclosingOptionalClosing(scope: PreparedSparqlQuery, opening: number, index: number): number {
  let closing = -1;
  for (const range of scope.structure.braces.ranges) {
    if (range.openingTokenIndex >= index) break;
    if (range.openingTokenIndex > opening && range.closingTokenIndex > index
      && isSparqlKeyword(scope.prepared.tokens, range.openingTokenIndex - 1, 'OPTIONAL')) closing = range.closingTokenIndex;
  }
  return closing;
}

/**
 * Oxigraph reads the patterns of a GRAPH ?var block that assigns ?var in the
 * graph it assigns, once for every graph of the dataset, so the block repeats
 * rows and a graph without triples still contributes them. A block without a
 * subquery reads instead with its assignments to ?var renamed, inside a
 * subquery that projects the variables the block binds, and keeps only the
 * rows whose assigned value is the graph it reads or that assign nothing:
 * `{ SELECT ?var … WHERE { GRAPH ?var { P[AS ?var := AS ?a] } FILTER(COALESCE(sameTerm(?a, ?var), true)) } }`.
 * An OPTIONAL that assigns checks the same inside it, so a value other than
 * the graph fails only that OPTIONAL and the row stays, as with a graph list.
 * Other reads of ?var in the block keep the graph's binding. (`COALESCE` keeps
 * a row whose assignment failed, which `!BOUND(?a)` would not on Oxigraph
 * 0.5.5.) An assignment inside MINUS, EXISTS or a FILTER binds nothing for the
 * block and stays as it is. A block with a subquery is left to the graph branches.
 */
export function isolateCallerGraphAssignments(scope: PreparedSparqlQuery): PreparedSparqlQuery {
  const { tokens } = scope.prepared;
  const blocks = scope.graphTargets.flatMap(target => {
    if (target.kind !== 'variable') return [];
    const opening = target.targetTokenIndex + 1;
    const closing = scope.structure.braces.matchingTokenIndexes[opening] ?? -1;
    if (closing < 0 || holdsSubquery(scope, opening, closing)) return [];
    const bindings = readGraphBlockBindings(scope, opening, closing, target.variable.logicalName);
    return bindings.assignments.length > 0 ? [{ target, opening, closing, ...bindings }] : [];
  }).filter((block, _index, all) => !all.some(other => other.opening < block.opening && block.closing < other.closing));
  if (blocks.length === 0) return scope;
  const allocate = createVariableAllocator(scope);
  let source = scope.source;
  for (const { target, opening, closing, assignments, others } of blocks.sort((left, right) => right.opening - left.opening)) {
    const name = target.variable.logicalName;
    const assigned = allocate(`__dkgAssigned${name}`);
    const projected = new Set<string>([`?${name}`, ...others]);
    const keep = `FILTER(COALESCE(sameTerm(${assigned}, ?${name}), true))`;
    const optionals = new Set(assignments.map(index => enclosingOptionalClosing(scope, opening, index)).filter(at => at >= 0));
    const edits = [
      ...assignments.map(index => ({ start: tokens[index].start, end: tokens[index].end, text: assigned })),
      ...[...optionals].map(at => ({ start: tokens[at].start, end: tokens[at].start, text: ` ${keep} ` })),
    ].sort((left, right) => left.start - right.start);
    let inner = '';
    let from = tokens[opening].end;
    for (const edit of edits) {
      inner += `${source.slice(from, edit.start)}${edit.text}`;
      from = edit.end;
    }
    inner += source.slice(from, tokens[closing].start);
    const graph = `GRAPH ?${name} {${inner}}`;
    const isolated = `{ SELECT ${[...projected].join(' ')} WHERE { ${graph} ${keep} } }`;
    source = `${source.slice(0, tokens[target.keywordTokenIndex].start)}${isolated}${source.slice(tokens[closing].end)}`;
  }
  return transitionGraphScope(scope, source);
}

/** Whether caller GRAPH ?var blocks assign ?var inside them, every time to a single IRI. */
export function hasCallerGraphAssignmentsInside(scope: PreparedSparqlQuery): boolean {
  const found = callerGraphAssignmentsInside(scope);
  return found.length > 0 && found.every(kind => kind === 'constant');
}

/** Whether a caller GRAPH ?var block assigns ?var an expression other than a single IRI, at any depth. */
export function hasCallerGraphExpressionAssignments(scope: PreparedSparqlQuery): boolean {
  return callerGraphAssignmentsInside(scope).includes('expression');
}

export function hasCallerGraphAssignments(scope: PreparedSparqlQuery): boolean {
  return scope.graphTargets.some(target => {
    if (target.kind !== 'variable') return false;
    const opening = target.targetTokenIndex + 1;
    const closing = scope.structure.braces.matchingTokenIndexes[opening] ?? -1;
    return closing >= 0 && assignsGraphVariable(scope, opening, closing, target.variable.logicalName);
  });
}

/** Keep the graph identity of caller paths on engines that flatten GRAPH ?g. */
export function bindCallerGraphsBeforeRead(
  scope: PreparedSparqlQuery, graphs: readonly string[],
): PreparedSparqlQuery {
  const { tokens } = scope.prepared;
  const allowed = [...new Set(graphs)].map(graph => `<${assertSafeIri(graph)}>`);
  // Bound the entire expansion, including queries with several GRAPH operands.
  // Larger native plans can overflow even when the textual UNION is balanced.
  if (allowed.length * scope.graphTargets.filter(target => target.kind === 'variable').length > MAX_CALLER_GRAPH_BRANCHES) {
    throw new ScopedQueryViolationError(`caller GRAPH rewrite requires at most ${MAX_CALLER_GRAPH_BRANCHES} graph branches on this store`);
  }
  const branchSource = createBlankNodeRenamer(scope);
  let from = 0;
  let source = '';
  for (const target of scope.graphTargets) {
    if (target.kind !== 'variable') continue;
    const opening = target.targetTokenIndex + 1;
    const closing = scope.structure.braces.matchingTokenIndexes[opening] ?? -1;
    const start = tokens[target.keywordTokenIndex].start;
    if (closing < 0 || start < from) {
      throw new ScopedQueryViolationError('unable to bind caller GRAPH before evaluation');
    }
    const variable = scope.source.slice(tokens[target.targetTokenIndex].start, tokens[target.targetTokenIndex].end);
    const needsOwnGroup = isSparqlKeyword(tokens, opening + 1, 'SELECT')
      || assignsGraphVariable(scope, opening, closing, target.variable.logicalName);
    // Even an OPTIONAL barrier loses GRAPH ?g on Blazegraph's repeated
    // alternative paths. Constant targets retain it. Keep the graph binding
    // available to ordinary FILTERs, outside caller assignments and subqueries.
    const branches = allowed.map(graph => {
      const inner = branchSource(tokens[opening].end, tokens[closing].start);
      const pattern = needsOwnGroup ? `{ ${inner} }` : inner;
      return `{ GRAPH ${graph} { VALUES ${variable} { ${graph} } ${pattern} } }`;
    });
    source += scope.source.slice(from, start) + `{ ${balancedUnion(branches)} }`;
    from = tokens[closing].end;
  }
  return transitionGraphScope(scope, source + scope.source.slice(from));
}
