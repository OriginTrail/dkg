import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const reconciliationRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/reconciliation',
);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

function moduleSpecifiers(source: string): string[] {
  const matches = source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g,
  );
  return [...matches].map(match => match[1] as string);
}

describe('WAL reconciliation architecture boundary', () => {
  it('depends only on local byte/ID/protocol primitives and generic hashing', () => {
    const allowedExternalModules = new Set(['@noble/hashes/blake3.js']);
    const violations: string[] = [];

    for (const path of sourceFiles(reconciliationRoot)) {
      for (const specifier of moduleSpecifiers(readFileSync(path, 'utf8'))) {
        if (specifier.startsWith('.')) {
          const target = resolve(dirname(path), specifier);
          const remainsInsideBoundary = target === reconciliationRoot
            || target.startsWith(reconciliationRoot + sep);
          if (!remainsInsideBoundary) {
            violations.push(`${relative(reconciliationRoot, path)} -> ${specifier}`);
          }
        } else if (!allowedExternalModules.has(specifier)) {
          violations.push(`${relative(reconciliationRoot, path)} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
