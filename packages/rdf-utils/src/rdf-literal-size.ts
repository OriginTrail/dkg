/**
 * The size every DKG node allows one serialized RDF literal term, and the
 * measure it is counted in (`docs/use-dkg/large-content.md`): Java modified
 * UTF-8, the encoding behind Blazegraph's ~64 KB per-string storage limit.
 * Dependency-free here, so the node's write checks (`dkg-core`) and the
 * writers that split long text below the limit (the OKF mapper) measure a
 * literal the same way.
 */

/** The largest serialized RDF literal term a node accepts, quotes, escapes and suffix included, in Java modified UTF-8 bytes. */
export const DKG_RDF_LITERAL_SAFE_MUTF8_BYTES = 60_000;

/**
 * Java Modified UTF-8 byte length using Java's UTF-16 code-unit rules.
 *
 * This intentionally differs from standard UTF-8:
 * - U+0000 is 2 bytes.
 * - U+0001 through U+007F are 1 byte.
 * - U+0080 through U+07FF are 2 bytes.
 * - All other UTF-16 code units, including surrogate halves, are 3 bytes.
 */
export function javaModifiedUtf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0) {
      bytes += 2;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x07ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
