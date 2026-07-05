import type { AuthenticatedDashboardSession } from "./dashboard-session-store.js";

export function dashboardSessionResponse(
  session: Pick<AuthenticatedDashboardSession, "csrfToken" | "source" | "expiresAt">,
) {
  return {
    authenticated: true,
    source: session.source,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
  };
}
