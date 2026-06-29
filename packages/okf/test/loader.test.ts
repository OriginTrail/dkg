import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBundleDir, loadBundleDirWithReport } from '../src/index.js';

describe('loadBundleDir does not follow symlinks (no local-file exfiltration)', () => {
  let dir: string;
  let secret: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'okf-loader-'));
    secret = join(dir, 'secret-outside.txt');
    writeFileSync(secret, 'SECRET-TOKEN-CONTENTS');
    mkdirSync(join(dir, 'bundle'));
    writeFileSync(join(dir, 'bundle', 'ok.md'), '---\ntype: T\ntitle: ok\n---\nbody\n');
    // A bundle could ship a symlink whose target is a sensitive local file.
    symlinkSync(secret, join(dir, 'bundle', 'leak.md'));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('skips symlinked .md entries instead of slurping their target', () => {
    const files = loadBundleDir(join(dir, 'bundle'));
    expect(files.map((f) => f.path)).toEqual(['ok.md']);
    expect(JSON.stringify(files)).not.toContain('SECRET-TOKEN-CONTENTS');
  });

  it('reports skipped symlinks for callers that want to warn', () => {
    const { files, skippedSymlinks } = loadBundleDirWithReport(join(dir, 'bundle'));
    expect(files.map((f) => f.path)).toEqual(['ok.md']);
    expect(skippedSymlinks).toEqual(['leak.md']);
  });
});
