export interface SparqlLogicalCodePoint {
  readonly codePoint: number;
  /** Number of UTF-16 code units occupied in the unprocessed source. */
  readonly rawWidth: number;
}

function isAsciiHexCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x30 && codePoint <= 0x39)
    || (codePoint >= 0x41 && codePoint <= 0x46)
    || (codePoint >= 0x61 && codePoint <= 0x66);
}

function isUnicodeScalarValue(codePoint: number): boolean {
  return codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
}

/**
 * Read one character after SPARQL UCHAR preprocessing while retaining its raw
 * UTF-16 width. A malformed `\\u`/`\\U` prefix is rejected instead of being
 * reinterpreted as ordinary name characters.
 */
export function readSparqlLogicalCodePoint(
  source: string,
  index: number,
): SparqlLogicalCodePoint | null {
  if (index < 0 || index >= source.length) return null;
  const first = source.charCodeAt(index);
  if (first !== 0x5c) {
    const codePoint = source.codePointAt(index);
    if (codePoint === undefined || !isUnicodeScalarValue(codePoint)) return null;
    return { codePoint, rawWidth: codePoint > 0xffff ? 2 : 1 };
  }

  const marker = source[index + 1];
  if (marker !== 'u' && marker !== 'U') {
    return { codePoint: first, rawWidth: 1 };
  }
  const digits = marker === 'u' ? 4 : 8;
  const end = index + 2 + digits;
  if (end > source.length) return null;
  let codePoint = 0;
  for (let cursor = index + 2; cursor < end; cursor++) {
    const digit = source.charCodeAt(cursor);
    if (!isAsciiHexCodePoint(digit)) return null;
    codePoint = (codePoint * 16) + Number.parseInt(source[cursor], 16);
  }
  if (!isUnicodeScalarValue(codePoint)) return null;
  return { codePoint, rawWidth: 2 + digits };
}

export function isSparqlPnCharsBaseCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x41 && codePoint <= 0x5a)
    || (codePoint >= 0x61 && codePoint <= 0x7a)
    || (codePoint >= 0x00c0 && codePoint <= 0x00d6)
    || (codePoint >= 0x00d8 && codePoint <= 0x00f6)
    || (codePoint >= 0x00f8 && codePoint <= 0x02ff)
    || (codePoint >= 0x0370 && codePoint <= 0x037d)
    || (codePoint >= 0x037f && codePoint <= 0x1fff)
    || (codePoint >= 0x200c && codePoint <= 0x200d)
    || (codePoint >= 0x2070 && codePoint <= 0x218f)
    || (codePoint >= 0x2c00 && codePoint <= 0x2fef)
    || (codePoint >= 0x3001 && codePoint <= 0xd7ff)
    || (codePoint >= 0xf900 && codePoint <= 0xfdcf)
    || (codePoint >= 0xfdf0 && codePoint <= 0xfffd)
    || (codePoint >= 0x10000 && codePoint <= 0xeffff);
}

export function isSparqlPnCharsUCodePoint(codePoint: number): boolean {
  return codePoint === 0x5f || isSparqlPnCharsBaseCodePoint(codePoint);
}

export function isSparqlPnCharsCodePoint(codePoint: number): boolean {
  return isSparqlPnCharsUCodePoint(codePoint)
    || codePoint === 0x2d
    || (codePoint >= 0x30 && codePoint <= 0x39)
    || codePoint === 0x00b7
    || (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x203f && codePoint <= 0x2040);
}

function logicalWidthWhen(
  source: string,
  index: number,
  predicate: (codePoint: number) => boolean,
): number {
  const logical = readSparqlLogicalCodePoint(source, index);
  return logical && predicate(logical.codePoint) ? logical.rawWidth : 0;
}

export function sparqlPnCharsBaseWidth(source: string, index: number): number {
  return logicalWidthWhen(source, index, isSparqlPnCharsBaseCodePoint);
}

export function sparqlPnCharsUWidth(source: string, index: number): number {
  return logicalWidthWhen(source, index, isSparqlPnCharsUCodePoint);
}

export function sparqlPnCharsWidth(source: string, index: number): number {
  return logicalWidthWhen(source, index, isSparqlPnCharsCodePoint);
}

export function sparqlAsciiDigitWidth(source: string, index: number): number {
  return logicalWidthWhen(
    source,
    index,
    (codePoint) => codePoint >= 0x30 && codePoint <= 0x39,
  );
}

function isSparqlVariableInitialCodePoint(codePoint: number): boolean {
  return isSparqlPnCharsUCodePoint(codePoint)
    || (codePoint >= 0x30 && codePoint <= 0x39);
}

