import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync as nativeReadFileSync, existsSync as nativeExistsSync } from 'node:fs';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  MarkItDownConverter,
  isMarkItDownAvailable,
  MARKITDOWN_CONTENT_TYPES,
  _markitdownConverterIo,
} from '../src/extraction/markitdown-converter.js';
import { _validationIo } from '../scripts/markitdown-bundle-validation.mjs';

const CLI_VERSION = JSON.parse(nativeReadFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string };
const BUILD_INFO = JSON.parse(nativeReadFileSync(new URL('../markitdown-build-info.json', import.meta.url), 'utf-8')) as {
  markItDownUpstreamVersion: string;
  pyInstallerVersion: string;
};
const BUNDLER_SCRIPT_BYTES = nativeReadFileSync(new URL('../scripts/bundle-markitdown-binaries.mjs', import.meta.url));
const MARKITDOWN_UPSTREAM_VERSION = BUILD_INFO.markItDownUpstreamVersion;
const PYINSTALLER_VERSION = BUILD_INFO.pyInstallerVersion;
if (!MARKITDOWN_UPSTREAM_VERSION || !PYINSTALLER_VERSION) {
  throw new Error('Unable to read MarkItDown build versions from markitdown-build-info.json');
}
const MARKITDOWN_BUILD_FINGERPRINT = createHash('sha256').update([
  MARKITDOWN_UPSTREAM_VERSION,
  PYINSTALLER_VERSION,
  createHash('sha256').update(nativeReadFileSync(new URL('../scripts/markitdown-entry.py', import.meta.url))).digest('hex'),
  createHash('sha256').update(BUNDLER_SCRIPT_BYTES).digest('hex'),
].join('\n')).digest('hex');

const origConverterIo = { ..._markitdownConverterIo };
const origValidationIo = { ..._validationIo };

function restoreIo() {
  Object.assign(_markitdownConverterIo, origConverterIo);
  Object.assign(_validationIo, origValidationIo);
}

