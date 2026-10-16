/**
 * Validate the RFC 3987 `IRI` production without normalizing its bytes.
 *
 * This deliberately validates only syntax. It does not apply scheme-specific
 * equivalence, case folding, Unicode normalization, percent normalization, or
 * network resolution.
 *
 * It is the IRI rule of the V1 CG shared-projection verifier, of
 * `parseWritableRdfTerm` and of the storage adapters' SPARQL term policy, so a
 * different policy needs a new function, not an edit here.
 */
export function isAbsoluteRfc3987IriV1(value: string): boolean {
  const schemeEnd = value.indexOf(':');
  if (schemeEnd <= 0 || !isSchemeRange(value, 0, schemeEnd)) return false;

  const hierarchyStart = schemeEnd + 1;
  const fragmentAt = value.indexOf('#', hierarchyStart);
  const beforeFragmentEnd = fragmentAt < 0 ? value.length : fragmentAt;
  if (
    fragmentAt >= 0
    && !scanICharsRange(value, fragmentAt + 1, value.length, '/?')
  ) return false;

  const queryAt = value.indexOf('?', hierarchyStart);
  const hasQuery = queryAt >= 0 && queryAt < beforeFragmentEnd;
  if (
    hasQuery
    && !scanICharsRange(value, queryAt + 1, beforeFragmentEnd, '/?', true)
  ) return false;

  return isIHierPartRange(
    value,
    hierarchyStart,
    hasQuery ? queryAt : beforeFragmentEnd,
  );
}

function isSchemeRange(value: string, start: number, end: number): boolean {
  if (start === end || !isAsciiAlpha(value.charCodeAt(start))) return false;
  for (let index = start + 1; index < end; index += 1) {
    const code = value.charCodeAt(index);
    if (
      !isAsciiAlpha(code)
      && !isAsciiDigit(code)
      && code !== 0x2b
      && code !== 0x2d
      && code !== 0x2e
    ) return false;
  }
  return true;
}

function isIHierPartRange(value: string, start: number, end: number): boolean {
  if (value.startsWith('//', start)) {
    const slashAt = value.indexOf('/', start + 2);
    const authorityEnd = slashAt < 0 || slashAt >= end ? end : slashAt;
    return isIAuthority(value.slice(start + 2, authorityEnd))
      && scanICharsRange(value, authorityEnd, end, '/');
  }
  if (start === end) return true;
  if (value[start] === '/') {
    // `//` is consumed by the authority branch. An authority-free absolute
    // path cannot start with an empty first segment.
    return end - start === 1
      || (value[start + 1] !== '/' && scanICharsRange(value, start, end, '/'));
  }
  return scanICharsRange(value, start, end, '/');
}

function isIAuthority(value: string): boolean {
  const at = value.lastIndexOf('@');
  if (at >= 0) {
    if (
      value.indexOf('@') !== at
      || !scanICharsRange(value, 0, at, '', false, true, false)
    ) {
      return false;
    }
  }
  const hostAndPort = value.slice(at + 1);
  if (hostAndPort.startsWith('[')) {
    const close = hostAndPort.indexOf(']');
    if (close < 0) return false;
    const literal = hostAndPort.slice(1, close);
    const suffix = hostAndPort.slice(close + 1);
    if (suffix.length > 0 && (suffix[0] !== ':' || !isPort(suffix.slice(1)))) {
      return false;
    }
    return isIpv6Address(literal) || isIpvFuture(literal);
  }

  const colon = hostAndPort.lastIndexOf(':');
  const host = colon < 0 ? hostAndPort : hostAndPort.slice(0, colon);
  const port = colon < 0 ? undefined : hostAndPort.slice(colon + 1);
  if (host.includes(':') || host.includes('[') || host.includes(']')) return false;
  return scanICharsRange(host, 0, host.length, '', false, false, false)
    && (port === undefined || isPort(port));
}

function isPort(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!isAsciiDigit(value.charCodeAt(index))) return false;
  }
  return true;
}

function isIpvFuture(value: string): boolean {
  if (value.length < 4 || (value[0] !== 'v' && value[0] !== 'V')) return false;
  const dot = value.indexOf('.', 1);
  if (dot <= 1 || dot === value.length - 1) return false;
  for (let index = 1; index < dot; index += 1) {
    if (!isAsciiHex(value.charCodeAt(index))) return false;
  }
  for (let index = dot + 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!isAsciiUnreserved(code) && !isSubDelimiter(code) && code !== 0x3a) {
      return false;
    }
  }
  return true;
}

