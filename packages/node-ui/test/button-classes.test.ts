// Buttons declare their look on the element (ds-btn + variant/size), not via
// per-screen names registered in the design-system stylesheet (review:
// "apply shared button classes at the element").
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI = resolve(__dirname, '../src/ui');
const SCREEN_BUTTONS = [
  'retry-btn', 'header-icon-btn', 'notif-btn', 'tree-hide-btn', 'tree-catalogue-btn', 'new-project-btn',
  'agent-link-btn', 'agent-send-btn', 'mlv-run-btn', 'mlv-save-btn', 'mlv-clear-btn', 'btn-promote-all',
  'btn-promote', 'btn-publish', 'modal-btn', 'genui-error-cta-btn', 'empty-state-action', 'po-identity-primer',
  'po-join-btn', 'layer-expand-footer-btn', 'item-promote-btn', 'layer-action-btn', 'decision-btn',
  'graph-expand-btn', 'ka-verify-btn', 'primer-back', 'identity-wallet-btn', 'pca-card-btn', 'pca-copy-btn',
  'ws-pca-cta', 'wallet-connect-btn', 'wallet-pill-btn', 'modal-close', 'graph-expanded-close', 'agents-refresh',
  'md-copy', 'publish-panel-refresh', 'notif-pane-markread', 'bottom-toggle', 'peer-chip-more',
].map(n => `v10-${n}`);
const NAME = new RegExp(`(?<![\\w-])(${SCREEN_BUTTONS.join('|')})(?![\\w-])`);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return name.endsWith('.tsx') && !name.startsWith('__') ? [full] : [];
  });
}

describe('button classes', () => {
  it('every element with a screen button class also declares ds-btn', () => {
    const missing: string[] = [];
    for (const file of tsxFiles(UI)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/className=(\{`[^`]*`\}|"[^"]*"|\{\[[^\]]*\])/g)) {
        if (NAME.test(m[1]) && !m[1].includes('ds-btn')) missing.push(`${relative(UI, file)}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('the shared button rules name only ds-* classes', () => {
    const css = readFileSync(join(UI, 'styles/27-ds-components.css'), 'utf8');
    const section = css.slice(css.indexOf('/* ══ Button'), css.indexOf('/* ══ Tabs')).replace(/\/\*[\s\S]*?\*\//g, '');
    const shared = section.split('}').map(r => r.split('{')[0]!.trim()).filter(sel => sel.includes('.ds-'));
    expect(shared.length).toBeGreaterThan(10);
    for (const sel of shared) expect(sel).not.toMatch(NAME);
  });
});
