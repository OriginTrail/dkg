import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export const _validationIo = {
  existsSync,
  readFileSync,
  readFile,
};

export function checksumPathFor(binaryPath) {
  return `${binaryPath}.sha256`;
}

export function metadataPathFor(binaryPath) {
  return `${binaryPath}.meta.json`;
}

export function parseSha256File(text) {
  const [hash] = text.trim().split(/\s+/);
  if (!hash) throw new Error('Malformed sha256 file');
  return hash.toLowerCase();
}

export function metadataMatchesExpected(actualMetadata, expectedMetadata) {
  if (!expectedMetadata) return true;
  if (!actualMetadata || typeof actualMetadata !== 'object') return false;
  if (expectedMetadata.buildFingerprint) {
    if (actualMetadata.buildFingerprint) return actualMetadata.buildFingerprint === expectedMetadata.buildFingerprint;
    if (expectedMetadata.cliVersion) return actualMetadata.cliVersion === expectedMetadata.cliVersion;
    return false;
  }
  if (expectedMetadata.cliVersion) return actualMetadata.cliVersion === expectedMetadata.cliVersion;
  return true;
}

export async function readMetadataFile(binaryPath) {
  const path = metadataPathFor(binaryPath);
  if (!_validationIo.existsSync(path)) return null;
  try {
    return JSON.parse(await _validationIo.readFile(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function readMetadataFileSync(binaryPath) {
  const path = metadataPathFor(binaryPath);
  if (!_validationIo.existsSync(path)) return null;
  try {
    return JSON.parse(_validationIo.readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function bundledBinaryValidationFailure(binaryPath, expectedMetadata = null) {
  const binaryChecksumPath = checksumPathFor(binaryPath);
  if (!_validationIo.existsSync(binaryPath) || !_validationIo.existsSync(binaryChecksumPath)) {
    return 'checksum';
  }
  try {
    const expectedHash = parseSha256File(await _validationIo.readFile(binaryChecksumPath, 'utf-8'));
    const actualHash = sha256Hex(await _validationIo.readFile(binaryPath));
    if (actualHash !== expectedHash) return 'checksum';
    const metadata = await readMetadataFile(binaryPath);
    return metadataMatchesExpected(metadata, expectedMetadata) ? null : 'metadata';
  } catch {
    return 'checksum';
  }
}

export function bundledBinaryValidationFailureSync(binaryPath, expectedMetadata = null) {
  const binaryChecksumPath = checksumPathFor(binaryPath);
  if (!_validationIo.existsSync(binaryPath) || !_validationIo.existsSync(binaryChecksumPath)) {
    return 'checksum';
  }
  try {
    const expectedHash = parseSha256File(_validationIo.readFileSync(binaryChecksumPath, 'utf-8'));
    const actualHash = sha256Hex(_validationIo.readFileSync(binaryPath));
    if (actualHash !== expectedHash) return 'checksum';
    const metadata = readMetadataFileSync(binaryPath);
    return metadataMatchesExpected(metadata, expectedMetadata) ? null : 'metadata';
  } catch {
    return 'checksum';
  }
}

export async function hasVerifiedBundledBinary(binaryPath, expectedMetadata = null) {
  return (await bundledBinaryValidationFailure(binaryPath, expectedMetadata)) === null;
}

export function hasVerifiedBundledBinarySync(binaryPath, expectedMetadata = null) {
  return bundledBinaryValidationFailureSync(binaryPath, expectedMetadata) === null;
}
