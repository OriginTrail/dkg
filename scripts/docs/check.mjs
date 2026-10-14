import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const failures = [];
const summary = read('docs/SUMMARY.md');
const pages = [...summary.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)].map(m => `docs/${m[1]}`);
if (pages.length !== new Set(pages).size) failures.push('SUMMARY.md contains duplicate targets');

// Check only the published corpus, not deliberately unpublished engineering archives.
function validateLinks() {
  for (const page of pages) {
    if (!existsSync(resolve(root, page))) { failures.push(`Missing navigation target: ${page}`); continue; }
    const text = read(page).replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
    const targets = [
      ...[...text.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)].map(m => m[1] || m[2]),
      ...[...text.matchAll(/(?:href|src)="([^"]+)"/g)].map(m => m[1]),
    ];
    for (const target of targets) {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(target)) continue;
      let path;
      try { path = decodeURIComponent(target.split(/[?#]/)[0]); }
      catch { failures.push(`${page}: invalid URL encoding in ${target}`); continue; }
      if (!path) continue;
      const absolute = resolve(root, dirname(page), path);
      const rel = relative(root, absolute);
      if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(absolute)) {
        failures.push(`${page}: missing/outside-repository link ${target}`);
      } else if (statSync(absolute).isDirectory() && !existsSync(resolve(absolute, 'README.md'))) {
        failures.push(`${page}: link to a directory without README.md: ${target}`);
      }
    }
  }

}

const capabilities = JSON.parse(read('scripts/docs/capabilities.json'));
for (const item of capabilities) {
  if (!item.owner || !/^\d{4}-\d{2}-\d{2}$/.test(item.reviewedOn) || !item.validation) {
    failures.push(`Incomplete capability metadata: ${item.name}`);
  }
  if (!['released baseline', 'source only', 'proposal'].includes(item.availability)) {
    failures.push(`Invalid availability: ${item.name}`);
  }
  if (item.availability === 'released baseline' && !/^\d+\.\d+\.\d+$/.test(item.baseline || '')) {
    failures.push(`Missing supported baseline: ${item.name}`);
  }
  if (!pages.includes(item.page)) failures.push(`Capability page is not published: ${item.page}`);
  for (const path of item.sources) if (!existsSync(resolve(root, path))) failures.push(`Missing capability source: ${path}`);
}

const availability = `| Capability | Availability | Supported baseline | Validation recorded | Owner | Reviewed |
| --- | --- | --- | --- | --- | --- |
${capabilities.map(item => `| [${item.name}](${relative('docs/references', item.page).split('\\').join('/')}) | ${item.availability} | ${item.baseline || 'Not a released baseline'} | ${item.validation} | ${item.owner} | ${item.reviewedOn} |`).join('\n')}`;

// Derive the route map from the same maintained skill shipped with the daemon.
// This eliminates a second hand-maintained mapping, not the need for runtime tests.
const skill = read('packages/cli/skills/dkg-node/SKILL.md');
const fullTable = skill.match(/^\| Tool \| Wraps \| Short description \|\n[\s\S]*?(?=\n\s*\n)/m)?.[0];
const table = fullTable?.split('\n').map(row => `|${row.split('|').slice(1, 3).join('|')}|`).join('\n');
if (!table) failures.push('Cannot locate canonical tool/route table in Node Skill');
// Only marked tables are generated; frontmatter and explanatory Markdown stay authored.
function updateTable(path, id, table) {
  if (!table) return;
  if (!existsSync(resolve(root, path))) {
    failures.push(`Missing reference page: ${path}`);
    return;
  }
  const content = read(path);
  const begin = `<!-- BEGIN GENERATED: ${id} -->`;
  const end = `<!-- END GENERATED: ${id} -->`;
  const start = content.indexOf(begin);
  const finish = content.indexOf(end);
  if (start < 0 || finish <= start || content.split(begin).length !== 2 || content.split(end).length !== 2) {
    failures.push(`${path}: expected one ordered pair of ${id} table markers`);
    return;
  }
  const expected = `${content.slice(0, start + begin.length)}\n${table}\n${content.slice(finish)}`;
  if (expected === content) return;
  if (process.argv.includes('--write')) writeFileSync(resolve(root, path), expected);
  else failures.push(`Generated table is stale: ${path}; run node scripts/docs/check.mjs --write`);
}

updateTable('docs/references/availability.md', 'capabilities', availability);
updateTable('docs/references/tool-route-map.md', 'tool-routes', table);

validateLinks();
const quickstart = read('docs/getting-started/quickstart.md');
const inlineFixture = quickstart.match(/```turtle\n([\s\S]*?)```/)?.[1];
if (inlineFixture !== read('examples/docs/atlas.ttl')) failures.push('Quickstart Turtle differs from the executable fixture');

if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Documentation checks passed: ${pages.length} navigation targets, local file links, ${capabilities.length} capability records, generated references, and tutorial fixture.`);
