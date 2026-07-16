/**
 * Minimal `multipart/form-data` parser (RFC 7578 / RFC 2046).
 *
 * Handles the subset needed by the import-file upload endpoint:
 * - A single file part with `Content-Disposition: form-data; name="file"; filename="..."`
 *   and an optional `Content-Type` header. The part body is captured as raw bytes.
 * - Zero or more text parts with `Content-Disposition: form-data; name="..."` and a
 *   utf-8 string body.
 *
 * Deliberate non-features (out of scope for V10.0):
 * - Nested multipart bodies (`multipart/mixed` inside a part)
 * - `Content-Transfer-Encoding: base64` / `quoted-printable` (browsers don't send these)
 * - Streaming — we parse a fully-buffered `Buffer`, which is the shape daemon.ts
 *   already has from `readBody`
 * - Charset negotiation on text parts — everything non-file is treated as utf-8
 *
 * Throws `MultipartParseError` on malformed input so the route handler can
 * return a clean 400 to the caller.
 */

export class MultipartParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultipartParseError';
  }
}

export interface MultipartField {
  /** `name` attribute from the `Content-Disposition` header. */
  name: string;
  /** `filename` attribute, if the part is a file upload. Undefined for text parts. */
  filename?: string;
  /** `Content-Type` header of the part, or undefined if not provided. */
  contentType?: string;
  /** Raw part body as bytes. For text parts, caller can decode via `.toString('utf-8')`. */
  content: Buffer;
}

/**
 * Extract the boundary token from a `Content-Type: multipart/form-data; boundary=...` header.
 * Returns null if the header is missing, malformed, ambiguous, or not multipart/form-data.
 *
 * Accepts the full `IncomingHttpHeaders['content-type']` shape (`string | string[] | undefined`)
 * so that callers can pass `req.headers['content-type']` directly. Array values — which Node
 * can deliver when a client sends duplicated Content-Type headers — are rejected as ambiguous
 * rather than coerced, so the route handler returns a clean 400 instead of crashing inside
 * `.toLowerCase()`.
 */
export function parseBoundary(contentTypeHeader: string | string[] | undefined): string | null {
  if (contentTypeHeader === undefined) return null;
  if (Array.isArray(contentTypeHeader)) return null;
  const lower = contentTypeHeader.toLowerCase();
  if (!lower.startsWith('multipart/form-data')) return null;
  const match = contentTypeHeader.match(/boundary\s*=\s*(?:"([^"]+)"|([^\s;]+))/i);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

/**
 * Parse a fully-buffered `multipart/form-data` body into its constituent fields.
 * `boundary` is the boundary token (without the leading `--`).
 */
export function parseMultipart(body: Buffer, boundary: string): MultipartField[] {
  if (!boundary || boundary.length === 0) {
    throw new MultipartParseError('Empty boundary');
  }
  const delimiter = Buffer.from(`--${boundary}`);
  const encapsulatedDelimiter = Buffer.from(`\r\n--${boundary}`);
  const crlf = Buffer.from('\r\n');
  const doubleCrlf = Buffer.from('\r\n\r\n');

  // Find first delimiter. Spec allows CRLF or just the delimiter at the start.
  let cursor = body.indexOf(delimiter);
  if (cursor < 0) {
    throw new MultipartParseError('Missing opening boundary');
  }

  const fields: MultipartField[] = [];
  const maxIterations = 1000;
  let iterations = 0;

  while (cursor < body.length) {
    if (++iterations > maxIterations) {
      throw new MultipartParseError('Too many parts (>1000)');
    }
    // Move past the boundary delimiter
    cursor += delimiter.length;
    // Check for closing `--` (final boundary)
    if (cursor + 2 <= body.length && body[cursor] === 0x2d && body[cursor + 1] === 0x2d) {
      return fields;
    }
    // Skip trailing CRLF after delimiter
    if (cursor + 2 <= body.length && body[cursor] === 0x0d && body[cursor + 1] === 0x0a) {
      cursor += 2;
    } else {
      throw new MultipartParseError('Malformed boundary: expected CRLF after delimiter');
    }
    // Find end-of-headers (\r\n\r\n)
    const headerEnd = body.indexOf(doubleCrlf, cursor);
    if (headerEnd < 0) {
      throw new MultipartParseError('Malformed part: no header terminator');
    }
    const headerBytes = body.subarray(cursor, headerEnd);
    const headers = parseHeaders(headerBytes);
    const contentStart = headerEnd + doubleCrlf.length;

    // Find the next real multipart boundary. Per RFC 2046, encapsulated boundaries
    // must start on a new line, so raw `--${boundary}` bytes inside the payload do
    // not count unless they are preceded by CRLF.
    const nextBoundary = findNextBoundary(body, encapsulatedDelimiter, contentStart);
    if (nextBoundary < 0) {
      throw new MultipartParseError('Malformed part: no closing boundary');
    }
    const nextDelimiter = nextBoundary + crlf.length;
    // Part body ends at the CRLF that introduces the next boundary.
    const contentEnd = nextBoundary;
    const content = body.subarray(contentStart, contentEnd);

    const disposition = headers.get('content-disposition');
    if (!disposition) {
      throw new MultipartParseError('Malformed part: missing Content-Disposition');
    }
    // Anchor parameter matches to a real `;` boundary (or start of string) so
    // `name=` doesn't accidentally match the `name=` substring inside `filename=`,
    // and vice versa. Without this, a part with only `filename="x"` (no `name`)
    // would be silently mis-routed as `name="x"`.
    const nameMatch = disposition.match(/(?:^|;)\s*name\s*=\s*(?:"([^"]*)"|([^;]+))/i);
    if (!nameMatch) {
      throw new MultipartParseError('Malformed part: Content-Disposition without name');
    }
    const filenameMatch = disposition.match(/(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]+))/i);
    fields.push({
      name: (nameMatch[1] ?? nameMatch[2] ?? '').trim(),
      filename: filenameMatch ? (filenameMatch[1] ?? filenameMatch[2] ?? '').trim() : undefined,
      contentType: headers.get('content-type'),
      content: Buffer.from(content),
    });

    cursor = nextDelimiter;
  }

  throw new MultipartParseError('Unexpected end of body');
}

function findNextBoundary(body: Buffer, encapsulatedDelimiter: Buffer, start: number): number {
  let candidate = body.indexOf(encapsulatedDelimiter, start);
  while (candidate >= 0) {
    const boundaryEnd = candidate + encapsulatedDelimiter.length;
    const nextFirstByte = body[boundaryEnd];
    const nextSecondByte = body[boundaryEnd + 1];
    const isBoundaryTerminator =
      (nextFirstByte === 0x0d && nextSecondByte === 0x0a)
      || (nextFirstByte === 0x2d && nextSecondByte === 0x2d);
    if (isBoundaryTerminator) {
      return candidate;
    }
    candidate = body.indexOf(encapsulatedDelimiter, candidate + 1);
  }
  return -1;
}

/**
 * Parse a raw header block (CRLF-delimited) into a lower-cased key → value map.
 * Multi-line folded headers are not supported (RFC 7578 §5.3 says field names
 * in multipart/form-data must use the simpler RFC 2183 header format).
 */
function parseHeaders(block: Buffer): Map<string, string> {
  const headers = new Map<string, string>();
  const text = block.toString('utf-8');
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const name = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    headers.set(name, value);
  }
  return headers;
}