describe('MARKITDOWN_CONTENT_TYPES', () => {
  it('includes PDF', () => {
    expect(MARKITDOWN_CONTENT_TYPES).toContain('application/pdf');
  });

  it('includes DOCX', () => {
    expect(MARKITDOWN_CONTENT_TYPES).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('includes PPTX', () => {
    expect(MARKITDOWN_CONTENT_TYPES).toContain(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
  });

  it('includes XLSX', () => {
    expect(MARKITDOWN_CONTENT_TYPES).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('includes CSV and HTML', () => {
    expect(MARKITDOWN_CONTENT_TYPES).toContain('text/csv');
    expect(MARKITDOWN_CONTENT_TYPES).toContain('text/html');
  });
});

describe('MarkItDownConverter', () => {
  afterEach(() => {
    restoreIo();
  });

  it('exposes all supported content types', () => {
    const converter = new MarkItDownConverter();
    expect(converter.contentTypes).toContain('application/pdf');
    expect(converter.contentTypes).toContain('text/csv');
    expect(converter.contentTypes.length).toBeGreaterThanOrEqual(6);
  });

  it('extract returns ConverterOutput with mdIntermediate only (phase 1)', async () => {
    const converter = new MarkItDownConverter();

    const available = isMarkItDownAvailable();
    if (!available) {
      await expect(converter.extract({
        filePath: '/tmp/nonexistent.pdf',
        contentType: 'application/pdf',
        agentDid: 'did:dkg:agent:0xAbc',
      })).rejects.toThrow(/MarkItDown binary not found/);
      return;
    }

    const tmpDir = await mkdtemp(join(tmpdir(), 'markitdown-test-'));
    const testFile = join(tmpDir, 'test.html');
    await writeFile(testFile, '<html><body><h1>Hello</h1><p>World</p></body></html>');

    try {
      const result = await converter.extract({
        filePath: testFile,
        contentType: 'text/html',
        agentDid: 'did:dkg:agent:0xTest',
      });

      expect(typeof result.mdIntermediate).toBe('string');
      expect(result.mdIntermediate.length).toBeGreaterThan(0);
      expect((result as { triples?: unknown }).triples).toBeUndefined();
      expect((result as { sourceFileLinkage?: unknown }).sourceFileLinkage).toBeUndefined();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('isMarkItDownAvailable', () => {
  beforeEach(() => {
    _markitdownConverterIo.resetBinCache();
  });

  afterEach(() => {
    restoreIo();
    _markitdownConverterIo.resetBinCache();
  });

  it('returns a boolean', () => {
    const result = isMarkItDownAvailable();
    expect(typeof result).toBe('boolean');
  });

  it('ignores a bundled binary when the checksum sidecar is missing', () => {
    const warnCalls: string[] = [];
    _markitdownConverterIo.consoleWarn = (...args: any[]) => { warnCalls.push(args.map(String).join(' ')); };

    _validationIo.existsSync = (path: unknown) => {
      const normalized = String(path).replace(/\\/g, '/');
      if (normalized.includes('/bin/markitdown-') && normalized.endsWith('.sha256')) return false;
      if (normalized.includes('/bin/markitdown-')) return true;
      return nativeExistsSync(path as any);
    };
    _markitdownConverterIo.existsSync = _validationIo.existsSync as any;

    _markitdownConverterIo.execFileSync = (() => { throw new Error('not on path'); }) as any;

    expect(isMarkItDownAvailable()).toBe(false);
    expect(warnCalls.some(m => m.includes('Ignoring bundled MarkItDown binary without a valid checksum sidecar'))).toBe(true);
  });

  it('ignores a bundled binary when the metadata sidecar targets a different package version', () => {
    const warnCalls: string[] = [];
    _markitdownConverterIo.consoleWarn = (...args: any[]) => { warnCalls.push(args.map(String).join(' ')); };

    const binaryBytes = Buffer.from('verified markitdown binary', 'utf-8');
    const binaryHash = createHash('sha256').update(binaryBytes).digest('hex');

    _validationIo.existsSync = (path: unknown) => {
      const normalized = String(path).replace(/\\/g, '/');
      if (normalized.includes('/bin/markitdown-')) return true;
      return nativeExistsSync(path as any);
    };
    _markitdownConverterIo.existsSync = _validationIo.existsSync as any;

    _validationIo.readFileSync = ((path: unknown, ...rest: any[]) => {
      const normalized = String(path).replace(/\\/g, '/');
      if (normalized.includes('/bin/markitdown-') && normalized.endsWith('.sha256')) {
        const assetName = normalized.split('/').pop()?.replace(/\.sha256$/, '') ?? 'markitdown-test';
        return `${binaryHash}  ${assetName}\n`;
      }
      if (normalized.includes('/bin/markitdown-') && normalized.endsWith('.meta.json')) {
        return JSON.stringify({ source: 'release', cliVersion: '0.0.0-test' });
      }
      if (normalized.includes('/bin/markitdown-')) return binaryBytes;
      return nativeReadFileSync(path as any, ...rest);
    }) as any;

    _markitdownConverterIo.execFileSync = (() => { throw new Error('not on path'); }) as any;

    expect(isMarkItDownAvailable()).toBe(false);
    expect(warnCalls.some(m => m.includes('Ignoring bundled MarkItDown binary with incompatible metadata sidecar'))).toBe(true);
  });

  it('accepts a bundled binary when the checksum and release metadata match', () => {
    const binaryBytes = Buffer.from('verified markitdown binary', 'utf-8');
    const binaryHash = createHash('sha256').update(binaryBytes).digest('hex');

    _validationIo.existsSync = (path: unknown) => {
      const normalized = String(path).replace(/\\/g, '/');
      if (normalized.includes('/bin/markitdown-')) return true;
      return nativeExistsSync(path as any);
    };
    _markitdownConverterIo.existsSync = _validationIo.existsSync as any;

    _validationIo.readFileSync = ((path: unknown, ...rest: any[]) => {
      const normalized = String(path).replace(/\\/g, '/');
      if (normalized.includes('/bin/markitdown-') && normalized.endsWith('.sha256')) {
        const assetName = normalized.split('/').pop()?.replace(/\.sha256$/, '') ?? 'markitdown-test';
        return `${binaryHash}  ${assetName}\n`;
      }
      if (normalized.includes('/bin/markitdown-') && normalized.endsWith('.meta.json')) {
        return JSON.stringify({
          source: 'release',
          cliVersion: CLI_VERSION.version,
          buildFingerprint: MARKITDOWN_BUILD_FINGERPRINT,
        });
      }
      if (normalized.includes('/bin/markitdown-')) return binaryBytes;
      return nativeReadFileSync(path as any, ...rest);
    }) as any;

    _markitdownConverterIo.execFileSync = (() => { throw new Error('path fallback should not be used'); }) as any;

    expect(isMarkItDownAvailable()).toBe(true);
  });

  it('accepts a bundled binary when the build fingerprint matches across CLI version changes', () => {
    const binaryBytes = Buffer.from('verified markitdown binary', 'utf-8');
    const binaryHash = createHash('sha256').update(binaryBytes).digest('hex');

    _validationIo.existsSync = (path: unknown) => {
      const normalized = String(path).replace(/\\/g, '/');
      if (normalized.includes('/bin/markitdown-')) return true;
      return nativeExistsSync(path as any);
    };
    _markitdownConverterIo.existsSync = _validationIo.existsSync as any;

    _validationIo.readFileSync = ((path: unknown, ...rest: any[]) => {
      const normalized = String(path).replace(/\\/g, '/');
      if (normalized.includes('/bin/markitdown-') && normalized.endsWith('.sha256')) {
        const assetName = normalized.split('/').pop()?.replace(/\.sha256$/, '') ?? 'markitdown-test';
        return `${binaryHash}  ${assetName}\n`;
      }
      if (normalized.includes('/bin/markitdown-') && normalized.endsWith('.meta.json')) {
        return JSON.stringify({
          source: 'release',
          cliVersion: '0.0.0-test',
          buildFingerprint: MARKITDOWN_BUILD_FINGERPRINT,
        });
      }
      if (normalized.includes('/bin/markitdown-')) return binaryBytes;
      return nativeReadFileSync(path as any, ...rest);
    }) as any;

    _markitdownConverterIo.execFileSync = (() => { throw new Error('path fallback should not be used'); }) as any;

    expect(isMarkItDownAvailable()).toBe(true);
  });

  it('accepts a bundled binary when the checksum and build metadata match the current package', () => {
    const binaryBytes = Buffer.from('verified markitdown build binary', 'utf-8');
    const binaryHash = createHash('sha256').update(binaryBytes).digest('hex');

    _validationIo.existsSync = (path: unknown) => {
      const normalized = String(path).replace(/\\/g, '/');
      if (normalized.includes('/bin/markitdown-')) return true;
      return nativeExistsSync(path as any);
    };
    _markitdownConverterIo.existsSync = _validationIo.existsSync as any;

    _validationIo.readFileSync = ((path: unknown, ...rest: any[]) => {
      const normalized = String(path).replace(/\\/g, '/');
      if (normalized.includes('/bin/markitdown-') && normalized.endsWith('.sha256')) {
        const assetName = normalized.split('/').pop()?.replace(/\.sha256$/, '') ?? 'markitdown-test';
        return `${binaryHash}  ${assetName}\n`;
      }
      if (normalized.includes('/bin/markitdown-') && normalized.endsWith('.meta.json')) {
        return JSON.stringify({
          source: 'build',
          cliVersion: CLI_VERSION.version,
          buildFingerprint: MARKITDOWN_BUILD_FINGERPRINT,
        });
      }
      if (normalized.includes('/bin/markitdown-')) return binaryBytes;
      return nativeReadFileSync(path as any, ...rest);
    }) as any;

    _markitdownConverterIo.execFileSync = (() => { throw new Error('path fallback should not be used'); }) as any;

    expect(isMarkItDownAvailable()).toBe(true);
  });
});
