import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const TARGETS = [
  '../src/dkg-agent.ts',
  '../src/dkg-agent-lifecycle.ts',
  '../src/dkg-agent-cg-registry.ts',
  '../src/dkg-agent-context-graph.ts',
  '../src/dkg-agent-publish.ts',
  '../src/finalization-handler.ts',
] as const;

describe('lifecycle query source coverage', () => {
  it('keeps direct store queries attributable in the profiled lifecycle paths', () => {
    const missingOptions: string[] = [];

    for (const relativePath of TARGETS) {
      const path = fileURLToPath(new URL(relativePath, import.meta.url));
      const sourceText = readFileSync(path, 'utf8');
      const sourceFile = ts.createSourceFile(
        path,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );

      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === 'query'
        ) {
          const receiver = node.expression.expression.getText(sourceFile);
          if (/(?:^|\.)store\??$/.test(receiver) && node.arguments.length < 2) {
            const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            missingOptions.push(`${relativePath}:${position.line + 1}`);
          }
        }
        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
    }

    expect(missingOptions).toEqual([]);
  });
});
