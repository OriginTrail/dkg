import ts from 'typescript';
// Conservative: direct assertions in a try whose catch cannot throw. Assertions
// in callbacks and catches with a possible rethrow need review, not a guess.
export function swallowedAssertions(source, file) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const assertionNames = new Set();
  for (const node of tree.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const module = node.moduleSpecifier.text, clause = node.importClause;
    if (['node:assert', 'node:assert/strict', 'assert', 'assert/strict'].includes(module)) {
      if (clause?.name) assertionNames.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) assertionNames.add(clause.namedBindings.name.text);
    }
    if (['vitest', '@playwright/test', 'chai'].includes(module) && clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const entry of clause.namedBindings.elements) if (['expect','assert'].includes((entry.propertyName ?? entry.name).text)) assertionNames.add(entry.name.text);
    }
  }
  const findings = [];
  function contains(node, predicate) {
    if (predicate(node)) return true;
    if (ts.isFunctionLike(node)) return false;
    return ts.forEachChild(node, child => contains(child, predicate)) === true;
  }
  function assertion(node) {
    if (!ts.isCallExpression(node)) return false;
    let expression = node.expression;
    while (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression) || ts.isCallExpression(expression)) expression = expression.expression;
    return ts.isIdentifier(expression) && assertionNames.has(expression.text);
  }
  function visit(node) {
    if (ts.isTryStatement(node) && node.catchClause
      && !contains(node.catchClause.block, child => ts.isThrowStatement(child))) {
      const prefix = source.slice(Math.max(0, node.getStart(tree) - 350), node.getStart(tree));
      // A narrowly reviewed exception must cite an incident and explain how the
      // caught assertion still fails the enclosing test. It applies to one try.
      const waived = /\/\/ qa-assertion-catch: GH-\d+ -- [^\n]{20,}\n\s*$/.test(prefix);
      const collect = child => {
        if (ts.isFunctionLike(child)) return;
        if (assertion(child)) {
          const line = tree.getLineAndCharacterOfPosition(child.getStart(tree)).line + 1;
          if (!findings.some(row => row.line === line)) findings.push({ file, line, message: 'assertion can be swallowed by this catch' });
          return;
        }
        ts.forEachChild(child, collect);
      };
      if (!waived) collect(node.tryBlock);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return findings;
}
