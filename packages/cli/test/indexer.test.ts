import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { indexRepository } from '../src/indexer.js';

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf-8');
}

describe('indexRepository', () => {
  let repoRoot = '';

  beforeEach(async () => {
    repoRoot = await mkdtemp(join(tmpdir(), 'dkg-indexer-test-'));

    await write(
      join(repoRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - "packages/*"\n',
    );

    await write(
      join(repoRoot, 'packages/app/package.json'),
      JSON.stringify({
        name: '@acme/app',
        version: '1.0.0',
      }, null, 2),
    );

    await write(
      join(repoRoot, 'packages/app/src/main.ts'),
      [
        'export function hello(name: string): string {',
        '  return `hello ${name}`;',
        '}',
        '',
      ].join('\n'),
    );

    await write(
      join(repoRoot, 'packages/app/src/util.js'),
      [
        'import "./main.js";',
        'export function add(a, b) {',
        '  return a + b;',
        '}',
        '',
      ].join('\n'),
    );

    await write(
      join(repoRoot, 'packages/app/src/tool.py'),
      [
        'class Worker(BaseWorker):',
        '    pass',
        '',
        'def process(item: str) -> str:',
        '    return item',
        '',
      ].join('\n'),
    );

    await write(
      join(repoRoot, 'packages/app/contracts/Test.sol'),
      [
        'pragma solidity ^0.8.0;',
        'contract Test {',
        '  event Done();',
        '  function run(uint256 x) public returns (uint256) {',
        '    emit Done();',
        '    return x;',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    await write(
      join(repoRoot, 'docs/guide.md'),
      '# Guide\nSee [Spec](./spec.md)\n',
    );
  });

  afterEach(async () => {
    if (repoRoot) {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('indexes TS/JS/Python/Solidity from workspace packages', async () => {
    const result = await indexRepository(repoRoot);

    expect(result.packageCount).toBe(1);
    expect(result.moduleCount).toBe(4);
    expect(result.functionCount).toBeGreaterThanOrEqual(3);
    expect(result.classCount).toBeGreaterThanOrEqual(1);
    expect(result.contractCount).toBe(1);

    const hasPythonClass = result.quads.some(
      q => q.predicate.endsWith('#name') && q.object.includes('"Worker"'),
    );
    expect(hasPythonClass).toBe(true);
  });

  it('indexes non-code content when includeContent is enabled', async () => {
    const withoutContent = await indexRepository(repoRoot, { includeContent: false });
    const withContent = await indexRepository(repoRoot, { includeContent: true });

    expect(withContent.moduleCount).toBeGreaterThan(withoutContent.moduleCount);
    expect(withContent.quads.length).toBeGreaterThan(withoutContent.quads.length);

    const hasDocumentType = withContent.quads.some(
      q => q.object === 'https://ontology.dkg.io/devgraph#Document',
    );
    expect(hasDocumentType).toBe(true);

    const hasGuideTitle = withContent.quads.some(
      q => q.predicate.endsWith('#title') && q.object.includes('"Guide"'),
    );
    expect(hasGuideTitle).toBe(true);
  });
});

