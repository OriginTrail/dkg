/** RFC 8785 / I-JSON value accepted by the Track-2 control-object codec. */
export type CanonicalJsonPrimitive = null | boolean | number | string;

export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export interface CanonicalJsonOptions {
  /** Hard input-byte ceiling. Callers should normally pass their object-type cap. */
  maxBytes?: number;
  /** Defensive nesting ceiling independent of JavaScript call-stack limits. */
  maxDepth?: number;
}

export type StrictJsonParseOptions = CanonicalJsonOptions;

export const MAX_CANONICAL_JSON_BYTES = 8 * 1024 * 1024;
export const MAX_CANONICAL_JSON_DEPTH = 64;
const UTF8 = new TextEncoder();
// Preserve a leading BOM so the explicit wire-level rejection below can see it.
const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

/**
 * Serialize one already parsed JSON value using RFC 8785 JCS.
 *
 * JavaScript's JSON number/string primitive serialization matches JCS; object keys
 * are sorted by UTF-16 code units as required by RFC 8785 section 3.2.3. This
 * implementation rejects values outside the I-JSON data model instead of silently
 * dropping or coercing them like JSON.stringify does.
 */
export function canonicalizeJson(
  value: CanonicalJsonValue,
  options: CanonicalJsonOptions = {},
): string {
  const { maxBytes, maxDepth } = resolveLimits(options);
  const ancestors = new Set<object>();
  const writer = new BoundedJsonWriter(maxBytes);

  const encode = (input: unknown, depth: number): void => {
    if (depth > maxDepth) {
      throw new CanonicalJsonError(`JSON nesting exceeds ${maxDepth}`);
    }

    if (input === null) {
      writer.appendAscii('null');
      return;
    }

    switch (typeof input) {
      case 'boolean':
        writer.appendAscii(input ? 'true' : 'false');
        return;
      case 'number': {
        if (!Number.isFinite(input)) {
          throw new CanonicalJsonError('JCS numbers must be finite IEEE-754 values');
        }
        writer.appendAscii(JSON.stringify(input));
        return;
      }
      case 'string': {
        writeCanonicalJsonString(input, writer, 'JSON string');
        return;
      }
      case 'object':
        break;
      default:
        throw new CanonicalJsonError(`Unsupported JSON value type: ${typeof input}`);
    }

    const object = input as object;
    // Container depth is counted when entering the container, including when it
    // is empty. This mirrors StrictJsonParser instead of relying on a recursive
    // child visit to discover an over-limit empty object or array.
    if (depth + 1 > maxDepth) {
      throw new CanonicalJsonError(`JSON nesting exceeds ${maxDepth}`);
    }
    if (ancestors.has(object)) {
      throw new CanonicalJsonError('Cyclic values are not JSON');
    }
    ancestors.add(object);

    try {
      if (Array.isArray(input)) {
        assertJsonArrayShape(input);
        writer.appendAscii('[');
        for (let index = 0; index < input.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(input, index)) {
            throw new CanonicalJsonError('Sparse arrays are not accepted');
          }
          if (index !== 0) writer.appendAscii(',');
          encode(input[index], depth + 1);
        }
        writer.appendAscii(']');
        return;
      }

      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new CanonicalJsonError('Only plain JSON objects are accepted');
      }

      const record = input as Record<string, unknown>;
      assertJsonObjectShape(record);
      const keys = Object.keys(record).sort();
      writer.appendAscii('{');
      for (let index = 0; index < keys.length; index += 1) {
        if (index !== 0) writer.appendAscii(',');
        const key = keys[index];
        writeCanonicalJsonString(key, writer, 'JSON object key');
        writer.appendAscii(':');
        encode(record[key], depth + 1);
      }
      writer.appendAscii('}');
    } finally {
      ancestors.delete(object);
    }
  };

  encode(value, 0);
  return writer.finish();
}

export function canonicalizeJsonBytes(
  value: CanonicalJsonValue,
  options: CanonicalJsonOptions = {},
): Uint8Array {
  return UTF8.encode(canonicalizeJson(value, options));
}

/** Parse JSON while rejecting duplicate decoded keys, invalid UTF-8, and non-I-JSON values. */
export function parseJsonStrict(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): CanonicalJsonValue {
  const { maxBytes, maxDepth } = resolveLimits(options);

  const byteLength = typeof input === 'string' ? UTF8.encode(input).byteLength : input.byteLength;
  if (byteLength > maxBytes) {
    throw new CanonicalJsonError(`JSON input exceeds ${maxBytes} bytes`);
  }

  let text: string;
  try {
    text = typeof input === 'string' ? input : UTF8_FATAL.decode(input);
  } catch {
    throw new CanonicalJsonError('JSON input is not valid UTF-8');
  }
  if (text.charCodeAt(0) === 0xfeff) {
    throw new CanonicalJsonError('A UTF-8 BOM is not accepted');
  }

  const parser = new StrictJsonParser(text, maxDepth);
  return parser.parse();
}