function isSparqlVariableContinuationCodePoint(codePoint: number): boolean {
  return isSparqlPnCharsUCodePoint(codePoint)
    || (codePoint >= 0x30 && codePoint <= 0x39)
    || codePoint === 0x00b7
    || (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x203f && codePoint <= 0x2040);
}

export function sparqlVariableInitialWidth(source: string, index: number): number {
  return logicalWidthWhen(source, index, isSparqlVariableInitialCodePoint);
}

export function sparqlVariableContinuationWidth(source: string, index: number): number {
  return logicalWidthWhen(source, index, isSparqlVariableContinuationCodePoint);
}

export function readSparqlVariableEnd(source: string, start: number): number | null {
  const sigil = readSparqlLogicalCodePoint(source, start);
  if (!sigil || (sigil.codePoint !== 0x3f && sigil.codePoint !== 0x24)) return null;
  let end = start + sigil.rawWidth;
  const initialWidth = sparqlVariableInitialWidth(source, end);
  if (!initialWidth) return null;
  end += initialWidth;
  let width = sparqlVariableContinuationWidth(source, end);
  while (width) {
    end += width;
    width = sparqlVariableContinuationWidth(source, end);
  }
  return end;
}

/** Read a SPARQL variable using logical code points but return its raw spelling. */
export function readSparqlVariable(source: string, start: number): string | null {
  const end = readSparqlVariableEnd(source, start);
  return end === null ? null : source.slice(start, end);
}

function logicalCodePointAt(source: string, index: number, expected: number): number {
  const logical = readSparqlLogicalCodePoint(source, index);
  return logical?.codePoint === expected ? logical.rawWidth : 0;
}

export interface SparqlStringLiteralScan {
  readonly end: number;
  readonly closed: boolean;
  readonly malformedUchar: boolean;
}

/** Scan one short or long string without promoting UCHAR payload to syntax. */
export function scanSparqlStringLiteral(
  source: string,
  start: number,
): SparqlStringLiteralScan | null {
  const opening = readSparqlLogicalCodePoint(source, start);
  if (!opening || (opening.codePoint !== 0x22 && opening.codePoint !== 0x27)) return null;
  const quote = opening.codePoint;
  const encodedDelimiter = opening.rawWidth > 1;
  const delimiterWidthAt = (index: number): number => {
    if (encodedDelimiter) return logicalCodePointAt(source, index, quote);
    const codePoint = source.codePointAt(index);
    return codePoint === quote ? (codePoint > 0xffff ? 2 : 1) : 0;
  };
  let index = start + opening.rawWidth;
  const secondWidth = delimiterWidthAt(index);
  const thirdWidth = secondWidth
    ? delimiterWidthAt(index + secondWidth)
    : 0;
  const triple = secondWidth > 0 && thirdWidth > 0;
  if (triple) index += secondWidth + thirdWidth;
  let malformedUchar = false;

  while (index < source.length) {
    if (!encodedDelimiter && source.charCodeAt(index) === 0x5c) {
      if (source[index + 1] === 'u' || source[index + 1] === 'U') {
        const uchar = readSparqlLogicalCodePoint(source, index);
        if (!uchar) malformedUchar = true;
        index += uchar?.rawWidth ?? 1;
        continue;
      }
      const escapedCodePoint = source.codePointAt(index + 1);
      index += 1 + (escapedCodePoint !== undefined && escapedCodePoint > 0xffff ? 2 : 1);
      continue;
    }

    const logical = readSparqlLogicalCodePoint(source, index);
    if (!logical) {
      malformedUchar = true;
      index++;
      continue;
    }

    // ECHAR is interpreted after UCHAR preprocessing, so an escaped U+005C
    // can still protect the following logical quote.
    if (logical.codePoint === 0x5c) {
      const escaped = readSparqlLogicalCodePoint(source, index + logical.rawWidth);
      index += logical.rawWidth + (escaped?.rawWidth ?? 0);
      continue;
    }
    const delimiterWidth = delimiterWidthAt(index);
    if (!delimiterWidth) {
      index += logical.rawWidth;
      continue;
    }
    if (!triple) {
      return { end: index + delimiterWidth, closed: true, malformedUchar };
    }

    const nextIndex = index + delimiterWidth;
    const nextWidth = delimiterWidthAt(nextIndex);
    const finalWidth = nextWidth
      ? delimiterWidthAt(nextIndex + nextWidth)
      : 0;
    if (nextWidth && finalWidth) {
      return {
        end: nextIndex + nextWidth + finalWidth,
        closed: true,
        malformedUchar,
      };
    }
    index += logical.rawWidth;
  }
  return { end: source.length, closed: false, malformedUchar };
}

