import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface BlazegraphImageMetadata {
  image: string;
  containerPort: number;
  dataPath: string;
}

interface BlazegraphImageMetadataParser {
  formatBlazegraphImageMetadata(metadata: unknown): string;
  parseBlazegraphImageMetadata(value: unknown, source?: string): BlazegraphImageMetadata;
  readBlazegraphImageMetadata(filePath: string): BlazegraphImageMetadata;
}

const require = createRequire(import.meta.url);
const parserPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../blazegraph-image-metadata.cjs',
);
const metadataPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../blazegraph-image.json');
const parser = require(parserPath) as BlazegraphImageMetadataParser;

describe('Blazegraph image metadata contract', () => {
  it('normalizes the accepted image and port shape', () => {
    expect(
      parser.parseBlazegraphImageMetadata({
        image: '  example/blazegraph@sha256:abc  ',
        containerPort: 8080,
        dataPath: '  /data  ',
      }),
    ).toEqual({
      image: 'example/blazegraph@sha256:abc',
      containerPort: 8080,
      dataPath: '/data',
    });
  });

  it.each([
    null,
    [],
    {},
    { image: '', containerPort: 8080, dataPath: '/data' },
    { image: 'example/blazegraph', containerPort: 0, dataPath: '/data' },
    { image: 'example/blazegraph', containerPort: 65_536, dataPath: '/data' },
    { image: 'example/blazegraph', containerPort: 8080.5, dataPath: '/data' },
    { image: 'example/blazegraph', containerPort: 8080 },
    { image: 'example/blazegraph', containerPort: 8080, dataPath: 'data' },
    { image: 'example/blazegraph', containerPort: 8080, dataPath: '/bad,path' },
  ])('rejects invalid metadata: %j', (metadata) => {
    expect(() => parser.parseBlazegraphImageMetadata(metadata)).toThrow();
  });

  it('emits the same tab-separated output consumed by CI and devnet', () => {
    const metadata = parser.readBlazegraphImageMetadata(metadataPath);
    const result = spawnSync(process.execPath, [parserPath, metadataPath], { encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(parser.formatBlazegraphImageMetadata(metadata));
    expect(result.stdout.trim().split('\t')).toEqual([
      metadata.image,
      String(metadata.containerPort),
      metadata.dataPath,
    ]);
  });
});
