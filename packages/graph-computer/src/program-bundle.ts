import { encodeTypeScriptProgramBundle, parseTypeScriptProgramBundle, type TypeScriptProgramBundleInput } from '@origintrail-official/dkg-core/typescript-program-bundle';
import { sha256 } from './signing.js';

export type { TypeScriptProgramBundle, TypeScriptProgramBundleInput } from '@origintrail-official/dkg-core/typescript-program-bundle';

/** Package supplied sources only: no package installation, resolution, or I/O. */
export function createTypeScriptProgramBundle(input: TypeScriptProgramBundleInput): string {
  return encodeTypeScriptProgramBundle(input, sha256);
}
export function readTypeScriptProgramBundle(source: string) {
  return parseTypeScriptProgramBundle(source, sha256);
}
export function updateTypeScriptProgramBundleFile(source: string, path: string, content: string): string {
  const bundle = readTypeScriptProgramBundle(source);
  if (!bundle || !Object.hasOwn(bundle.files, path)) throw new TypeError('Unknown bundled Program file');
  return createTypeScriptProgramBundle({ entry: bundle.entry, imports: bundle.imports,
    files: Object.fromEntries(Object.entries(bundle.files).map(([name, file]) => [name, name === path ? content : file.source])) });
}
