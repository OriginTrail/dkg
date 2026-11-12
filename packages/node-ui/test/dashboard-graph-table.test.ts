// The table's columns are set in CSS, so a layout test can't see them under happy-dom.
// These read the rules that keep the name visible and the headers at label size.
import { describe, expect, it } from 'vitest';
import { cssFiles, read, where, withoutCssComments } from './helpers/source.js';

const css = read('styles/10-dashboard.css');

describe('My Context Graphs table', () => {
  it('moves Size under the name when the table is narrow', () => {
    const narrow = /@container cg-table \(max-width: 560px\) \{([\s\S]*?)\r?\n\}/.exec(css)?.[1] ?? '';
    expect(narrow).toMatch(/grid-template-columns: minmax\(0, 1fr\) 40px 52px 76px/);
    expect(narrow).toMatch(/\.v10-cg-row \.v10-cg-size \{ grid-column: 1 \/ -1; grid-row: 2/);
  });

  it('lets header cells take the header type, not the row type', () => {
    expect(css).toMatch(/\.v10-cg-colhead \.v10-cg-cell \{ font-size: inherit; font-weight: inherit; color: inherit; \}/);
  });

  it('shares one header style with every other table', () => {
    const all = cssFiles.filter((f) => where(f).startsWith('styles/')).map((f) => withoutCssComments(read(f))).join('\n');
    expect(all).toMatch(/\.data-table th,\s*\.ds-table-head \{\s*font-size: var\(--fs-label\);\s*font-weight: 500;[^}]*letter-spacing: var\(--ls-caps\);\s*text-transform: uppercase;\s*color: var\(--text-tertiary\);/);
    // Screens take the shared class; the design-system rule names no screen.
    expect(read('views/DashboardView.tsx')).toContain('className="v10-cg-colhead ds-table-head"');
    for (const file of ['views/MemoryLayerView.tsx', 'views/project/components/ka.tsx', 'views/project/components/query.tsx']) {
      const src = read(file);
      expect(src.match(/<th\b(?![^>]*ds-table-head)/g), file).toBeNull();
    }
    const ownType = [...all.matchAll(/(?:^|[\s,>])th\s*\{([^}]*)\}/g)].filter((m) => /font-size|font-weight|letter-spacing|text-transform|(?:^|\s)color:/.test(m[1]!));
    expect(ownType.map((m) => m[0].trim())).toEqual([]);
  });

  it('keeps a pinned header cell on the header row background', () => {
    const fill = (file: string, selector: string) => new RegExp(`${selector} \\{[^}]*background: (var\\(--[\\w-]+\\))`).exec(read(`styles/${file}`))?.[1];
    const pinned = /\.ds-table-pin th:first-child \{ background: (var\(--[\w-]+\)); \}/.exec(read('styles/27-ds-components.css'))?.[1];
    expect(pinned).toBe(fill('12-observability.css', '\\.data-table th'));
  });
});
