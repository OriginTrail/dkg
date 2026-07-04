import type { IncomingMessage } from "node:http";

const PROXY_FORWARDING_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "x-client-ip",
  "cf-connecting-ip",
  "true-client-ip",
] as const;

export function isLoopbackRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? "";
  if (!isLoopbackAddress(remote)) return false;
  if (hasProxyForwardingHeaders(req)) return false;
  return isAllowedLoopbackHost(req.headers.host) && hasLocalBrowserAddressing(req);
}

export function isLoopbackAddress(addr: string): boolean {
  return addr === "::1" ||
    addr === "127.0.0.1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.");
}

export function isUnsafeHttpMethod(method: string | undefined): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

export function hasTrustedDashboardOrigin(req: IncomingMessage, corsOrigin?: string | null): boolean {
  const allowedCorsOrigin = parseOrigin(corsOrigin ?? undefined);
  const fetchSite = firstHeaderValue(req.headers["sec-fetch-site"])?.toLowerCase();
  const originHeader = firstHeaderValue(req.headers.origin);
  if (fetchSite === "cross-site" && (!originHeader || parseOrigin(originHeader) !== allowedCorsOrigin)) {
    return false;
  }

  const allowed = trustedDashboardOrigins(req, corsOrigin);
  if (originHeader && !isTrustedDashboardHeaderOrigin(req, originHeader, allowed)) return false;

  const refererHeader = firstHeaderValue(req.headers.referer);
  if (refererHeader && !isTrustedDashboardHeaderOrigin(req, refererHeader, allowed)) return false;

  return true;
}

export function isConfiguredDashboardCorsOrigin(req: IncomingMessage, corsOrigin?: string | null): boolean {
  const allowedCorsOrigin = parseOrigin(corsOrigin ?? undefined);
  const originHeader = firstHeaderValue(req.headers.origin);
  if (!allowedCorsOrigin || parseOrigin(originHeader) !== allowedCorsOrigin) return false;
  return parseOrigin(originHeader) !== requestOrigin(req);
}

export function hasTrustedForwardedProto(req: IncomingMessage, proto: "http" | "https"): boolean {
  return isLoopbackAddress(req.socket.remoteAddress ?? "") && requestForwardedProto(req) === proto;
}

function requestForwardedProto(req: IncomingMessage): "http" | "https" | undefined {
  const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"])
    ?.split(",")[0]
    ?.trim()
    ?.toLowerCase();
  if (forwardedProto === "http" || forwardedProto === "https") return forwardedProto;
  return forwardedHeaderProto(req.headers.forwarded);
}

function isAllowedLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const rawHost = hostHeader.trim().toLowerCase();
  const host = rawHost.startsWith("[")
    ? rawHost.slice(1, rawHost.indexOf("]"))
    : rawHost.split(":")[0];
  return isAllowedLoopbackHostname(host);
}

function hasProxyForwardingHeaders(req: IncomingMessage): boolean {
  return PROXY_FORWARDING_HEADERS.some((header) => headerHasValue(req.headers[header]));
}

function headerHasValue(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) return value.some((item) => item.trim().length > 0);
  return typeof value === "string" && value.trim().length > 0;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function forwardedHeaderProto(value: string | string[] | undefined): "http" | "https" | undefined {
  const headers = Array.isArray(value) ? value : value ? [value] : [];
  for (const header of headers) {
    for (const element of header.split(",")) {
      for (const param of element.split(";")) {
        const [rawKey, ...rawValueParts] = param.split("=");
        if (rawKey.trim().toLowerCase() !== "proto") continue;
        const rawValue = rawValueParts.join("=").trim();
        const unquoted = rawValue.replace(/^"|"$/g, "").toLowerCase();
        if (unquoted === "http" || unquoted === "https") return unquoted;
      }
    }
  }
  return undefined;
}

function parseOrigin(value: string | undefined): string | undefined {
  if (!value || value === "*") return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function requestOrigin(req: IncomingMessage): string | undefined {
  const host = firstHeaderValue(req.headers.host);
  if (!host) return undefined;
  const proto = hasTrustedForwardedProto(req, "https") ? "https" : "http";
  return parseOrigin(`${proto}://${host}`);
}

function trustedDashboardOrigins(req: IncomingMessage, corsOrigin?: string | null): Set<string> {
  const origins = new Set<string>();
  const ownOrigin = requestOrigin(req);
  if (ownOrigin) origins.add(ownOrigin);
  const allowedCorsOrigin = parseOrigin(corsOrigin ?? undefined);
  if (allowedCorsOrigin) origins.add(allowedCorsOrigin);
  return origins;
}

function isTrustedDashboardHeaderOrigin(req: IncomingMessage, raw: string, allowed: Set<string>): boolean {
  const origin = parseOrigin(raw);
  if (!origin) return false;
  if (allowed.has(origin)) return true;
  return isLoopbackDashboardRequest(req) && isLocalOrigin(raw);
}

function isLoopbackDashboardRequest(req: IncomingMessage): boolean {
  return isLoopbackAddress(req.socket.remoteAddress ?? "") && isAllowedLoopbackHost(req.headers.host);
}

function hasLocalBrowserAddressing(req: IncomingMessage): boolean {
  return isLocalOrigin(firstHeaderValue(req.headers.origin)) ||
    isLocalOrigin(firstHeaderValue(req.headers.referer));
}

function isLocalOrigin(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      isAllowedLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function isAllowedLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
