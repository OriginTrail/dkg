import ts from 'typescript';

export function inspectTestExceptions(source, filename, now = new Date()) {
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const bases = new Set(['it', 'test', 'describe', 'suite']);
  const focused = [];
  const invalidExceptions = [];
  for (const node of parsed.statements) {
    if (!ts.isImportDeclaration(node) || !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)) continue;
    for (const entry of node.importClause.namedBindings.elements) {
      if (bases.has(entry.propertyName?.text ?? entry.name.text)) bases.add(entry.name.text);
    }
  }
  function root(node) {
    while (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) node = node.expression;
    return ts.isIdentifier(node) ? node.text : '';
  }
  function walk(node) {
    if ((ts.isPropertyAccessExpression(node) && node.name.text === 'only' && bases.has(root(node.expression))) ||
        (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['fit', 'fdescribe', 'ftest'].includes(node.expression.text))) {
      focused.push(parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1);
    }
    ts.forEachChild(node, walk);
  }
  walk(parsed);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
    if (![ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.MultiLineCommentTrivia].includes(scanner.getToken())) continue;
    const comment = scanner.getTokenText();
    if (!comment.includes('test-disable-allow:')) continue;
    const expiry = /\bexpires=(\d{4}-\d{2}-\d{2})\b/.exec(comment)?.[1];
    const owner = /\bowner=([\w@.-]+)/.exec(comment)?.[1];
    const lane = /\blane=([\w:-]+)/.exec(comment)?.[1];
    const date = expiry ? new Date(`${expiry}T23:59:59Z`) : new Date(NaN);
    const remaining = date.valueOf() - now.valueOf();
    if (!owner || !lane || !Number.isFinite(remaining) || date.toISOString().slice(0, 10) !== expiry || remaining < 0 || remaining > 31 * 86_400_000) {
      invalidExceptions.push(parsed.getLineAndCharacterOfPosition(scanner.getTokenPos()).line + 1);
    }
  }
  return { focused, invalidExceptions };
}
