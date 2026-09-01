const UTF8 = new TextEncoder();

/**
 * Percent-encode one identifier component that its owning protocol has already
 * validated and normalized. Validation and error classification deliberately
 * remain at those protocol boundaries.
 */
export function encodeCanonicalIriComponentV1(value: string): string {
  const bytes = UTF8.encode(value);
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
