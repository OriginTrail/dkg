// The accessibility rules in DESIGN.md that can be read from the code: every
// control has a name, clickable things work from the keyboard, dialogs are
// named, and focus stays visible.
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { UI, attrsOf, hasSpread, opening, uiFiles as files, type Jsx } from './helpers/jsx.js';

/** True when the node puts words on screen, as text or a value worked out at runtime. */
function hasText(n: ts.Node): boolean {
  if (ts.isJsxText(n)) return /\S/.test(n.text);
  if (ts.isJsxSelfClosingElement(n)) return false;
  if (ts.isJsxElement(n)) return !attrsOf(n).has('aria-hidden') && n.children.some(hasText);
  if (ts.isJsxFragment(n)) return n.children.some(hasText);
  if (ts.isJsxExpression(n)) {
    let found = false;
    const look = (x: ts.Node): void => {
      if (ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x) || ts.isJsxFragment(x)) found ||= hasText(x);
      else if (ts.isStringLiteralLike(x) || ts.isTemplateExpression(x)) found ||= x.getText().length > 2;
      else if (ts.isIdentifier(x) || ts.isPropertyAccessExpression(x) || ts.isCallExpression(x)) found = true;
      else ts.forEachChild(x, look);
    };
    if (n.expression) look(n.expression);
    return found;
  }
  return false;
}

function scan(visit: (n: Jsx, where: string, context: { inLabel: boolean; labelled: Set<string> }) => void) {
  for (const file of files.filter((f) => f.endsWith('.tsx'))) {
    const source = readFileSync(file, 'utf8');
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const labelled = new Set([...source.matchAll(/htmlFor=(?:"([^"]+)"|\{([^}]+)\})/g)].map((m) => m[1] ?? m[2]!));
    const walkTree = (n: ts.Node, inLabel: boolean) => {
      let nextInLabel = inLabel;
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
        nextInLabel ||= opening(n).tagName.getText() === 'label';
        const line = tree.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        visit(n, `${relative(UI, file).replace(/\\/g, '/')}:${line}`, { inLabel, labelled });
      }
      ts.forEachChild(n, (child) => walkTree(child, nextInLabel));
    };
    walkTree(tree, false);
  }
}

const named = (a: Map<string, ts.JsxAttribute>) => a.has('aria-label') || a.has('aria-labelledby') || a.has('ariaLabel');

describe('accessibility rules', { timeout: 30_000 }, () => {
  it('names every icon-only button', () => {
    const found: string[] = [];
    scan((n, where) => {
      const tag = opening(n).tagName.getText();
      if (tag !== 'button' && tag !== 'Button') return;
      const a = attrsOf(n);
      if (named(a) || hasSpread(n)) return;
      if (!(ts.isJsxElement(n) && n.children.some(hasText))) found.push(where);
    });
    expect(found).toEqual([]);
  });

  it('names every form control', () => {
    const found: string[] = [];
    scan((n, where, { inLabel, labelled }) => {
      const tag = opening(n).tagName.getText();
      if (!['input', 'select', 'textarea', 'Select'].includes(tag)) return;
      const a = attrsOf(n);
      if (named(a) || hasSpread(n) || inLabel) return;
      if (/hidden|file/.test(a.get('type')?.getText() ?? '')) return;
      const id = a.get('id')?.initializer?.getText().replace(/^["{]|["}]$/g, '');
      if (!id || !labelled.has(id)) found.push(where);
    });
    expect(found).toEqual([]);
  });

  it('gives clickable elements a way in from the keyboard', () => {
    const found: string[] = [];
    scan((n, where) => {
      if (!/^(div|span|li|tr|td|p|section|article)$/.test(opening(n).tagName.getText())) return;
      const a = attrsOf(n);
      const click = a.get('onClick')?.getText();
      if (!click || a.has('role') || a.has('tabIndex') || a.has('aria-hidden')) return;
      // Backdrops are a mouse shortcut for Escape; a stopPropagation-only handler isn't an action.
      if (/onBackdropClick|target === \w+\.currentTarget|^onClick=\{\(?\w*\)? => \w+\.stopPropagation\(\)\}$/.test(click)) return;
      if (!n.getText().includes('ds-row-open')) found.push(where);
    });
    expect(found).toEqual([]);
  });

  it('names every dialog', () => {
    const found: string[] = [];
    scan((n, where) => {
      const a = attrsOf(n);
      if (/"(alert)?dialog"/.test(a.get('role')?.getText() ?? '') && !named(a)) found.push(where);
    });
    expect(found).toEqual([]);
  });

  it('keeps a visible focus style wherever the outline is removed for keyboard focus', () => {
    const found: string[] = [];
    for (const file of files.filter((f) => f.endsWith('.css'))) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (/:focus-visible/.test(selector!.replace(':not(:focus-visible)', '')) && /outline:\s*(none|0)/.test(body!) && !/box-shadow/.test(body!)) {
          found.push(`${relative(UI, file)}: ${selector!.trim()}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
