import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('reconciliation module boundary', () => {
  it('contains no RDF, SPARQL, network, transport, or object-payload dependencies', () => {
    const files = execFileSync('rg', ['--files', 'src/reconciliation'], {
      cwd: packageRoot,
      encoding: 'utf8'
    }).trim().split('\n');
    const forbidden = /(?:rdf|sparql|oxigraph|triplestore|socket|http|libp2p|iroh|WalObjectV1|WalObjectStore|IbltProfileId|SymbolId|PayloadId|BlobId|payloadBytes|content[-_ ]addressed[-_ ](?:symbol|cache|range|chunk))/i;
    const violations: string[] = [];
    for (const file of files) {
      const contents = readFileSync(resolve(packageRoot, file), 'utf8');
      if (forbidden.test(contents)) violations.push(relative(packageRoot, resolve(packageRoot, file)));
    }
    expect(violations).toEqual([]);
  });
});
