// Buttons declare their look on the element (ds-btn + variant/size), not via
// per-screen names registered in the design-system stylesheet (review:
// "apply shared button classes at the element").
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { UI, classText, jsxElements, parseTsx, tagName, tsxFiles } from './helpers/jsx.js';

const SCREEN_BUTTONS = [
  'retry-btn', 'header-icon-btn', 'notif-btn', 'tree-hide-btn', 'tree-catalogue-btn', 'new-project-btn',
  'agent-link-btn', 'agent-send-btn', 'mlv-run-btn', 'mlv-save-btn', 'mlv-clear-btn', 'btn-promote-all',
  'btn-promote', 'btn-publish', 'modal-btn', 'genui-error-cta-btn', 'empty-state-action', 'po-identity-primer',
  'po-join-btn', 'layer-expand-footer-btn', 'item-promote-btn', 'layer-action-btn', 'decision-btn',
  'graph-expand-btn', 'ka-verify-btn', 'primer-back', 'identity-wallet-btn', 'pca-card-btn', 'pca-copy-btn',
  'ws-pca-cta', 'wallet-connect-btn', 'wallet-pill-btn', 'modal-close', 'graph-expanded-close', 'agents-refresh',
  'md-copy', 'publish-panel-refresh', 'notif-pane-markread', 'bottom-toggle', 'peer-chip-more',
].map(n => `v10-${n}`);
const BUTTON_COMPONENTS = new Set(['Button', 'RetryButton']);
const NAME = new RegExp(`(?<![\\w-])(${SCREEN_BUTTONS.join('|')})(?![\\w-])`);

/** Elements with a screen button class but no ds-btn. <Button> and the components built
 *  on it render ds-btn themselves, so they're exempt by tag, read from the JSX tree. */
function missingDsBtn(tree: ts.SourceFile, file?: string): string[] {
  const missing: string[] = [];
  for (const { node, where } of jsxElements(tree, file)) {
    if (BUTTON_COMPONENTS.has(tagName(node))) continue;
    const cls = classText(node);
    if (NAME.test(cls) && !cls.includes('ds-btn')) missing.push(`${where}: ${cls}`);
  }
  return missing;
}

describe('button classes', () => {
  it('every element with a screen button class also declares ds-btn', () => {
    const missing = tsxFiles
      .filter((file) => !basename(file).startsWith('__'))
      .flatMap((file) => missingDsBtn(parseTsx(readFileSync(file, 'utf8'), file), file));
    expect(missing).toEqual([]);
  });

  it('exempts <Button> and <RetryButton> by their tag, whatever props come first', () => {
    const tree = parseTsx(`<>
      <Button children={<span>Retry</span>} className="v10-ws-pca-cta" />
      <RetryButton className="v10-ws-pca-cta" onClick={() => undefined} />
      <button type="button" className="v10-ws-pca-cta">Not a ds button</button>
    </>`);
    expect(missingDsBtn(tree).map((m) => m.replace(/^.*?: /, ''))).toEqual(['"v10-ws-pca-cta"']);
  });

  it('the shared button rules name only ds-* classes', () => {
    const css = readFileSync(join(UI, 'styles/27-ds-components.css'), 'utf8');
    const section = css.slice(css.indexOf('/* ══ Button'), css.indexOf('/* ══ Tabs')).replace(/\/\*[\s\S]*?\*\//g, '');
    const shared = section.split('}').map(r => r.split('{')[0]!.trim()).filter(sel => sel.includes('.ds-'));
    expect(shared.length).toBeGreaterThan(10);
    for (const sel of shared) expect(sel).not.toMatch(NAME);
  });
});
