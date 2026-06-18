import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG_PATH = path.join(ROOT_DIR, 'CHANGELOG.md');

function getUnreleasedSection(changelog) {
  const match = changelog.match(/^## \[Unreleased\]\n([\s\S]*?)(?=^## \[|\z)/m);
  assert.ok(match, 'CHANGELOG.md must include an Unreleased section');
  return match[1];
}

test('Unreleased changelog documents raw ethers TooLowAllowance recovery', () => {
  const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  const unreleased = getUnreleasedSection(changelog);

  assert.match(unreleased, /V10 publish\/update allowance recovery/);
  assert.match(
    unreleased,
    /translates raw ethers custom-error data before `TooLowAllowance` classification/,
  );
  assert.match(unreleased, /force one re-approval and retry/);
});
