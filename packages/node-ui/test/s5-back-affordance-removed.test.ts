import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// S5 (T13) — the in-detail "Back to Context Graph" affordance is gone;
// the persistent breadcrumb is the sole back-affordance. This is the
// grep guard from the handoff, run as a node-env source scan.
//
// Mirrors `grep -r "v10-ka-back\|Back to Context Graph" packages/node-ui/src`
// with one carve-out the handoff didn't anticipate: AgentProfileView's
// "← Back" button is an UNRELATED shell-level back (a sibling of the
// explicitly-protected PanelCenter "Back to Project") that legitimately
// reuses the `.v10-ka-back` class. So:
//   - "Back to Context Graph" — must be ZERO across all of src.
//   - `className="v10-ka-back"` — must be absent from the context-graph
//     detail views (components.tsx); the class may still exist in
//     AgentProfileView (out of scope) + styles.css (the class def).

const here = fileURLToPath(new URL('.', import.meta.url));
const SRC = resolve(here, '../src/ui');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe('S5 back-affordance removal (T13)', () => {
  it('no "Back to Context Graph" label remains anywhere in node-ui/src', () => {
    const offenders = walk(SRC).filter(f => readFileSync(f, 'utf8').includes('Back to Context Graph'));
    expect(offenders).toEqual([]);
  });

  it('the context-graph detail components render no .v10-ka-back button', () => {
    const components = readFileSync(resolve(SRC, 'views/project/components.tsx'), 'utf8');
    expect(components).not.toMatch(/className="v10-ka-back"/);
  });

  it('the breadcrumb separator (v10-project-strip-sep) is still defined (reused, not dropped)', () => {
    const css = readFileSync(resolve(SRC, 'styles.css'), 'utf8');
    expect(css).toMatch(/\.v10-project-strip-sep\s*\{/);
  });
});