function isIpv6Address(value: string): boolean {
  if (value.length === 0 || value.includes('%')) return false;
  const compression = value.indexOf('::');
  if (compression !== value.lastIndexOf('::')) return false;

  const leftText = compression < 0 ? value : value.slice(0, compression);
  const rightText = compression < 0 ? '' : value.slice(compression + 2);
  const left = leftText.length === 0 ? [] : leftText.split(':');
  const right = rightText.length === 0 ? [] : rightText.split(':');
  if (left.some((part) => part.length === 0) || right.some((part) => part.length === 0)) {
    return false;
  }

  const all = [...left, ...right];
  const dotted = all.findIndex((part) => part.includes('.'));
  if (
    dotted >= 0
    && (
      dotted !== all.length - 1
      // An embedded IPv4 address is the final `ls32`; `::` cannot follow it.
      || (compression >= 0 && right.length === 0)
    )
  ) return false;
  let units = 0;
  for (let index = 0; index < all.length; index += 1) {
    const part = all[index];
    if (part.includes('.')) {
      if (!isIpv4Address(part)) return false;
      units += 2;
      continue;
    }
    if (part.length < 1 || part.length > 4) return false;
    for (let digit = 0; digit < part.length; digit += 1) {
      if (!isAsciiHex(part.charCodeAt(digit))) return false;
    }
    units += 1;
  }
  return compression < 0 ? units === 8 : units < 8;
}

function isIpv4Address(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (part.length === 0 || part.length > 3) return false;
    if (part.length > 1 && part[0] === '0') return false;
    for (let index = 0; index < part.length; index += 1) {
      if (!isAsciiDigit(part.charCodeAt(index))) return false;
    }
    return Number(part) <= 255;
  });
}

function scanICharsRange(
  value: string,
  start: number,
  end: number,
  asciiExtra: string,
  allowPrivate = false,
  allowColon = true,
  allowAt = true,
): boolean {
  for (let index = start; index < end; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x25) {
      if (
        index + 2 >= end
        || !isAsciiHex(value.charCodeAt(index + 1))
        || !isAsciiHex(value.charCodeAt(index + 2))
      ) return false;
      index += 2;
      continue;
    }
    if (code <= 0x7f) {
      if (
        isAsciiUnreserved(code)
        || isSubDelimiter(code)
        || (allowColon && code === 0x3a)
        || (allowAt && code === 0x40)
        || includesAsciiCode(asciiExtra, code)
      ) continue;
      return false;
    }
    const codePoint = value.codePointAt(index)!;
    if (
      isUcsChar(codePoint)
      || (allowPrivate && isIPrivate(codePoint))
    ) {
      if (codePoint > 0xffff) index += 1;
      continue;
    }
    return false;
  }
  return true;
}

function includesAsciiCode(characters: string, code: number): boolean {
  for (let index = 0; index < characters.length; index += 1) {
    if (characters.charCodeAt(index) === code) return true;
  }
  return false;
}

function isAsciiUnreserved(code: number): boolean {
  return isAsciiAlpha(code)
    || isAsciiDigit(code)
    || code === 0x2d
    || code === 0x2e
    || code === 0x5f
    || code === 0x7e;
}

function isSubDelimiter(code: number): boolean {
  return code === 0x21
    || code === 0x24
    || code === 0x26
    || code === 0x27
    || code === 0x28
    || code === 0x29
    || code === 0x2a
    || code === 0x2b
    || code === 0x2c
    || code === 0x3b
    || code === 0x3d;
}

function isUcsChar(code: number): boolean {
  return (code >= 0x00a0 && code <= 0xd7ff)
    || (code >= 0xf900 && code <= 0xfdcf)
    || (code >= 0xfdf0 && code <= 0xffef)
    || (code >= 0x10000 && code <= 0x1fffd)
    || (code >= 0x20000 && code <= 0x2fffd)
    || (code >= 0x30000 && code <= 0x3fffd)
    || (code >= 0x40000 && code <= 0x4fffd)
    || (code >= 0x50000 && code <= 0x5fffd)
    || (code >= 0x60000 && code <= 0x6fffd)
    || (code >= 0x70000 && code <= 0x7fffd)
    || (code >= 0x80000 && code <= 0x8fffd)
    || (code >= 0x90000 && code <= 0x9fffd)
    || (code >= 0xa0000 && code <= 0xafffd)
    || (code >= 0xb0000 && code <= 0xbfffd)
    || (code >= 0xc0000 && code <= 0xcfffd)
    || (code >= 0xd0000 && code <= 0xdfffd)
    || (code >= 0xe1000 && code <= 0xefffd);
}

function isIPrivate(code: number): boolean {
  return (code >= 0xe000 && code <= 0xf8ff)
    || (code >= 0xf0000 && code <= 0xffffd)
    || (code >= 0x100000 && code <= 0x10fffd);
}

function isAsciiAlpha(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isAsciiHex(code: number): boolean {
  return isAsciiDigit(code)
    || (code >= 0x41 && code <= 0x46)
    || (code >= 0x61 && code <= 0x66);
}
