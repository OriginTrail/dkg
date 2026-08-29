const UTF8 = new TextEncoder();

/**
 * Percent-encode one already-canonical NFC UTF-8 identifier component.
 *
 * The caller supplies the protocol-specific byte ceiling. The encoder is kept
 * neutral so catalog, semantic-address, and later RFC-64 record codecs cannot
 * acquire a dependency on one another merely to share an IRI primitive.
 */
export function iriComponentV1(value: string, maxBytes = 256): string {
  const identifier = assertNfcUtf8Identifier(value, 'IRI component', maxBytes);
  const bytes = UTF8.encode(identifier);
  let encoded = '';
  for (const byte of bytes) {
    if (isUnescapedIriComponentByte(byte)) {
      encoded += String.fromCharCode(byte);
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return encoded;
}

function assertNfcUtf8Identifier(
  value: unknown,
  label: string,
  maxBytes: number,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.length > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  assertWellFormedUnicode(value, label);
  if (value.normalize('NFC') !== value) {
    throw new Error(`${label} must already be NFC-normalized`);
  }
  if (UTF8.encode(value).byteLength > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`${label} contains an unpaired UTF-16 surrogate`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error(`${label} contains an unpaired UTF-16 surrogate`);
    }
  }
}

function isUnescapedIriComponentByte(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a)
    || (byte >= 0x61 && byte <= 0x7a)
    || (byte >= 0x30 && byte <= 0x39)
    || byte === 0x2d
    || byte === 0x2e
    || byte === 0x5f
    || byte === 0x7e
  );
}
