// Every page has one title style, one gutter and one width (DESIGN.md · Layout).
import { describe, expect, it } from 'vitest';
import { cssFiles, read, where } from './helpers/source.js';
const PAGES = [
  'views/DashboardView.tsx', 'views/MemoryStackView.tsx', 'pages/Operations.tsx', 'pages/Settings.tsx',
  'pages/conviction/ConvictionOverview.tsx',
];

describe('pages', () => {
  it.each(PAGES)('%s uses PageHeader and no h1 of its own', (file) => {
    const source = read(file);
    expect(source).toContain('<PageHeader');
    expect(source).not.toMatch(/<h1\b/);
  });

  it('keeps Publisher Conviction at the narrow page width', () => {
    expect(read('pages/conviction/ConvictionOverview.tsx')).toContain('className="ds-page ds-page-narrow"');
    expect(read('styles/27-ds-components.css')).toMatch(/\.ds-page-narrow \{ max-width: var\(--page-max-narrow\); \}/);
  });

  it('takes the gutter from one token', () => {
    expect(read('styles/03-left-center.css')).toMatch(/\.v10-center-content \{[^}]*padding: var\(--page-gutter\)/);
    const styles = cssFiles.filter((f) => where(f).startsWith('styles/')).map((f) => read(f)).join('\n');
    expect(styles).not.toMatch(/\.ds-page \{[^}]*padding/);
    expect(styles).not.toMatch(/margin: -24px -28px/);
  });
});