/** Parse one wire object and require that its bytes already equal RFC 8785 JCS. */
export function parseCanonicalJson(
  input: string | Uint8Array,
  options: StrictJsonParseOptions = {},
): CanonicalJsonValue {
  const value = parseJsonStrict(input, options);
  const text = typeof input === 'string' ? input : UTF8_FATAL.decode(input);
  if (canonicalizeJson(value, options) !== text) {
    throw new CanonicalJsonError('JSON bytes are valid but not RFC 8785 canonical');
  }
  return value;
}

function resolveLimits(options: CanonicalJsonOptions): {
  maxBytes: number;
  maxDepth: number;
} {
  const maxBytes = options.maxBytes ?? MAX_CANONICAL_JSON_BYTES;
  const maxDepth = options.maxDepth ?? MAX_CANONICAL_JSON_DEPTH;
  if (
    !Number.isSafeInteger(maxBytes)
    || maxBytes <= 0
    || maxBytes > MAX_CANONICAL_JSON_BYTES
  ) {
    throw new CanonicalJsonError(
      `maxBytes must be a positive safe integer no greater than ${MAX_CANONICAL_JSON_BYTES}`,
    );
  }
  if (
    !Number.isSafeInteger(maxDepth)
    || maxDepth < 0
    || maxDepth > MAX_CANONICAL_JSON_DEPTH
  ) {
    throw new CanonicalJsonError(
      `maxDepth must be a non-negative safe integer no greater than ${MAX_CANONICAL_JSON_DEPTH}`,
    );
  }
  return { maxBytes, maxDepth };
}

/**
 * Bounded text sink used by the serializer. It coalesces small punctuation/number
 * writes so a near-limit array does not allocate one JavaScript string per token.
 */
class BoundedJsonWriter {
  private readonly chunks: string[] = [];
  private pending = '';
  private byteLength = 0;

  constructor(private readonly maxBytes: number) {}

  appendAscii(value: string): void {
    this.appendMeasured(value, value.length);
  }

  appendUtf8(value: string): void {
    this.appendMeasured(value, UTF8.encode(value).byteLength);
  }

  finish(): string {
    if (this.pending.length > 0) {
      this.chunks.push(this.pending);
      this.pending = '';
    }
    return this.chunks.join('');
  }

  private appendMeasured(value: string, bytes: number): void {
    if (this.byteLength + bytes > this.maxBytes) {
      throw new CanonicalJsonError(`Canonical JSON exceeds ${this.maxBytes} bytes`);
    }
    this.byteLength += bytes;
    this.pending += value;
    if (this.pending.length >= 8192) {
      this.chunks.push(this.pending);
      this.pending = '';
    }
  }
}

/** Write one JCS string without first allocating an unbounded JSON.stringify result. */
function writeCanonicalJsonString(
  value: string,
  writer: BoundedJsonWriter,
  label: string,
): void {
  writer.appendAscii('"');
  let rawStart = 0;
  let index = 0;

  const flushRaw = (end: number): void => {
    // Keep TextEncoder allocations bounded even when the source string is enormous.
    if (end > rawStart) writer.appendUtf8(value.slice(rawStart, end));
    rawStart = end;
  };

  while (index < value.length) {
    const unit = value.charCodeAt(index);
    let escaped: string | undefined;
    if (unit === 0x22) escaped = '\\"';
    else if (unit === 0x5c) escaped = '\\\\';
    else if (unit === 0x08) escaped = '\\b';
    else if (unit === 0x09) escaped = '\\t';
    else if (unit === 0x0a) escaped = '\\n';
    else if (unit === 0x0c) escaped = '\\f';
    else if (unit === 0x0d) escaped = '\\r';
    else if (unit < 0x20) escaped = `\\u${unit.toString(16).padStart(4, '0')}`;

    if (escaped !== undefined) {
      flushRaw(index);
      writer.appendAscii(escaped);
      index += 1;
      rawStart = index;
      continue;
    }

    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalJsonError(`${label} contains an unpaired high surrogate`);
      }
      index += 2;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CanonicalJsonError(`${label} contains an unpaired low surrogate`);
    } else {
      index += 1;
    }

    if (index - rawStart >= 4096) flushRaw(index);
  }

  flushRaw(value.length);
  writer.appendAscii('"');
}

