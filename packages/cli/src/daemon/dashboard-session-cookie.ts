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
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  return proto === "https" || Boolean((req.socket as unknown as { encrypted?: boolean }).encrypted);
}
