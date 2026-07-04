import type { IncomingMessage, ServerResponse } from "node:http";
import { DASHBOARD_SESSION_TTL_MS } from "./dashboard-session-store.js";

export const DASHBOARD_SESSION_COOKIE = "dkg_ui_session";
const MAX_COOKIE_AGE_SECONDS = Math.floor(DASHBOARD_SESSION_TTL_MS / 1000);

export function getDashboardSessionCookie(req: IncomingMessage): string | null {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key !== DASHBOARD_SESSION_COOKIE) continue;
    const value = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

export function setDashboardSessionCookie(req: IncomingMessage, res: ServerResponse, sessionId: string): void {
  const attrs = [
    `${DASHBOARD_SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${MAX_COOKIE_AGE_SECONDS}`,
  ];
  if (isHttpsRequest(req)) attrs.push("Secure");
  appendSetCookie(res, attrs.join("; "));
}

export function clearDashboardSessionCookie(req: IncomingMessage, res: ServerResponse): void {
  const attrs = [
    `${DASHBOARD_SESSION_COOKIE}=`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=0",
  ];
  if (isHttpsRequest(req)) attrs.push("Secure");
  appendSetCookie(res, attrs.join("; "));
}

function appendSetCookie(res: ServerResponse, value: string): void {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", value);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing.map(String), value]);
  } else {
    res.setHeader("Set-Cookie", [String(existing), value]);
  }
}

function isHttpsRequest(req: IncomingMessage): boolean {
  if (Boolean((req.socket as unknown as { encrypted?: boolean }).encrypted)) return true;
  if (!isTrustedForwardedHeaderSource(req)) return false;

  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return firstForwardedValue(proto) === "https" ||
    forwardedHeaderHasHttpsProto(req.headers.forwarded);
}

function isTrustedForwardedHeaderSource(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? "";
  return addr === "::1" ||
    addr === "127.0.0.1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.startsWith("127.");
}

function firstForwardedValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw?.split(",")[0]?.trim()?.toLowerCase();
}

function forwardedHeaderHasHttpsProto(value: string | string[] | undefined): boolean {
  const headers = Array.isArray(value) ? value : value ? [value] : [];
  for (const header of headers) {
    for (const element of header.split(",")) {
      for (const param of element.split(";")) {
        const [rawKey, ...rawValueParts] = param.split("=");
        if (rawKey.trim().toLowerCase() !== "proto") continue;
        const rawValue = rawValueParts.join("=").trim();
        const unquoted = rawValue.replace(/^"|"$/g, "").toLowerCase();
        if (unquoted === "https") return true;
      }
    }
  }
  return false;
}
