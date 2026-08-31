/**
 * Conservative public-address classification shared by node reachability,
 * profile publication, and peer resolution. Circuit addresses are classified
 * separately by callers because they are not direct reachability evidence.
 */
export function isLocalOrInternalHostname(host: string): boolean {
  if (typeof host !== 'string' || host.length === 0) return true;
  const h = host.toLowerCase();
  if (h === 'localhost') return true;
  if (h.endsWith('.local') || h.endsWith('.localhost')) return true;
  if (h.endsWith('.test') || h.endsWith('.example')) return true;
  if (h.endsWith('.invalid') || h.endsWith('.localdomain')) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return true;
  if (/^\[?[0-9a-f:]+\]?$/.test(h) && h.includes(':')) return true;
  if (!h.includes('.')) return true;
  return false;
}

export function isPublicLikeAddress(addr: string): boolean {
  const dnsMatch = addr.match(/^\/(?:dns|dns4|dns6|dnsaddr)\/([^/]+)\//);
  if (dnsMatch) return !isLocalOrInternalHostname(dnsMatch[1]);
  const ipv4 = addr.match(/^\/ip4\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\//);
  if (ipv4) {
    const octets = ipv4[1].split('.').map(Number);
    if (octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
    if (octets[0] === 0 || octets[0] === 127) return false;
    if (octets[0] === 10) return false;
    if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return false;
    if (octets[0] === 192 && octets[1] === 168) return false;
    if (octets[0] === 169 && octets[1] === 254) return false;
    if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return false;
    if (octets[0] >= 224) return false;
    return true;
  }
  const ipv6 = addr.match(/^\/ip6\/([^/]+)\//);
  if (ipv6) {
    const ip = ipv6[1].toLowerCase();
    if (ip === '::' || ip === '::1') return false;
    const firstSegment = ip.split(':', 1)[0];
    if (!/^[0-9a-f]{1,4}$/.test(firstSegment)) return false;
    const firstHextet = Number.parseInt(firstSegment, 16);
    // RFC 4291 link-local unicast is fe80::/10, i.e. first hextet
    // fe80 through febf (not only the literal fe80 prefix).
    if ((firstHextet & 0xffc0) === 0xfe80) return false;
    if (/^f[cd]/.test(ip)) return false;
    if (ip.startsWith('ff')) return false;
    return true;
  }
  return false;
}
