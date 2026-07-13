import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const UI_SOURCE = path.join(REPO_ROOT, 'packages/node-ui/src/ui');
const HIGHLIGHTER = path.join(UI_SOURCE, 'components/chat/shikiHighlighter.ts');
const UI_PACKAGE_JSON = path.join(REPO_ROOT, 'packages/node-ui/package.json');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [entryPath] : [];
  });
}

test('Node UI uses a fine-grained Shiki bundle instead of the full registry', () => {
  for (const file of sourceFiles(UI_SOURCE)) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      source,
      /(?:from\s+|import\()(['"])shiki\1/,
      `${path.relative(REPO_ROOT, file)} must not import Shiki's full bundle`,
    );
  }

  const highlighter = fs.readFileSync(HIGHLIGHTER, 'utf8');
  assert.match(highlighter, /from 'shiki\/core'/);
  assert.match(highlighter, /from 'shiki\/engine\/oniguruma'/);
  assert.match(highlighter, /from 'shiki\/langs\//);
  assert.match(highlighter, /from 'shiki\/themes\//);
});

test('Node UI build keeps its V8 heap below the node service memory budget', () => {
  const packageJson = JSON.parse(fs.readFileSync(UI_PACKAGE_JSON, 'utf8'));
  const buildCommand = packageJson.scripts?.['build:ui'];
  assert.equal(typeof buildCommand, 'string');

  const heapLimit = /--max-old-space-size=(\d+)/.exec(buildCommand)?.[1];
  assert.ok(heapLimit, 'build:ui must set an explicit V8 old-space ceiling');
  assert.equal(
    Number(heapLimit),
    896,
    'build:ui must retain the measured safe ceiling for 1.5GiB node services',
  );
});