function assertUnicodeScalarString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalJsonError(`${label} contains an unpaired high surrogate`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CanonicalJsonError(`${label} contains an unpaired low surrogate`);
    }
  }
}

class StrictJsonParser {
  private index = 0;

  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
  ) {}

  parse(): CanonicalJsonValue {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail('Unexpected trailing input');
    return value;
  }

  private parseValue(depth: number): CanonicalJsonValue {
    if (depth > this.maxDepth) this.fail(`JSON nesting exceeds ${this.maxDepth}`);
    const char = this.text[this.index];
    if (char === '"') return this.parseString();
    if (char === '{') return this.parseObject(depth + 1);
    if (char === '[') return this.parseArray(depth + 1);
    if (char === 't') return this.parseLiteral('true', true);
    if (char === 'f') return this.parseLiteral('false', false);
    if (char === 'n') return this.parseLiteral('null', null);
    if (char === '-' || (char >= '0' && char <= '9')) return this.parseNumber();
    this.fail('Expected a JSON value');
  }

  private parseObject(depth: number): CanonicalJsonValue {
    if (depth > this.maxDepth) this.fail(`JSON nesting exceeds ${this.maxDepth}`);
    this.index += 1;
    this.skipWhitespace();
    const result: Record<string, CanonicalJsonValue> = Object.create(null) as Record<
      string,
      CanonicalJsonValue
    >;
    const seen = new Set<string>();
    if (this.consume('}')) return result;

    while (true) {
      if (this.text[this.index] !== '"') this.fail('Expected an object key');
      const key = this.parseString();
      if (seen.has(key)) this.fail(`Duplicate object key ${JSON.stringify(key)}`);
      seen.add(key);
      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      result[key] = this.parseValue(depth);
      this.skipWhitespace();
      if (this.consume('}')) return result;
      this.expect(',');
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): CanonicalJsonValue {
    if (depth > this.maxDepth) this.fail(`JSON nesting exceeds ${this.maxDepth}`);
    this.index += 1;
    this.skipWhitespace();
    const result: CanonicalJsonValue[] = [];
    if (this.consume(']')) return result;

    while (true) {
      result.push(this.parseValue(depth));
      this.skipWhitespace();
      if (this.consume(']')) return result;
      this.expect(',');
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.text.length) {
      const code = this.text.charCodeAt(this.index);
      if (!escaped && code === 0x22) {
        this.index += 1;
        const token = this.text.slice(start, this.index);
        let value: string;
        try {
          value = JSON.parse(token) as string;
        } catch {
          this.fail('Invalid JSON string escape');
        }
        assertUnicodeScalarString(value, 'JSON string');
        return value;
      }
      if (!escaped && code < 0x20) this.fail('Unescaped control character in string');
      if (!escaped && code === 0x5c) {
        escaped = true;
      } else {
        escaped = false;
      }
      this.index += 1;
    }
    this.fail('Unterminated JSON string');
  }

  private parseNumber(): number {
    const start = this.index;

    if (this.text[this.index] === '-') this.index += 1;

    if (this.text[this.index] === '0') {
      this.index += 1;
    } else if (isDigitOneToNine(this.text[this.index])) {
      this.index += 1;
      while (isDigit(this.text[this.index])) this.index += 1;
    } else {
      this.fail('Invalid JSON number');
    }

    if (this.text[this.index] === '.') {
      this.index += 1;
      if (!isDigit(this.text[this.index])) this.fail('Invalid JSON number');
      while (isDigit(this.text[this.index])) this.index += 1;
    }

    if (this.text[this.index] === 'e' || this.text[this.index] === 'E') {
      this.index += 1;
      if (this.text[this.index] === '+' || this.text[this.index] === '-') {
        this.index += 1;
      }
      if (!isDigit(this.text[this.index])) this.fail('Invalid JSON number');
      while (isDigit(this.text[this.index])) this.index += 1;
    }

    const token = this.text.slice(start, this.index);
    const value = Number(token);
    if (!Number.isFinite(value)) this.fail('JSON number is outside finite IEEE-754 range');

    // A strict parse must not silently replace the supplied decimal value with
    // another finite double. Compare the exact decimal value with the JCS/JSON
    // rendering of the parsed double. This still accepts equivalent spellings
    // such as 1.0 and 1e0, while rejecting unsafe integers, underflow, and
    // non-canonical decimals that round to a different mathematical value.
    if (!sameExactDecimalValue(token, JSON.stringify(value))) {
      this.fail('JSON number loses information when converted to IEEE-754');
    }
    return value;
  }

  private parseLiteral<T extends CanonicalJsonPrimitive>(token: string, value: T): T {
    if (!this.text.startsWith(token, this.index)) this.fail(`Expected ${token}`);
    this.index += token.length;
    return value;
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length) {
      const char = this.text.charCodeAt(this.index);
      if (char !== 0x20 && char !== 0x09 && char !== 0x0a && char !== 0x0d) return;
      this.index += 1;
    }
  }

  private consume(expected: string): boolean {
    if (this.text[this.index] !== expected) return false;
    this.index += 1;
    return true;
  }

  private expect(expected: string): void {
    if (!this.consume(expected)) this.fail(`Expected ${JSON.stringify(expected)}`);
  }

  private fail(message: string): never {
    throw new CanonicalJsonError(`${message} at character ${this.index}`);
  }
}

