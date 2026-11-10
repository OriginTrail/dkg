import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeTypeScriptProgramBundle } from '@origintrail-official/dkg-core/typescript-program-bundle';

/** Package reviewed dependency bytes; never install or fetch code at execution time. */
export function createJpbMappedProgramBundle() {
  const library = dirname(fileURLToPath(import.meta.resolve('@noble/hashes/sha2.js')));
  const { name, version } = JSON.parse(readFileSync(join(library, 'package.json'), 'utf8'));
  if (name !== '@noble/hashes' || version !== '2.2.0') throw new Error('The mapped Program requires @noble/hashes 2.2.0.');
  const prefix = 'vendor/noble-hashes-2.2.0/';
  // Complete ESM source closure for the pinned SHA-2 and encoding entry points.
  const files = Object.fromEntries(['sha2.js', '_md.js', '_u64.js', 'utils.js']
    .map(file => [prefix + file, readFileSync(join(library, file), 'utf8')]));
  files[prefix + 'license.json'] = JSON.stringify({ name, version, license: readFileSync(join(library, 'LICENSE'), 'utf8') });
  files['jpb-plca-mapped.ts'] = readFileSync(new URL('./jpb-plca-mapped.ts', import.meta.url), 'utf8');
  return encodeTypeScriptProgramBundle({ entry: 'jpb-plca-mapped.ts', files,
    imports: { '@noble/hashes/sha2.js': prefix + 'sha2.js', '@noble/hashes/utils.js': prefix + 'utils.js' } },
  source => createHash('sha256').update(source).digest('hex'));
}

if (import.meta.main) process.stdout.write(createJpbMappedProgramBundle());
