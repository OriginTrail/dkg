// Builds the dashboard into dist/: the indexer bundled into one file, because the
// machine it runs on has no checkout, with the server, the page and the units. It
// can also make one standalone HTML file with a data.json embedded, a snapshot to
// share.
//
//   node build.mjs
//   node build.mjs --snapshot <data.json path or URL> [--out snapshot.html]

import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const repoRoot = resolve(here, '../../../../../..');

function loadEsbuild() {
  try {
    return createRequire(join(repoRoot, 'package.json'))('esbuild');
  } catch {
    /* not a direct dependency at the root: look in the store */
  }
  const pnpm = join(repoRoot, 'node_modules/.pnpm');
  const versions = existsSync(pnpm) ? readdirSync(pnpm).filter((d) => d.startsWith('esbuild@')).sort().reverse() : [];
  for (const v of versions) {
    try {
      return createRequire(join(pnpm, v, 'node_modules/esbuild/package.json'))(join(pnpm, v, 'node_modules/esbuild'));
    } catch {
      /* try the next */
    }
  }
  throw new Error(`esbuild not found under ${pnpm}`);
}

async function build() {
  mkdirSync(dist, { recursive: true });
  const esbuild = loadEsbuild();
  await esbuild.build({
    entryPoints: [join(here, 'indexer.mjs')],
    outfile: join(dist, 'indexer.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
    loader: { '.json': 'json' },
  });
  copyFileSync(join(here, 'server.mjs'), join(dist, 'server.mjs'));
  copyFileSync(join(here, 'index.html'), join(dist, 'index.html'));
  console.log(`built ${dist}`);
}

/** The page with `data` embedded: nothing to fetch, and no way for the JSON to end its own script tag. */
function embed(html, dataJson) {
  const safe = dataJson
    .replaceAll('<', '\\u003c')
    .replaceAll(String.fromCharCode(0x2028), '\\u2028')
    .replaceAll(String.fromCharCode(0x2029), '\\u2029');
  const tag = `<script id="snapshot" type="application/json">${safe}</script>`;
  if (!html.includes('<!--SNAPSHOT-->')) throw new Error('index.html has no snapshot marker');
  return html.replace('<!--SNAPSHOT-->', () => tag);
}

async function snapshot(from, out) {
  const text = /^https?:/.test(from) ? await (await fetch(from)).text() : readFileSync(from, 'utf8');
  const generated = JSON.parse(text).generatedAt;
  const html = embed(readFileSync(join(here, 'index.html'), 'utf8'), text);
  const name = out ?? join(dist, `marketplace-snapshot-${new Date(generated * 1000).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.html`);
  mkdirSync(dirname(name), { recursive: true });
  writeFileSync(name, html);
  console.log(`snapshot written to ${name} (${Math.round(html.length / 1024)} KiB)`);
}

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes('--snapshot')) await snapshot(flag('--snapshot'), flag('--out'));
else await build();
