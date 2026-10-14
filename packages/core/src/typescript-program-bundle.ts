/** Immutable source packaging. This module has no host or package-loader access. */
export const TYPESCRIPT_PROGRAM_BUNDLE_FORMAT = 'dkg.typescript-source-bundle.v1';
export const TYPESCRIPT_PROGRAM_SOURCE_BYTES = 262144;
export const TYPESCRIPT_PROGRAM_BUNDLE_FILES = 64;
export const TYPESCRIPT_PROGRAM_GUEST_API = '@origintrail-official/dkg-graph-computer/program';

export interface TypeScriptProgramBundle {
  format: typeof TYPESCRIPT_PROGRAM_BUNDLE_FORMAT;
  entry: string;
  files: Record<string, { sha256: string; source: string }>;
  imports: Record<string, string>;
}
export interface TypeScriptProgramBundleInput {
  entry: string;
  files: Record<string, string>;
  imports?: Record<string, string>;
}
export type ProgramSourceHasher = (source: string) => string;

function fail(reason: string): never { throw new TypeError(`INVALID_TYPESCRIPT_PROGRAM_BUNDLE: ${reason}`); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const bytes = (value: string) => new TextEncoder().encode(value).length;
const exactKeys = (value: Record<string, unknown>, allowed: string[]) => {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key))) fail('fields');
};
export function isTypeScriptProgramFile(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 256
    && /^[A-Za-z0-9@_][A-Za-z0-9@_./-]*\.(?:[cm]?js|[cm]?ts|json)$/.test(path)
    && path.split('/').every(part => !!part && part !== '.' && part !== '..');
}
const specifier = (name: string) => name.length <= 256
  && /^(?:@[A-Za-z0-9_-]+\/)?[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(name)
  && name.split('/').every(part => !!part && part !== '.' && part !== '..')
  && name !== TYPESCRIPT_PROGRAM_GUEST_API;

function validate(value: unknown, hash: ProgramSourceHasher): TypeScriptProgramBundle {
  if (!record(value)) fail('object');
  exactKeys(value, ['format', 'entry', 'files', 'imports']);
  if (value.format !== TYPESCRIPT_PROGRAM_BUNDLE_FORMAT) fail('format');
  if (!isTypeScriptProgramFile(value.entry) || value.entry.endsWith('.json')) fail('entry');
  if (!record(value.files) || !record(value.imports)) fail('files/imports');
  const sourceFiles = value.files, sourceImports = value.imports;
  const paths = Object.keys(sourceFiles);
  if (!paths.length || paths.length > TYPESCRIPT_PROGRAM_BUNDLE_FILES || !Object.hasOwn(sourceFiles, value.entry)) fail('file count/entry');
  const files = Object.fromEntries(paths.sort().map(path => {
    if (!isTypeScriptProgramFile(path)) fail('file path');
    const file = sourceFiles[path];
    if (!record(file)) fail('file');
    exactKeys(file, ['sha256', 'source']);
    if (typeof file.source !== 'string' || bytes(file.source) > TYPESCRIPT_PROGRAM_SOURCE_BYTES
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
      || hash(file.source) !== file.sha256) fail('file checksum');
    return [path, { sha256: file.sha256, source: file.source }];
  }));
  const aliases = Object.keys(sourceImports);
  if (aliases.length > TYPESCRIPT_PROGRAM_BUNDLE_FILES) fail('import count');
  const imports = Object.fromEntries(aliases.sort().map(name => {
    const path = sourceImports[name];
    if (!specifier(name) || typeof path !== 'string' || !Object.hasOwn(files, path)) fail('import target');
    return [name, path];
  }));
  return { entry: value.entry, files, format: TYPESCRIPT_PROGRAM_BUNDLE_FORMAT, imports };
}

/** Ordinary single-file Programs retain their original representation and hash. */
export function parseTypeScriptProgramBundle(source: string, hash: ProgramSourceHasher): TypeScriptProgramBundle | null {
  if (typeof source !== 'string' || bytes(source) > TYPESCRIPT_PROGRAM_SOURCE_BYTES) fail('source size');
  if (!source.trimStart().startsWith('{')) return null;
  let value: unknown;
  try { value = JSON.parse(source); } catch { return null; }
  if (!record(value) || !Object.hasOwn(value, 'format')) return null;
  return validate(value, hash);
}

/** The serialized source itself commits to every byte, path, and import mapping. */
export function encodeTypeScriptProgramBundle(input: TypeScriptProgramBundleInput, hash: ProgramSourceHasher): string {
  if (!record(input) || !record(input.files) || (input.imports !== undefined && !record(input.imports))) fail('input');
  if (Object.keys(input.files).length > TYPESCRIPT_PROGRAM_BUNDLE_FILES
    || Object.keys(input.imports ?? {}).length > TYPESCRIPT_PROGRAM_BUNDLE_FILES) fail('file/import count');
  let size = 0;
  const files = Object.fromEntries(Object.entries(input.files).map(([path, source]) => {
    if (typeof source !== 'string' || (size += bytes(source)) > TYPESCRIPT_PROGRAM_SOURCE_BYTES) fail('source size');
    return [path, { sha256: hash(source), source }];
  }));
  const value = validate({ entry: input.entry, files, format: TYPESCRIPT_PROGRAM_BUNDLE_FORMAT, imports: input.imports ?? {} }, hash);
  const source = JSON.stringify(value);
  if (bytes(source) > TYPESCRIPT_PROGRAM_SOURCE_BYTES) fail('source size');
  return source;
}
