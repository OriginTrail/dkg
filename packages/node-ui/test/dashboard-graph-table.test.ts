// The table's columns are set in CSS, so a layout test can't see them under happy-dom.
// These read the rules that keep the name visible and the headers at label size.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, '../src/ui/styles/10-dashboard.css'), 'utf8');

describe('My Context Graphs table', () => {
  it('moves Size under the name when the table is narrow', () => {
    const narrow = /@container cg-table \(max-width: 560px\) \{([\s\S]*?)\r?\n\}/.exec(css)?.[1] ?? '';
    expect(narrow).toMatch(/grid-template-columns: minmax\(0, 1fr\) 40px 52px 76px/);
    expect(narrow).toMatch(/\.v10-cg-row \.v10-cg-size \{ grid-column: 1 \/ -1; grid-row: 2/);
  });

  it('lets header cells take the header type, not the row type', () => {
    expect(css).toMatch(/\.v10-cg-colhead \{[^}]*font-size: var\(--fs-label\)/);
    expect(css).toMatch(/\.v10-cg-colhead \.v10-cg-cell \{ font-size: inherit; font-weight: inherit; color: inherit; \}/);
  });
});
