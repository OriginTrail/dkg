// Tabs, segmented controls, filter chips, surfaces and inputs declare their
// look on the element (ds-* classes), like buttons (button-classes.test.ts),
// not via per-screen names registered in the design-system stylesheet
// (review: "replace the screen-selector override registry with explicit
// primitive ownership").
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const UI = resolve(__dirname, '../src/ui');

/** Screen class → the shared classes every element using it must also carry. */
const PRIMITIVES: Record<string, string[]> = {
  'ds-tab': ['v10-layer-switch-btn', 'v10-bottom-tab', 'v10-layer-expand-tab', 'v10-content-tab'],
  'ds-seg': ['v10-mlv-view-toggle'],
  'ds-seg-item': ['v10-agent-mode-tab', 'v10-mlv-toggle-btn'],
  'ds-filter': ['v10-subgraph-chip', 'v10-subgraph-filter-chip'],
  'ds-overlay': ['v10-modal-box', 'v10-drop-overlay-card'],
  'ds-card': ['stat-card', 'v10-dash-section', 'v10-vm-hero', 'v10-genui-card', 'v10-sgov-card', 'v10-empty-state', 'v10-cg-query-zone', 'v10-publish-panel', 'v10-import-dropzone'],
  'ds-card-nested': ['v10-modal-error', 'v10-modal-tip', 'v10-modal-warning', 'v10-genui-stat', 'v10-pca-create-warn', 'v10-wallet-row', 'v10-notif-pane', 'v10-select-menu', 'v10-mlv-table-wrap'],
  'ds-input': ['v10-form-input', 'v10-form-select', 'v10-form-textarea', 'v10-select-trigger', 'v10-cg-query-textarea', 'v10-log-filter', 'v10-entity-list-sort-select'],
};
const SCREEN = Object.values(PRIMITIVES).flat();
const has = (text: string, cls: string) => new RegExp(`(?<![\\w-])${cls}(?![\\w-])`).test(text);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return name.endsWith('.tsx') && !name.startsWith('__') ? [full] : [];
  });
}

describe('design-system classes on the element', () => {
  it('every element with a screen class also declares its shared class', () => {
    const missing: string[] = [];
    for (const file of tsxFiles(UI)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/className=(\{`[^`]*`\}|"[^"]*"|\{[^}]*\})/g)) {
        for (const [ds, screens] of Object.entries(PRIMITIVES)) {
          if (screens.some(s => has(m[1], s)) && !has(m[1], ds)) missing.push(`${relative(UI, file)}: ${m[1]} (needs ${ds})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('the shared stylesheet names no screen classes in these primitives', () => {
    const css = readFileSync(join(UI, 'styles/27-ds-components.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = css.split('}').map(r => r.split('{')[0]!.trim()).filter(Boolean);
    const offenders = selectors.filter(sel => SCREEN.some(s => has(sel, s)));
    expect(offenders).toEqual([]);
  });
});
