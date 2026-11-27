export type AgentConnectErrorStatus = 400 | 403 | 404 | 502 | 503 | 504;

export interface AgentConnectErrorResponse {
  status: AgentConnectErrorStatus;
  body: Record<string, unknown>;
}

const STATUS_BY_CODE = {
  INVALID_PEER_ID: 400,
  SELF_DIAL: 400,
  NETWORK_ADMISSION_REJECTED: 403,
  PEER_NOT_FOUND: 404,
  DIAL_FAILED: 502,
  DHT_UNAVAILABLE: 503,
  PEER_ROUTING_UNAVAILABLE: 503,
  NETWORK_ADMISSION_PROBE_FAILED: 503,
  DHT_TIMEOUT: 504,
  CONNECT_TIMEOUT: 504,
} as const satisfies Readonly<Record<string, AgentConnectErrorStatus>>;

/**
 * Preserve the `/api/connect` error contract in one route-local policy.
 *
 * Agent error codes are a structural boundary rather than an `instanceof`
 * contract: callers and tests may attach them to ordinary Error objects.
 * Unknown or missing codes intentionally retain the route's legacy 400.
 */
export function classifyAgentConnectError(error: unknown): AgentConnectErrorResponse {
  const candidate = error as { code?: unknown; message?: unknown } | null | undefined;
  const code = candidate?.code;
  const status = typeof code === 'string' && Object.hasOwn(STATUS_BY_CODE, code)
    ? STATUS_BY_CODE[code as keyof typeof STATUS_BY_CODE]
    : 400;

  return {
    status,
    body: {
      error: candidate?.message ?? 'Failed to connect',
      ...(code ? { code } : {}),
    },
  };
}
