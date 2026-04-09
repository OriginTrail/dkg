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
import type { ExtractionPipeline, ExtractionInput, ExtractionOutput } from '@origintrail-official/dkg-core';

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024; // 50 MB

function resolveMarkItDownBin(): string | null {
  const suffix = platform === 'win32' ? '.exe' : '';
  const binaryName = `markitdown-${platform}-${arch}${suffix}`;
  const binDir = resolve(fileURLToPath(new URL('../../bin', import.meta.url)));
  const candidate = join(binDir, binaryName);
  if (existsSync(candidate)) return candidate;

  // Fallback: check if markitdown is on PATH
  const pathBin = `markitdown${suffix}`;
  try {
    const whichCmd = platform === 'win32' ? 'where' : 'which';
    execFileSync(whichCmd, [pathBin], { encoding: 'utf-8', stdio: 'pipe' });
    return pathBin;
  } catch {
    return null;
  }
}

let cachedBinPath: string | null | undefined;

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
      + 'Install markitdown or place the standalone binary in the node bin/ directory.',
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

  async extract(input: ExtractionInput): Promise<ExtractionOutput> {
    const markdown = await runMarkItDown(input.filePath);

    // Phase 2 (markdown → triples) is handled by the Markdown extraction pipeline
    // which runs separately. This converter only does phase 1: file → Markdown.
    // Return the intermediate with empty triples; the caller chains the MD pipeline.
    return {
      mdIntermediate: markdown,
      triples: [],
      provenance: [],
    };
  }
}