/** Return the end offset of a string literal, or the unchanged start offset. */
export function skipSparqlStringLiteral(source: string, start: number): number {
  return scanSparqlStringLiteral(source, start)?.end ?? start;
}

function isSparqlIriRefBodyCodePoint(codePoint: number): boolean {
  return codePoint > 0x20
    && codePoint !== 0x3c
    && codePoint !== 0x3e
    && codePoint !== 0x22
    && codePoint !== 0x7b
    && codePoint !== 0x7d
    && codePoint !== 0x7c
    && codePoint !== 0x5e
    && codePoint !== 0x60
    && codePoint !== 0x5c;
}

export interface SparqlIriRefScan {
  readonly end: number;
  /** IRIREF body after UCHAR decoding, without angle brackets. */
  readonly logicalValue: string;
}

function scanSparqlIriRefBody(
  source: string,
  start: number,
  encodedDelimiter: boolean,
): SparqlIriRefScan | null {
  let index = start;
  if (!encodedDelimiter) {
    // Ordinary IRIREFs dominate generated sync queries. Keep their hot path
    // allocation-free: constructing a SparqlLogicalCodePoint object for every
    // UTF-16 code unit made large VALUES/FROM catalogs spend more CPU scanning
    // the query than executing it. UCHAR escapes retain the exact slow-path
    // validation below, including the rule that their decoded value is allowed
    // to be a character forbidden in the raw IRI body.
    let decoded: string[] | null = null;
    let rawSegmentStart = start;
    while (index < source.length) {
      const first = source.charCodeAt(index);
      if (first === 0x3e) {
        return {
          end: index + 1,
          logicalValue: decoded === null
            ? source.slice(start, index)
            : [...decoded, source.slice(rawSegmentStart, index)].join(''),
        };
      }
      if (first === 0x5c) {
        const logical = readSparqlLogicalCodePoint(source, index);
        if (!logical || (source[index + 1] !== 'u' && source[index + 1] !== 'U')) return null;
        decoded ??= [];
        decoded.push(
          source.slice(rawSegmentStart, index),
          String.fromCodePoint(logical.codePoint),
        );
        index += logical.rawWidth;
        rawSegmentStart = index;
        continue;
      }
      const codePoint = source.codePointAt(index);
      if (codePoint === undefined
        || !isUnicodeScalarValue(codePoint)
        || !isSparqlIriRefBodyCodePoint(codePoint)) return null;
      index += codePoint > 0xffff ? 2 : 1;
    }
    return null;
  }

  const decoded: string[] = [];
  while (index < source.length) {
    const logical = readSparqlLogicalCodePoint(source, index);
    if (!logical) return null;
    if (logical.codePoint === 0x3e) {
      return { end: index + logical.rawWidth, logicalValue: decoded.join('') };
    }
    if (!isSparqlIriRefBodyCodePoint(logical.codePoint)) return null;
    decoded.push(String.fromCodePoint(logical.codePoint));
    index += logical.rawWidth;
  }
  return null;
}

/** Scan one IRIREF and return both its raw end and decoded body. */
export function scanSparqlIriRef(source: string, start: number): SparqlIriRefScan | null {
  const opening = readSparqlLogicalCodePoint(source, start);
  if (!opening || opening.codePoint !== 0x3c) return null;
  return scanSparqlIriRefBody(source, start + opening.rawWidth, opening.rawWidth > 1);
}

/** Recognize an IRIREF according to the SPARQL grammar's longest-match rule. */
export function skipSparqlIriRef(source: string, start: number): number | null {
  return scanSparqlIriRef(source, start)?.end ?? null;
}

/** Skip whitespace and `#` line comments between SPARQL tokens. */
export function skipSparqlSpaceAndLineComments(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    const logical = readSparqlLogicalCodePoint(source, index);
    if (!logical) break;
    const character = String.fromCodePoint(logical.codePoint);
    if (/\s/u.test(character)) {
      index += logical.rawWidth;
      continue;
    }
    if (logical.codePoint === 0x23) {
      index += logical.rawWidth;
      while (index < source.length) {
        const comment = readSparqlLogicalCodePoint(source, index);
        if (!comment) {
          index++;
          continue;
        }
        if (comment.codePoint === 0x0a || comment.codePoint === 0x0d) break;
        index += comment.rawWidth;
      }
      continue;
    }
    break;
  }
  return index;
}
