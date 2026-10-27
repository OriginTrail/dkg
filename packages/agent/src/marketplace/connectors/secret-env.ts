/**
 * Upstream API keys live in an operator `KEY=value` file (fork
 * `secretEnvFile` approach). Config holds only the PATH; the value is read at
 * CALL time, so rotating the file needs no restart. Mount refuses a missing
 * file, a group/world-accessible file, or an absent/empty key line. Errors
 * name the file, the key and a line number — never content.
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { MarketplaceConnectorMountError } from './types.js';

export const DEFAULT_SECRET_ENV_KEY = 'OPENAI_API_KEY';
const LINE = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

class SecretEnvParseError extends Error {
  constructor(readonly lineNumber: number) {
    super(`secretEnvFile line ${lineNumber} is not KEY=value`);
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function lookup(file: string, key: string): string | undefined {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  let found: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = LINE.exec(line);
    if (!match) throw new SecretEnvParseError(i + 1);
    if (match[1] === key) found = unquote(match[2]);
  }
  return found;
}

/** Mount-time check (no value is returned or retained). */
export function checkSecretEnvFile(file: string, key: string, label: string): void {
  if (!isAbsolute(file)) {
    throw new MarketplaceConnectorMountError('CONNECTOR_CONFIG', `${label}.secretEnvFile must be an absolute path`);
  }
  let mode: number;
  try {
    mode = statSync(file).mode;
  } catch {
    throw new MarketplaceConnectorMountError('CONNECTOR_SECRET_ABSENT', `${label}.secretEnvFile ${file} does not exist`);
  }
  if (process.platform !== 'win32' && (mode & 0o077) !== 0) {
    throw new MarketplaceConnectorMountError(
      'CONNECTOR_SECRET_PERMS',
      `${label}.secretEnvFile ${file} is group/world accessible (mode ${(mode & 0o777).toString(8)}); chmod 600 it`,
    );
  }
  let value: string | undefined;
  try {
    value = lookup(file, key);
  } catch (error) {
    const detail = error instanceof SecretEnvParseError ? error.message : 'secretEnvFile is unreadable';
    throw new MarketplaceConnectorMountError('CONNECTOR_SECRET_ABSENT', `${label}: ${detail} (${file})`);
  }
  if (!value) {
    throw new MarketplaceConnectorMountError('CONNECTOR_SECRET_ABSENT', `${label}: ${key} is absent or empty in ${file}`);
  }
}

/** Call-time read. Throws a content-free Error when the key cannot be read. */
export function readSecretEnvValue(file: string, key: string): string {
  let value: string | undefined;
  try {
    value = lookup(file, key);
  } catch (error) {
    throw new Error(error instanceof SecretEnvParseError ? error.message : 'secretEnvFile is unreadable');
  }
  if (!value) throw new Error(`${key} is absent or empty in the secretEnvFile`);
  return value;
}
