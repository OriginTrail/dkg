// The repository-script routes (ci-routing.mjs): every route and every
// declared build-only entry still matches an existing script.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { BUILD_ONLY_SCRIPTS, SUPPORT_PATH_ROUTES, scriptsPattern } from '../ci-routing.mjs';
import { REPO_ROOT } from './ci-plan-fixtures.mjs';

test('each repository-script route and build-only entry is the first match for a script that exists', () => {
  // A family entry whose scripts are gone must go, rather than wait to match
  // a new script by accident.
  const files = (directory) => fs.readdirSync(path.join(REPO_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.name === 'node_modules') return [];
    return entry.isDirectory() ? files(relative) : [relative];
  });
  const scripts = files('scripts');
  const firstRoute = (file) => SUPPORT_PATH_ROUTES.find(({ pattern }) => pattern.test(file));
  const routes = SUPPORT_PATH_ROUTES.filter(({ pattern }) => pattern.source.startsWith('^scripts'));
  assert.ok(routes.length >= 8);
  for (const route of routes) {
    assert.ok(scripts.some((file) => firstRoute(file) === route), `${route.pattern} is the first match for no script`);
  }
  for (const family of BUILD_ONLY_SCRIPTS) {
    const route = routes.find(({ reason }) => reason === family.reason);
    for (const name of family.files ?? []) {
      assert.equal(firstRoute(`scripts/${name}`), route, `scripts/${name} must exist and route by its family`);
      assert.ok(scripts.includes(`scripts/${name}`), `scripts/${name} is declared but missing`);
    }
    for (const entry of [
      ...(family.prefixes ?? []).map((prefix) => ({ prefixes: [prefix] })),
      ...(family.directories ?? []).map((directory) => ({ directories: [directory] })),
    ]) {
      const pattern = scriptsPattern(entry);
      assert.ok(scripts.some((file) => pattern.test(file) && firstRoute(file) === route), `${pattern} is the first route for no script`);
    }
  }
});
