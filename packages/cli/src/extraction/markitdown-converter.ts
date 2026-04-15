/**
 * MarkItDown converter — file-to-Markdown using the standalone MarkItDown binary.
 *
 * Microsoft MarkItDown (MIT license) converts PDF, DOCX, PPTX, XLSX, CSV, HTML,
 * images, EPUB, XML, and JSON to Markdown. The binary is a PyInstaller-compiled
 * standalone executable shipped with the DKG node.
 *
 * Spec: 05_PROTOCOL_EXTENSIONS.md §6.5.1
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { platform, arch } from 'node:process';
import { fileURLToPath } from 'node:url';
import type { ExtractionPipeline, ExtractionInput, ConverterOutput } from '@origintrail-official/dkg-core';
import {
  bundledMarkItDownBuildFingerprint,
  readCliPackageVersion,
} from './markitdown-bundle-metadata.js';
import { bundledBinaryValidationFailureSync, hasVerifiedBundledBinarySync } from '../../scripts/markitdown-bundle-validation.mjs';

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024; // 50 MB

const CLI_DIR = fileURLToPath(new URL('../../', import.meta.url));

function expectedBundledMetadataForCurrentPackage(): { buildFingerprint?: string; cliVersion?: string } | null {
  const buildFingerprint = bundledMarkItDownBuildFingerprint(CLI_DIR);
  const cliVersion = readCliPackageVersion(CLI_DIR);
  if (buildFingerprint) return { buildFingerprint, ...(cliVersion ? { cliVersion } : {}) };
  if (cliVersion) return { cliVersion };
  return null;
}

function bundledBinaryValidationFailure(candidate: string): 'checksum' | 'metadata' | null {
  return bundledBinaryValidationFailureSync(candidate, expectedBundledMetadataForCurrentPackage());
}

function hasVerifiedBundledBinary(candidate: string): boolean {
  return hasVerifiedBundledBinarySync(candidate, expectedBundledMetadataForCurrentPackage());
}

function resolveMarkItDownBin(): string | null {
  const { existsSync: ioExistsSync, execFileSync: ioExecFileSync, consoleWarn } = _markitdownConverterIo;
  const suffix = platform === 'win32' ? '.exe' : '';
  const binaryName = `markitdown-${platform}-${arch}${suffix}`;
  const binDir = resolve(fileURLToPath(new URL('../../bin', import.meta.url)));
  const candidate = join(binDir, binaryName);
  if (hasVerifiedBundledBinary(candidate)) return candidate;
  if (ioExistsSync(candidate)) {
    const failure = bundledBinaryValidationFailure(candidate);
    if (failure === 'metadata') {
      consoleWarn(
        `Ignoring bundled MarkItDown binary with incompatible metadata sidecar (${candidate}). `
        + 'Rerun the staging flow or remove the stale file to use a bundled converter that matches this package version.',
      );
    } else {
      consoleWarn(
        `Ignoring bundled MarkItDown binary without a valid checksum sidecar (${candidate}). `
        + 'Rerun the staging flow or remove the stale file to use a verified bundled converter.',
      );
    }
  }

  const pathBin = `markitdown${suffix}`;
  try {
    const whichCmd = platform === 'win32' ? 'where' : 'which';
    ioExecFileSync(whichCmd, [pathBin], { encoding: 'utf-8', stdio: 'pipe' });
    return pathBin;
  } catch {
    return null;
  }
}

let cachedBinPath: string | null | undefined;

export const _markitdownConverterIo = {
  existsSync: existsSync as (path: any) => boolean,
  execFileSync: execFileSync as (...args: any[]) => any,
  consoleWarn: console.warn.bind(console) as (...args: any[]) => void,
  resetBinCache: () => { cachedBinPath = undefined; },
};

function getMarkItDownBin(): string | null {
  if (cachedBinPath !== undefined) return cachedBinPath;
  cachedBinPath = resolveMarkItDownBin();
  return cachedBinPath;
}

export function isMarkItDownAvailable(): boolean {
  return getMarkItDownBin() !== null;
}

async function runMarkItDown(filePath: string): Promise<string> {
  const bin = getMarkItDownBin();
  if (!bin) {
    throw new Error(
      'MarkItDown binary not found. Document extraction unavailable. '
      + 'Install markitdown on PATH or stage a verified standalone binary with node ./scripts/bundle-markitdown-binaries.mjs.',
    );
  }

  return new Promise<string>((resolve, reject) => {
    execFile(bin, [filePath], { maxBuffer: MAX_OUTPUT_BYTES }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message;
        reject(new Error(`MarkItDown conversion failed: ${msg}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

export const MARKITDOWN_CONTENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/html',
  'application/epub+zip',
  'application/xml',
  'text/xml',
] as const;

export class MarkItDownConverter implements ExtractionPipeline {
  readonly contentTypes = [...MARKITDOWN_CONTENT_TYPES];

  async extract(input: ExtractionInput): Promise<ConverterOutput> {
    const markdown = await runMarkItDown(input.filePath);
    return { mdIntermediate: markdown };
  }
}
