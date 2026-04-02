import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { parseRdf } from '../src/rdf-parser.js';
import { batchEntityQuads } from '../src/batching.js';
import { serializeQuadsToNQuads } from '../../publisher/src/nquads.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FINDINGS_FILE = join(__dirname, '..', '..', '..', 'tmp', 'findings.synthetic.nt');

describe.skipIf(!existsSync(FINDINGS_FILE))('synthetic findings workspace serialization regression', () => {
  it('serializes every staged workspace batch for the synthetic findings file without parser errors', async () => {
    const raw = readFileSync(FINDINGS_FILE, 'utf-8');
    const quads = await parseRdf(raw, 'ntriples', 'did:dkg:paranet:music-social');

    const batches = batchEntityQuads(quads, {
      maxBatchQuads: 500,
      maxBatchBytes: 450 * 1024,
      estimateBatchBytes: (batch) => new TextEncoder().encode(JSON.stringify({ paranetId: 'music-social', quads: batch })).length,
      splitOversizedEntities: true,
    });

    expect(batches.length).toBeGreaterThan(1);

    const parser = new Parser({ format: 'N-Quads' });
    for (const [index, batch] of batches.entries()) {
      const nquads = await serializeQuadsToNQuads(batch);
      expect(() => parser.parse(nquads)).not.toThrow();
      if ((index + 1) % 100 === 0) {
        console.log(`Validated batch ${index + 1}/${batches.length}`);
      }
    }
  }, 300000);
});
