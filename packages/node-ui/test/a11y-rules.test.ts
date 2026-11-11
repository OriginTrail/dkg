// The accessibility rules in DESIGN.md that can be read from the code: every
// control has a name, clickable things work from the keyboard, dialogs are
// named, and focus stays visible.
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { UI, attrsOf, hasSpread, jsxElements, opening, parseTsx, uiFiles as files, uiJsxElements, type Jsx } from './helpers/jsx.js';

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

/**
 * Why a clickable element that isn't a control can't be used from the keyboard, or null when it can.
 * It has to join the tab order (a tabIndex other than -1) and answer Enter or Space (an onKeyDown or
 * onKeyUp handler), or spread `pressable()`, which gives it both. A role or a tabIndex alone does
 * neither. Backdrops (a mouse shortcut for Escape), stopPropagation-only handlers and rows whose
 * name is a real button (`ds-row-open`) are exempt, and so is an option, menu item or tree item
 * whose listbox, menu or tree takes the keys itself.
 */
function keyboardGap(n: Jsx, ancestors: Jsx[] = []): string | null {
  if (!/^(div|span|li|tr|td|p|section|article)$/.test(opening(n).tagName.getText())) return null;
  const spreads = opening(n).attributes.properties.filter(ts.isJsxSpreadAttribute).map((x) => x.expression.getText());
  if (spreads.some((x) => x.startsWith('pressable('))) return null;
  const a = attrsOf(n);
  const click = a.get('onClick')?.getText();
  if (!click || a.has('aria-hidden')) return null;
  const role = a.get('role')?.initializer?.getText() ?? '';
  const OWNER: Record<string, RegExp> = { '"option"': /"listbox"/, '"menuitem"': /"menu"/, '"treeitem"': /"tree"/ };
  if (OWNER[role]) {
    const owner = ancestors.find((x) => OWNER[role]!.test(attrsOf(x).get('role')?.initializer?.getText() ?? ''));
    if (owner && attrsOf(owner).has('onKeyDown')) return null;
  }
  if (/onBackdropClick|target === \w+\.currentTarget|^onClick=\{\(?\w*\)? => \w+\.stopPropagation\(\)\}$/.test(click)) return null;
  if (n.getText().includes('ds-row-open')) return null;
  const tab = a.get('tabIndex')?.initializer?.getText().replace(/[{}"'\s]/g, '');
  const reachable = tab !== undefined && tab !== '-1';
  const activates = a.has('onKeyDown') || a.has('onKeyUp');
  if (reachable && activates) return null;
  if (!reachable && !activates) return 'not focusable, no key handler';
  return reachable ? 'no Enter/Space handler' : 'not focusable';
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
    for (const { node, ancestors, where } of uiJsxElements()) {
      const gap = keyboardGap(node, ancestors);
      if (gap) found.push(`${where} (${gap})`);
    }
    expect(found).toEqual([]);
  });

  it('asks for focus and Enter/Space, not a role or a tabIndex alone', () => {
    // The verdict on the innermost clickable element of the snippet.
    const verdict = (jsx: string) => {
      const all = [...jsxElements(parseTsx(`const x = ${jsx};`))];
      const target = all.reverse().find(({ node }) => attrsOf(node).has('onClick') || hasSpread(node))!;
      return keyboardGap(target.node, target.ancestors);
    };
    expect(verdict('<div role="button" onClick={open}>Open</div>')).toBe('not focusable, no key handler');
    expect(verdict('<div tabIndex={0} onClick={open}>Open</div>')).toBe('no Enter/Space handler');
    expect(verdict('<div role="button" tabIndex={-1} onKeyDown={key} onClick={open}>Open</div>')).toBe('not focusable');
    expect(verdict('<div role="button" tabIndex={0} onKeyDown={key} onClick={open}>Open</div>')).toBeNull();
    expect(verdict('<li {...pressable(open)}>Open</li>')).toBeNull();
    expect(verdict('<div className="v10-modal-overlay" onClick={onBackdropClick} role="presentation" />')).toBeNull();
    expect(verdict('<tr onClick={open}><td><button className="ds-row-open">Open</button></td></tr>')).toBeNull();
    // An option is reached through its listbox, which has to take the keys.
    expect(verdict('<ul role="listbox" tabIndex={-1} onKeyDown={key}><li role="option" onClick={pick}>A</li></ul>')).toBeNull();
    expect(verdict('<ul role="listbox"><li role="option" onClick={pick}>A</li></ul>')).toBe('not focusable, no key handler');
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
