// The repository modules a CI script loads, itself included, following its
// static relative imports: what a sparse checkout or a path-filtered trigger
// for that script has to name.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './ci-plan-fixtures.mjs';

export function importClosure(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const [, specifier] of source.matchAll(/^\s*(?:import|export)\s(?:[^'";]*?\sfrom\s)?'(\.{1,2}\/[^']+)'/gm)) {
      visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
    }
  };
  visit(entry);
  return [...seen].sort();
}
