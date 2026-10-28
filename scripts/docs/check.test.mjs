import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const pages = [
  ['docs/references/availability.md', 'capabilities'],
  ['docs/references/tool-route-map.md', 'tool-routes'],
];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dkg-docs-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const read = path => readFileSync(join(root, path), 'utf8');
  write('scripts/docs/check.mjs', '');
  copyFileSync(new URL('./check.mjs', import.meta.url), join(root, 'scripts/docs/check.mjs'));
  write('scripts/docs/capabilities.json', JSON.stringify([{
    name: 'Test capability', page: pages[0][0], availability: 'released baseline',
    baseline: '1.2.3', owner: 'Test maintainer', reviewedOn: '2026-10-14',
    validation: 'Fixture validated', sources: ['examples/docs/atlas.ttl'],
  }]));
  write('docs/SUMMARY.md', pages.map(([path]) => `* [Reference](${path.slice(5)})`).join('\n'));
  for (const [path, id] of pages) write(path, `---\ntitle: Keep frontmatter\n---\n\n# Authored heading\n\nIntroductory prose.\n\n<!-- BEGIN GENERATED: ${id} -->\nstale table\n<!-- END GENERATED: ${id} -->\n\nAuthored footer.\n`);
  write('packages/cli/skills/dkg-node/SKILL.md', '| Tool | Wraps | Short description |\n|---|---|---|\n| `dkg_status` | `GET /api/status` | Status |\n\n');
  const turtle = '<urn:atlas> <urn:name> "Atlas" .\n';
  write('examples/docs/atlas.ttl', turtle);
  write('docs/getting-started/quickstart.md', `\x60\x60\x60turtle\n${turtle}\x60\x60\x60\n`);
  const run = (...args) => spawnSync(process.execPath, [join(root, 'scripts/docs/check.mjs'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  });
  return { read, write, run };
}

function outsideTable(content, id) {
  const begin = `<!-- BEGIN GENERATED: ${id} -->`;
  const end = `<!-- END GENERATED: ${id} -->`;
  return [content.slice(0, content.indexOf(begin) + begin.length), content.slice(content.indexOf(end))];
}

test('regeneration updates only tables and preserves prose edits and frontmatter', t => {
  const f = fixture(t);
  const authored = pages.map(([path, id]) => outsideTable(f.read(path), id));
  assert.equal(f.run().status, 1, 'Stale tables must fail the read-only check');
  const generated = f.run('--write');
  assert.equal(generated.status, 0, generated.stderr);
  assert.match(f.read(pages[0][0]), /Test capability.*1\.2\.3/);
  assert.match(f.read(pages[1][0]), /`dkg_status` \| `GET \/api\/status`/);
  pages.forEach(([path, id], index) => assert.deepEqual(outsideTable(f.read(path), id), authored[index]));

  for (const [path] of pages) f.write(path, f.read(path).replace('Introductory prose.', 'Edited explanation.'));
  assert.equal(f.run().status, 0, 'Authored prose edits must not make tables stale');
  const registry = JSON.parse(f.read('scripts/docs/capabilities.json'));
  registry[0].baseline = '2.0.0';
  f.write('scripts/docs/capabilities.json', JSON.stringify(registry));
  f.write('packages/cli/skills/dkg-node/SKILL.md', f.read('packages/cli/skills/dkg-node/SKILL.md').replace('GET /api/status', 'GET /api/status-v2'));
  assert.equal(f.run().status, 1);
  assert.equal(f.run('--write').status, 0);
  assert.match(f.read(pages[0][0]), /Test capability.*2\.0\.0/);
  assert.match(f.read(pages[1][0]), /GET \/api\/status-v2/);
  for (const [path] of pages) assert.match(f.read(path), /Edited explanation\./);
  const once = pages.map(([path]) => f.read(path));
  assert.equal(f.run('--write').status, 0);
  assert.deepEqual(pages.map(([path]) => f.read(path)), once, 'Regeneration must be idempotent');
  assert.equal(f.run().status, 0);
});

for (const [path, id] of pages) {
  for (const corruption of ['missing', 'duplicate', 'reversed']) {
    test(`${id}: ${corruption} markers fail without overwriting the page`, t => {
      const f = fixture(t);
      assert.equal(f.run('--write').status, 0);
      const begin = `<!-- BEGIN GENERATED: ${id} -->`;
      const end = `<!-- END GENERATED: ${id} -->`;
      let broken = f.read(path);
      if (corruption === 'missing') broken = broken.replace(end, '');
      if (corruption === 'duplicate') broken += `\n${begin}\n`;
      if (corruption === 'reversed') broken = broken.replace(begin, 'PLACEHOLDER').replace(end, begin).replace('PLACEHOLDER', end);
      f.write(path, broken);
      for (const args of [[], ['--write']]) {
        const result = f.run(...args);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /expected one ordered pair/);
        assert.equal(f.read(path), broken);
      }
    });
  }
}
