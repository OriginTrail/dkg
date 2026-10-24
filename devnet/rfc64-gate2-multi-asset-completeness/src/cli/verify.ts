import { closeSync, openSync, readSync } from 'node:fs';

import {
  MAX_CANONICAL_DOCUMENT_BYTES,
  canonicalDocument,
} from '../canonical.ts';
import { verify } from '../verify.ts';

const READ_CHUNK_BYTES = 64 * 1024;

// Usage: node src/cli/verify.ts <raw.json> (or omit the path to read stdin).
// Input is byte-bounded before JSON parsing and must itself be exact JCS+LF.
function main(argv: readonly string[]): void {
  let text: string;
  try {
    text = readBoundedUtf8(argv[2]);
  } catch (cause) {
    process.stderr.write(`cannot read bounded raw evidence: ${String(cause)}\n`);
    process.exit(2);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
    if (canonicalDocument(parsed as never) !== text) parsed = undefined;
  } catch {
    parsed = undefined;
  }
  const verdict = verify(parsed);
  process.stdout.write(canonicalDocument(verdict));
  process.exit(verdict.fixtureComplete ? 0 : 1);
}

function readBoundedUtf8(path: string | undefined): string {
  const fd = path === undefined ? 0 : openSync(path, 'r');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const read = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (read === 0) break;
      total += read;
      if (total > MAX_CANONICAL_DOCUMENT_BYTES) throw new RangeError('raw evidence byte ceiling exceeded');
      chunks.push(chunk.subarray(0, read));
    }
  } finally {
    if (path !== undefined) closeSync(fd);
  }
  const bytes = Buffer.concat(chunks, total);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

main(process.argv);
