import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface BlazegraphImageMetadata {
  image: string;
  containerPort: number;
  dataPath: string;
}

interface BlazegraphRuntimeContract {
  BLAZEGRAPH_NAMESPACE_XML_TEMPLATE: string;
  formatBlazegraphImageMetadata(metadata: unknown): string;
  parseBlazegraphImageMetadata(value: unknown, source?: string): BlazegraphImageMetadata;
  readBlazegraphImageMetadata(filePath: string): BlazegraphImageMetadata;
  renderBlazegraphNamespaceXml(namespace: string): string;
}

const require = createRequire(import.meta.url);
const parserPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../blazegraph-image-metadata.cjs',
);
const metadataPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../blazegraph-image.json');
const contract = require(parserPath) as BlazegraphRuntimeContract;

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [parserPath, ...args], { encoding: 'utf8' });
}

describe('Blazegraph image metadata contract', () => {
  it('normalizes the accepted image and port shape', () => {
    expect(
      contract.parseBlazegraphImageMetadata({
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
    { image: 'example/blazegraph', containerPort: 8080, dataPath: '/bad path' },
    { image: 'example/blazegraph', containerPort: 8080, dataPath: '/bad\tpath' },
    { image: 'example/blazegraph', containerPort: 8080, dataPath: '/bad\npath' },
  ])('rejects invalid metadata: %j', (metadata) => {
    expect(() => contract.parseBlazegraphImageMetadata(metadata)).toThrow();
  });

  it('rejects line-breaking data paths through the CLI field contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'dkg-blazegraph-metadata-'));
    const invalidMetadataPath = join(root, 'blazegraph-image.json');
    writeFileSync(
      invalidMetadataPath,
      JSON.stringify({
        image: 'example/blazegraph',
        containerPort: 8080,
        dataPath: '/data\ncorrupted-field=value',
      }),
    );
    const result = spawnSync(process.execPath, [parserPath, invalidMetadataPath, 'dataPath'], {
      encoding: 'utf8',
    });
    rmSync(root, { recursive: true, force: true });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('without commas or whitespace');
  });

  it('prints every field as self-describing key=value lines by default', () => {
    const metadata = contract.readBlazegraphImageMetadata(metadataPath);
    const result = runCli(metadataPath);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(contract.formatBlazegraphImageMetadata(metadata));
    expect(result.stdout.trim().split('\n').sort()).toEqual([
      `containerPort=${metadata.containerPort}`,
      `dataPath=${metadata.dataPath}`,
      `image=${metadata.image}`,
    ]);
  });

  it('prints requested fields by name, one value per line', () => {
    const metadata = contract.readBlazegraphImageMetadata(metadataPath);

    const single = runCli(metadataPath, 'image');
    expect(single.status, single.stderr).toBe(0);
    expect(single.stdout.trim()).toBe(metadata.image);

    const multiple = runCli(metadataPath, 'dataPath', 'containerPort');
    expect(multiple.status, multiple.stderr).toBe(0);
    expect(multiple.stdout.trim().split('\n')).toEqual([
      metadata.dataPath,
      String(metadata.containerPort),
    ]);
  });

  it('fails on an unknown field name', () => {
    const result = runCli(metadataPath, 'image', 'journalPath');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('journalPath');
    expect(result.stderr).toContain('image, containerPort, dataPath');
  });

  it('validates the whole contract before serving any single field', () => {
    const result = spawnSync(
      process.execPath,
      [parserPath, '/nonexistent/blazegraph-image.json', 'image'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('prints usage and exits 2 without a metadata file', () => {
    const result = runCli();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage');
  });
});

describe('Blazegraph namespace XML rendering', () => {
  it('runs from a clean source checkout without an installed workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'dkg-blazegraph-buildless-cli-'));
    const cleanCliDir = join(root, 'packages', 'cli');
    const cleanStorageDir = join(root, 'packages', 'storage');
    mkdirSync(cleanCliDir, { recursive: true });
    mkdirSync(cleanStorageDir, { recursive: true });
    copyFileSync(parserPath, join(cleanCliDir, 'blazegraph-image-metadata.cjs'));
    copyFileSync(
      resolve(dirname(parserPath), '../storage/blazegraph-namespace-contract.cjs'),
      join(cleanStorageDir, 'blazegraph-namespace-contract.cjs'),
    );
    const result = spawnSync(
      process.execPath,
      [join(cleanCliDir, 'blazegraph-image-metadata.cjs'), '--namespace-xml', 'clean-checkout'],
      { encoding: 'utf8' },
    );
    rmSync(root, { recursive: true, force: true });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      '<entry key="com.bigdata.rdf.sail.namespace">clean-checkout</entry>',
    );
  });

  it('renders the canonical template with the namespace substituted', () => {
    expect(contract.renderBlazegraphNamespaceXml('mynode')).toBe(
      contract.BLAZEGRAPH_NAMESPACE_XML_TEMPLATE.replace('{namespace}', 'mynode'),
    );
  });

  it('serves the rendered XML over the CLI for shell consumers', () => {
    const result = runCli('--namespace-xml', 'dkg-ci-persistence-contract');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      contract.renderBlazegraphNamespaceXml('dkg-ci-persistence-contract'),
    );
    expect(result.stdout).toContain(
      '<entry key="com.bigdata.rdf.sail.namespace">dkg-ci-persistence-contract</entry>',
    );
  });

  it.each([
    '', // empty
    'has space',
    'quote"break',
    '<entry>', // XML injection
    'a'.repeat(129), // over the length cap
    '.', // URL dot segment
    '..', // URL dot segment
  ])('rejects namespaces outside the conservative charset: %j', (namespace) => {
    expect(() => contract.renderBlazegraphNamespaceXml(namespace)).toThrow(/must match/);
    const result = runCli('--namespace-xml', namespace);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('prints usage and exits 2 when --namespace-xml lacks its argument', () => {
    const result = runCli('--namespace-xml');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage');
  });
});