interface NormalizedDecimal {
  readonly negative: boolean;
  readonly digits: string;
  readonly exponent: number;
}

function sameExactDecimalValue(left: string, right: string): boolean {
  const normalizedLeft = normalizeDecimalToken(left);
  const normalizedRight = normalizeDecimalToken(right);
  return normalizedLeft !== null
    && normalizedRight !== null
    && normalizedLeft.negative === normalizedRight.negative
    && normalizedLeft.digits === normalizedRight.digits
    && normalizedLeft.exponent === normalizedRight.exponent;
}

/** Normalize one already-tokenized JSON decimal as digits * 10^exponent. */
function normalizeDecimalToken(token: string): NormalizedDecimal | null {
  const match = /^(-)?([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
  if (match === null) return null;

  const integerDigits = match[2];
  const fractionDigits = match[3] ?? '';
  let digits = integerDigits + fractionDigits;

  let firstNonZero = 0;
  while (firstNonZero < digits.length && digits.charCodeAt(firstNonZero) === 0x30) {
    firstNonZero += 1;
  }
  if (firstNonZero === digits.length) {
    // All textual zero spellings, including -0 and large zero exponents,
    // preserve the JSON numeric value zero.
    return { negative: false, digits: '0', exponent: 0 };
  }
  digits = digits.slice(firstNonZero);

  const explicitExponent = parseBoundedDecimalExponent(match[4]);
  if (explicitExponent === null) return null;
  let exponent = explicitExponent - fractionDigits.length;

  let end = digits.length;
  while (end > 1 && digits.charCodeAt(end - 1) === 0x30) {
    end -= 1;
    exponent += 1;
  }

  return {
    negative: match[1] === '-',
    digits: digits.slice(0, end),
    exponent,
  };
}

function parseBoundedDecimalExponent(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  let index = 0;
  let sign = 1;
  if (raw[index] === '+' || raw[index] === '-') {
    if (raw[index] === '-') sign = -1;
    index += 1;
  }
  while (raw.charCodeAt(index) === 0x30) index += 1;
  const significant = raw.slice(index);
  if (significant.length === 0) return 0;

  // With an 8 MiB input ceiling, a finite nonzero token can need at most a
  // seven-digit exponent to offset its coefficient length. A longer value
  // cannot be made exact by the bounded fraction and is rejected without
  // constructing an attacker-sized BigInt.
  if (significant.length > 15) return null;
  const magnitude = Number(significant);
  if (!Number.isSafeInteger(magnitude)) return null;
  return sign * magnitude;
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '0' && value <= '9';
}

function isDigitOneToNine(value: string | undefined): boolean {
  return value !== undefined && value >= '1' && value <= '9';
}

function assertJsonObjectShape(record: Record<string, unknown>): void {
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string') {
      throw new CanonicalJsonError('JSON objects must not contain symbol properties');
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable) {
      throw new CanonicalJsonError('JSON objects must not contain non-enumerable properties');
    }
    if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new CanonicalJsonError('JSON objects must not contain accessor properties');
    }
  }
}

function assertJsonArrayShape(array: readonly unknown[]): void {
  for (const key of Reflect.ownKeys(array)) {
    if (typeof key !== 'string') {
      throw new CanonicalJsonError('JSON arrays must not contain symbol properties');
    }
    if (key === 'length') continue;
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || String(index) !== key || index >= array.length) {
      throw new CanonicalJsonError('JSON arrays must not contain non-index properties');
    }
    const descriptor = Object.getOwnPropertyDescriptor(array, key);
    if (
      !descriptor?.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new CanonicalJsonError(
        'JSON arrays must contain only enumerable data elements',
      );
    }
  }
}
